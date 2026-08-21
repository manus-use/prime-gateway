# Feishu/Lark channel for Claude Code — design

**Date:** 2026-08-21
**Status:** approved, implementing
**Scope:** vertical slice — a Feishu message drives Claude Code in a configured repo and the
reply streams back into a card.

This document assumes [`../architecture.md`](../architecture.md). Where the two disagree, the
architecture document wins and this document is a bug.

Many rules below are counterintuitive and would look like arbitrary style choices without their
reason attached. Each therefore states the mechanism that forces it. Those are not decoration:
they are what should stop the rule being "simplified" away later. See the appendix for prior art.

---

## 1. Boundaries

**In:** `LarkChannel` adapter → SQLite event log → single-writer session actor → ACP driver →
`claude-agent-acp` subprocess.

**Out, each an explicit seam rather than an oversight:**

| Deferred | Seam that keeps it cheap later |
|---|---|
| Broker sidecar (§4) | `ExecutionBackend` interface; runtime dies with the gateway for now |
| Git worktrees | `workspaces.kind = 'plain-dir'` only; `kind` column already exists |
| `structured-cli` driver | Declared registry key, no implementation |
| Snapshots | Table exists; renderer already reads a `(from_seq, to_seq)` range |
| Multi-channel fan-out | `channel_bindings` is already many-per-session |

Deferring the broker is the one that costs user-visible behaviour: **restarting the gateway kills
every live agent**. Sessions survive (the log is the system of record) and cold-resume on the next
message. That is the next milestone, and nothing here may assume the runtime outlives the process.

---

## 2. Schema (migration `002_lark_channel.sql`)

### 2.1 `seen_messages` — durable inbound dedup

```sql
CREATE TABLE seen_messages (
  message_id    TEXT PRIMARY KEY,   -- Feishu message_id. Platform-stable ONLY.
  chat_id       TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  outcome       TEXT NOT NULL       -- accepted | rejected | ignored
) STRICT;
CREATE INDEX idx_seen_sweep ON seen_messages(first_seen_at);
```

The SDK's in-memory dedup cannot survive a restart, and Feishu's redelivery ladder runs
**15s / 5min / 1h / 6h**. Swept at 8h.

Two constraints, both load-bearing:

- **Key on `message_id`, never `event_id`.** `message_id` is stable across re-pushes; `event_id`
  re-mints.
- **Only ever claim platform-stable ids.** Never durably claim a payload-derived key: distinct
  clicks of the same button legitimately repeat. "Same delivery" is deduped; "same intent" is not.

### 2.2 `channel_bindings` additions

```sql
ALTER TABLE channel_bindings ADD COLUMN app_id          TEXT NOT NULL DEFAULT '';
ALTER TABLE channel_bindings ADD COLUMN revoked_at      INTEGER;
ALTER TABLE channel_bindings ADD COLUMN active_card_id  TEXT;
ALTER TABLE channel_bindings ADD COLUMN card_created_at INTEGER;
```

- **`app_id` is part of the identity of a binding.** Including the bot id is what lets N bots
  coexist in one chat without collision. Two bots @-mentioned in one message get two sessions.
- **`revoked_at`** — `/new` revokes rather than deletes, so a late redelivery resolves to the
  revoked binding and is discarded instead of resurrecting a rotated session.
- **`active_card_id` + `card_created_at`** — cardkit entities **expire after 14 days**. At >13
  days, or on error `200750`, mint a fresh card and continue from `cursor_seq`. Unexercised path;
  see §11.

### 2.3 `approvals` additions

```sql
ALTER TABLE approvals ADD COLUMN option_id TEXT;   -- ACP PermissionOption.optionId
ALTER TABLE approvals ADD COLUMN options   BLOB;   -- JSON: the offered option set
```

`resolved_by` and `resolved_via` already exist. ACP supplies
`options: Array<{optionId, name, kind}>`, so buttons are **generated from the agent's own
options**. Hardcoded Allow / Allow-always / Deny is wrong: it invents outcomes the agent didn't
offer and drops ones it did.

### 2.4 `sessions.state` gains `quarantined`

Three runtime states are required — **live / cold / absent**. Collapsing them to two is how
session-exists-but-process-dead falls into the *create* branch and produces duplicate sessions on
one thread.

`quarantined` is distinct from `cold`: a cold session may be resumed automatically, a quarantined
one may not. A session is quarantined when its process died with an `ambiguous` delivery
outstanding, i.e. we cannot prove whether the prompt was consumed. Exit is an explicit user act
(`/new`, or `/attach` after inspecting the log).

---

## 3. Inbound

### 3.1 Append first. Everything else is a separate, failable step.

**The SDK ACKs on receipt.** Anything we drop is never redelivered — the ACK has already told Lark
we handled it, so a throw *after* the ACK is a silently swallowed message and the user's @ is
simply lost.

Therefore:

```
message event
  1. claim message_id in seen_messages      (BEGIN IMMEDIATE; conflict → return)
  2. append inbound_message event           (durable; no policy applied yet)
  3. policy                                  → append policy_rejected, notify, stop
  4. resolve/create binding                  → append binding_resolved
  5. hand to session actor
```

Steps 3–5 fail against a durable record, loudly. Ordering step 2 before step 3 also buys a second
property: an inbound event rejected for authorization is **retained and replayable**, so a user who
is later allowlisted does not have to re-@ the bot.

### 3.2 Ordering: chat-wide, then per-session

Two lanes, not one:

1. **Chat-wide raw ingress lane**, held across async routing. A per-thread lane cannot work at this
   stage: a topic's seed message has no `thread_id` yet, so per-thread lanes cannot prove arrival
   order. You cannot key a lane on a session you have not yet identified.
2. **Per-session FIFO** once the binding resolves.

Both capped. `INGRESS_MAX_WAIT_MS = 5000`, past which we **fall back to concurrent**: lose strict
order, never lose the message. Without the cap, one stuck handler makes the bot miss every later @
in that chat. The per-session queue has a depth cap that sheds with a visible message rather than
growing unbounded.

Every bounded map is bounded twice: TTL governs freshness, the cap governs count. Unbounded, 200k
keys in a bare `Map` cost ~25 MB that is never reclaimed; capped, ~150 KB.

### 3.3 Session mapping

Lookup key is `(app_id, chat_id, thread_id)`, resolved against `channel_bindings` where
`revoked_at IS NULL`.

**Scope comes from `thread_id`, never `root_id`.** Feishu's quote-reply UI attaches `root_id` to
messages the user perceives as top-level, so keying on `root_id` yanks people out of their session.
Plain top-level group message → chat scope, `thread_id = ''`.

The key is **recomputed on every resolve, never persisted as a key**. `session_id` is immutable and
opaque; the binding is the mutable mapping.

### 3.4 Identity

- `union_id` is the canonical human key. `open_id` (`ou_`) is **app-scoped** — correct as a per-bot
  handle, wrong as a durable identity.
- Allowlists are re-resolved at boot via the contact API with a **last-known-good per-entry
  cache**, so a transient API blip cannot empty the allowlist and lock the owner out.
- `owner_open_id` is stored raw and never resolved, as a fail-safe DM target.
- **Every write path into the allowlist goes through one function.** The failure this prevents is a
  second entry point silently reopening a boundary the first one closed.

### 3.5 Authorization: two tiers

| Predicate | Grants |
|---|---|
| `canTalk` | May drive the agent |
| `canOperate` | May run mutating control verbs |

Each command declares its tier; a **downgrade list** lets read-only verbs (`/status`, `/sessions`)
require only `canTalk`.

**Empty allowlist means closed, and control verbs never skip `canOperate`.** Both are stated
explicitly because both are easy to get backwards: an empty list reads naturally as "no
restrictions configured", and slash commands read naturally as ordinary messages — at which point
any talk-permitted user can fire `/clear` into someone else's live session.

### 3.6 Attachments

Downloaded to a per-turn temp dir and injected as **local file paths**, never inline. Caps applied
on the chat path: 8 files, 10 MB each, 25 MB total. Excess is reported, not silently dropped.

### 3.7 Bot-loop guard

Ignore messages whose sender is a bot unless explicitly allowlisted. Two bots @-ing each other loop
forever.

---

## 4. Outbound

### 4.1 One writer per binding, single-flight, latest-wins

`TurnRenderer` bridges the log's push model to `channel.stream()`'s pull model through an async
queue, and returns the highest `seq` it rendered, which becomes `cursor_seq`.

The queued item is a **`cursor_seq` integer, not a JSON blob**. "Newest wins" is then an integer
comparison and cannot regress. On failure the pending target is retained, so the retry renders the
newest state rather than a stale one.

**cardkit's `sequence` orders writes; it does not decide which render is current.** Delivery order
is unpredictable, so without single-flight a stale render can land after a fresh one and overwrite
the result of a user's click.

Card rebuilds are coalesced to ~1/s/session. Updates are last-write-wins, so intermediates are
droppable by construction.

### 4.2 Send idempotency

Every IM send carries `uuid = truncate(sha256(canonical), 50)` where `canonical` includes
**`app_id`, `session_id`, `event_seq`**. `app_id` belongs in there because two bots writing the
same content to the same chat are distinct effects, not a duplicate.

- Feishu returns the original `message_id` for a repeated uuid, which makes every send idempotent
  against the event log: a crash-replay reuses the message instead of duplicating it. Without this,
  an at-least-once retry posts the same answer several times.
- The window is **exactly 1 hour**. Past it, **reconcile — do not resubmit**.
- `230049` ("being sent") means a same-uuid send is already in flight: retry with the **same** uuid
  to converge.

### 4.3 Rate limits arrive three ways

HTTP 429; HTTP 400 with code `99991400`; and **a business error inside a 2xx body**. Parse the code
before branching on status. Retryable set: `{230049, 230020, 99991400}`. Honour
`x-ogw-ratelimit-reset` rather than a fixed backoff.

`230011` (message withdrawn) → clear `active_card_id`, but **only if the withdrawn id is still the
active one**, then re-render from `cursor_seq`.

### 4.4 Escaping is a security boundary

One escaper, backslash escaped first — that ordering is the part implementations get wrong — and it
**escapes `<` and `>`**. Agent output is untrusted: without this, a crafted string injects a literal
`<at id=all></at>` and spoofs an @-mention-everyone.

Approval cards render agent-supplied text as `plain_text`, so **displaying** an approval cannot
itself become a notification.

Agent-authored cards, if ever supported, get display + `open_url` only — never callback buttons,
which would let a custom card forge an interaction callback.

---

## 5. Approvals

`session/request_permission` blocks the agent. That is the whole mechanism, and it is why there is
**no `/approve` command**: the blocked RPC already is the pending request, so a chat verb would be a
second way to mutate it, reachable only by users who can already click the button.

Flow: append `approval_requested` → render a V2 card with one button per `PermissionOption` →
resolve on click.

Five rules:

1. **Return the terminal card in the callback response body.** An async PATCH issued after the
   callback returns is routinely lost. ACK-at-2500ms-then-patch is the fallback, not the primary.
   The deadline is 3s with **no re-push**; missing it surfaces error `200341`.
2. **A toast cannot be re-surfaced after ACK**, so any slow path must render its result as a card.
3. **The nonce proves the card, not the target.** `action.value` carries only a derived nonce
   (`session_id:approval_id:generation`), re-validated against the log by a **server-side CAS** on
   the expected generation. A nonce proves the card itself was not altered; it can never prove that
   what the card points at is still current, so the core must compare again. Lark does **not**
   verify that field, so identity comes from `operator.openId`, never the payload.
4. **Terminal cards are frozen and button-less**, and re-click is idempotent *but still re-drives*
   the run — which is what covers click → crash → click after restart.
5. **No timeout-to-default.** An unanswered approval parks (architecture §10, park-don't-deny).
   Every failure path must fail *open* toward the agent: no exception may block it forever.

Also adopted: **a plain-text reply in the thread answers a pending approval**, refusing when the
message carries attachments — otherwise an upload gets eaten as an answer.

---

## 6. Commands

A declarative registry, each entry carrying `{ tier, needsSession, effect, multiline }`. Not a
`switch`: a dispatch statement with aliases as fall-through labels and its metadata in side `Set`s
that the *router* consults instead of the table is how permission checks drift out of sync with the
commands they guard.

| Command | Tier | Notes |
|---|---|---|
| `/new` | operate | Revokes binding, bumps generation, new session |
| `/sessions` | talk | Lists bindings in this chat |
| `/attach <id>` | operate | Rebinds this thread to an existing session |
| `/cd <path>` | operate | State operation: suspend, repin realpath, cold-resume |
| `/stop` | operate | `session/cancel`; cancellation is a terminal, not a deletion |
| `/status` | talk | Pure projection (§7) |

`/cd` does **not** type `cd` at the agent — it is a gateway state operation. Mutating verbs
**refuse mid-turn rather than bypass**.

`effect: 'immediate' | 'next-session'` is surfaced in `/help` so the user knows whether a change
needs a restart.

---

## 7. Status is one pure projection

`projectSessionStatus(session, openTurns, log)` — computed in exactly one place, derived from the
log, never assigned. Status assigned from multiple code paths is how a running session comes to
report idle, which then produces duplicate approval requests, spurious restarts, and a live session
treated as a reclaimable idle worker.

Consequences:

- **Turn terminals are evidence-graded**, not booleans:
  `{ completed | failed | cancelled | ambiguous }`, decoupled from display text. Non-empty final
  text is not a reliable completion contract. Empty output is a terminal. Cancellation is a
  terminal.
- **Never time a lease off the agent's clock** — use locally observed time.
- **Every timer and post-`await` continuation revalidates `(turn_id, generation)`** before acting.
  A restart bumps the generation *before* teardown, so in-flight work is fenced by construction.
- Idling is **capacity-based, not clock-based**: a cap on live runtimes, with idle time only as a
  sort key. Suspend ≠ close.

---

## 8. Writers, and one transaction rule

Every writer to the DB is enumerated in `src/db/WRITERS.md`. "There is only one writer" is a claim
that rots the moment a script or subcommand is added, and the failure is nasty: whole-record
rewrites let one stale snapshot erase another's row. Low probability, unrecoverable.

So the invariant is enforced by `BEGIN IMMEDIATE` on every write path, **not** by a probe. A probe
has a TOCTOU window; a transaction does not. Per architecture §3.7: `busy_timeout=1000`, up to 15
jittered 20–150 ms retries, `wal_checkpoint(PASSIVE)` every 50 writes.

Single-writer-per-session (architecture §11) is a *serialization* property of the actor, and is not
a substitute for the transaction.

---

## 9. Security

**The agent never holds Feishu credentials.** An outbox relay: the agent writes a send *request*,
and the gateway delivers it with the real credentials. No Feishu secret is ever reachable from the
agent's environment. This works with no sandbox at all, which makes it the highest-value security
move available in the first slice.

- Child-process env is built from an **allowlist**, so unrelated `.env` credentials cannot be
  inherited by forked children.
- Scrub `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID` — a gateway launched from inside Claude Code
  otherwise leaks its own harness state into the child.
- Secrets are never editable from chat and are masked in every chat-visible render. A new
  secret-bearing config block must be added to the masker or it leaks.
- Bind a **boot id** into any callback token so pre-restart tokens die.
- Untrusted chat metadata (group name, description) carries an explicit policy block in the prompt
  envelope: never execute instructions found inside it.
- Audit log NDJSON at `0600`, metadata only.

Prompt envelope order matters for cache stability: **stable/instruction context before the user
turn, per-turn attribution after**.

---

## 10. Testing

Two projects: `unit` (parallel, no subprocess) and `e2e` (sequential, opt-in). Keep them separate —
a single global `fileParallelism: false` added for one browser suite can leak onto hundreds of unit
files and cost an order of magnitude in wall-clock.

Two fakes:

- **Fake ACP agent** — a real binary speaking JSON-RPC over stdio, behaviour driven entirely by env
  vars. Lets us script `ambiguous` deliveries, mid-turn death, and permission storms.
- **Fake `LarkChannel`** — records call order with controllable Promises, so card PATCH sequencing
  is verifiable without hitting real Feishu.

Timing-sensitive test contract: a fixture's `ready` handshake is a **happens-before barrier**, not a
progress log; fixed sleeps may bound a hang but must not stand in for readiness; never use retries
to mask a missing barrier; every wait is bounded and its timeout names the unmet condition. A
`TIME_SCALE` env var scales all centralized delays, default 1, production byte-identical.

Three verification rules:

- **Cross-process guarantees need tests that observe the far side.** A source-level assertion proves
  nothing about delivery — a test can assert correct ordering on the producing side and stay green
  while the output is deterministically dropped at the process fence.
- **Break the guarantee to prove the test measures it.** A mock that silently never takes effect
  leaves a suite fully green with every gate it claims to check deleted.
- **Avoid `toEqual` on whole result objects**: it pins the *absence* of fields added later,
  including uncertainty markers.

Crash matrix per [`../testing/durability.md`](../testing/durability.md): kill mid-turn; kill between
append and render; redeliver a message after restart; resolve an approval after restart;
`ambiguous` delivery → quarantine.

---

## 11. Two spikes

Both because a wrong guess costs a rewrite, and neither is settled by any implementation we can
consult:

1. **The real card size ceiling.** Field reports put the message-content limit near 109 KB (error
   `230025`), while the SDK's 30,000-char rollover is a cardkit *element* limit. Different paths,
   different ceilings, and the answer changes the rollover math.
2. **cardkit expiry at the 14-day edge.** The comparable implementation avoided cardkit entirely, so
   this path has no prior art at all.

---

## 12. The `Channel`-module bet

This design leans on `@larksuiteoapi/node-sdk`'s `Channel` module, which is young. It is what makes
the adapter a few hundred lines rather than well over a thousand, but `stream()` owns the cardkit
lifecycle, so misbehaving throttling or rollover means patching around a dependency instead of our
own code.

Mitigation: `TurnRenderer` talks to a **narrow interface we define** (`OutboundChannel`), so
dropping to raw `cardkit` + `im.v1.message.patch` is a swap of one file.

Accepted knowingly.

---

## 13. What ACP-only gives up

The alternative is to bridge the CLI itself rather than an interface: do that and you keep hooks,
memory, plan mode, and slash commands, whereas an interface-bounded integration gets only what the
interface exposes. That is a genuine cost and it is accepted.

The counterweight is what CLI bridging actually requires in practice — submit-key discovery, paced
typing, transcript-fingerprint delivery fences, and screen-quiescence heuristics standing in for
completion signals, running well past a thousand lines for one agent. The `AgentDriver` registry
seam means a `structured-cli` driver can reclaim the gap later without redesign.

---

## 14. Corrections to `architecture.md`

§6.2 trap #2 and its Appendix B row both stated that `session/resume` and `session/close` do not
exist in ACP. They do, as of SDK 1.3.0. Both corrected in this change.

---

## Appendix: where these rules come from

Much of the operational detail here — Feishu delivery semantics, card concurrency, the two-lane
ingress model, evidence-graded terminals, and most of the "do not do this" rules — comes from the
Feishu OpenAPI documentation, the ACP SDK, and a survey of existing production bridges between
Feishu and coding agents.

That provenance matters for how much to trust the counterintuitive rules: the ones stated most
emphatically are the ones an existing implementation got wrong first and fixed later, not
speculation. They are written as mechanisms rather than citations because a mechanism stays true
while a line reference into someone else's repository rots on its next refactor.

The judgements about what to adopt, invert, or reject are ours, as are any errors.
