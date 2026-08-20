# prime-gateway — Architecture Design

**Version:** 0.1 (design draft)
**Primary constraint:** long-lived durable sessions
**Primary protocol:** ACP (Agent Client Protocol), structured CLI and PTY as fallbacks

---

## 0. The one-line thesis

> A gateway session is a **durable event log** with an optional, reattachable **agent runtime** bound to it. Everything else — channels, drivers, backends — is a projection or a resource.

Every design decision below follows from taking that literally.

---

## 1. Goals and non-goals

### Goals

| # | Goal |
|---|---|
| G1 | A session survives gateway restart, agent crash, machine reboot, and weeks of idleness |
| G2 | One session is observable and drivable from multiple channels simultaneously (Telegram + web) |
| G3 | Adding a new agent is a registry entry, not a code change, when the agent speaks ACP |
| G4 | Adding a new channel does not touch the agent layer |
| G5 | Every action an agent took is auditable and attributable after the fact |
| G6 | No turn is ever silently executed twice |
| G7 | Approvals survive restart and can be answered from a different channel than they were asked on |

### Non-goals (v1)

- Multi-node horizontal scaling. Single gateway node; design so migration is mechanical.
- Reimplementing agent loops. We drive vendor runtimes; we never model tools ourselves.
- A2A / remote agent federation. Leave a seam; do not build it.
- Sub-agent orchestration policy. Agents fan out internally; we record, we don't schedule.

### The forcing constraint

ACP agents run as **local subprocesses over stdio**. The session's liveness is therefore bound to whoever owns the pipe. If the gateway owns it, gateway restart kills every session — which violates G1 outright.

This single fact dictates the **broker sidecar** in §6. It is the most important structural decision in the design.

---

## 2. Layer model

```
                            CHANNELS
        Telegram      Web        Slack       REST       CLI
            │          │           │          │          │
            └──────────┴─────┬─────┴──────────┴──────────┘
                             │  ChannelAdapter
                             │  (auth · rate-limit · render · backpressure)
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                      SESSION EVENT LOG                       │
  │        SQLite WAL · per-session seq · append-only            │
  │        system of record for everything below                 │
  └───┬──────────┬───────────┬────────────┬──────────┬───────────┘
      │          │           │            │          │
   Router   PolicyEngine  Approvals   Registry   Projections
      │                                (caps)    (transcript,
      │                                           cost, state)
      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                          DRIVER                              │
  │   transport × protocol.  ACP (default) │ structured-cli │ pty │
  └──────────────────────────────┬───────────────────────────────┘
                                 │  broker control socket
                                 ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                      BROKER SIDECAR                          │
  │   detached · owns stdio · spools to disk · reattachable      │
  └──────────────────────────────┬───────────────────────────────┘
                                 ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    EXECUTION BACKEND                         │
  │        process │ tmux │ container │ remote(ssh)              │
  └──────────────────────────────┬───────────────────────────────┘
                                 ▼
                    Agent process + Workspace
              (claude-agent-acp │ gemini --acp │ codex-acp │ …)
```

### Three orthogonal axes

Do not collapse these. They vary independently and the registry declares each separately.

| Axis | Question | Values |
|---|---|---|
| **Driver** | How do I talk to it? | `acp`, `structured-cli`, `pty` |
| **Executable** | What binary/args start it? | `["gemini","--acp"]`, `["npx","-y","@agentclientprotocol/claude-agent-acp"]` |
| **Backend** | Where does the broker live? | `process`, `tmux`, `container`, `remote` |

Most combinations are legal. The illegal ones are declared as compatibility constraints, not hardcoded:

- `pty` driver requires a PTY-capable backend (`tmux`, `container` with tty, not bare `process`)
- `remote` backend requires the workspace be resolvable on the remote host

---

## 3. Core data model

SQLite, WAL mode, single file at `$PRIME_HOME/prime.db`.

### 3.1 The event log

```sql
CREATE TABLE events (
  session_id    TEXT    NOT NULL,
  seq           INTEGER NOT NULL,          -- monotonic per session, gateway-assigned
  ts            INTEGER NOT NULL,          -- unix millis
  generation    INTEGER NOT NULL,          -- runtime incarnation that produced this
  broker_seq    INTEGER,                   -- broker-assigned, NULL for gateway-origin events
  turn_id       TEXT,                      -- NULL for session-level events
  type          TEXT    NOT NULL,
  actor         TEXT    NOT NULL,          -- 'user' | 'agent' | 'gateway' | 'policy'
  payload       BLOB    NOT NULL,          -- JSON
  PRIMARY KEY (session_id, seq)
) STRICT;

-- idempotent ingest of broker spool: same (gen, broker_seq) never lands twice
CREATE UNIQUE INDEX idx_events_broker_dedup
  ON events(session_id, generation, broker_seq)
  WHERE broker_seq IS NOT NULL;

CREATE INDEX idx_events_turn ON events(session_id, turn_id, seq);
CREATE INDEX idx_events_type ON events(session_id, type, seq);
```

**Rules:**

- `seq` is allocated inside the same transaction as the insert. Single-writer-per-session (§11) makes this trivially correct.
- Nothing is ever updated or deleted. State changes are new events.
- High-volume raw agent stdout does **not** live here. It goes to the broker spool and is referenced by `(spool_file, offset, length)`.
- `payload` is the *raw* driver event, normalized but not lossy. Vendor `_meta` is preserved verbatim.

### 3.2 Event taxonomy

```
session.created            { agent_id, workspace_id, created_by }
session.state_changed      { from, to, reason }
session.title_set          { title }

runtime.start_requested    { generation, handle, spec }      ← phase 1 of two-phase start
runtime.started            { generation, handle, pid, backend }
runtime.attached           { generation, from_offset }
runtime.detached           { generation, reason }
runtime.exited             { generation, code, signal }
runtime.lost               { generation }                    ← probe returned Gone
runtime.start_failed       { generation, error }

provider.session_observed  { provider_session_id, source }   ← may fire repeatedly; last wins
provider.auth_required     { scope, message }

turn.submitted             { turn_id, content, idempotency_key }
turn.delivery              { turn_id, state: confirmed|rejected|ambiguous }
turn.started               { turn_id }
turn.completed             { turn_id, stop_reason }
turn.failed                { turn_id, error }
turn.cancelled             { turn_id, by }
turn.indeterminate         { turn_id, reason }

msg.delta                  { turn_id, text }
msg.thought                { turn_id, text }
tool.started               { turn_id, tool_call_id, kind, input }
tool.output                { turn_id, tool_call_id, chunk_ref }
tool.completed             { turn_id, tool_call_id, status, output_ref }
file.changed               { turn_id, path, change_kind }
terminal.output            { turn_id, terminal_id, chunk_ref }

approval.requested         { approval_id, turn_id, action, description, expires_at }
approval.auto_resolved     { approval_id, outcome, rule_id }
approval.resolved          { approval_id, outcome, by, channel }
approval.parked            { approval_id }

workspace.checkpoint       { commit_sha, label }
usage.reported             { input, output, cache_read, cache_write, cost_usd }
channel.bound              { channel, account_id, conversation_id }
channel.unbound            { channel, conversation_id }
```

### 3.3 Sessions

The `sessions` table is a **projection with a durability guarantee**, not the source of truth. It can be rebuilt from `events` at any time. It exists because you need to query it.

```sql
CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  workspace_id         TEXT NOT NULL,
  owner_principal      TEXT NOT NULL,
  state                TEXT NOT NULL,      -- see §5
  title                TEXT,

  generation           INTEGER NOT NULL DEFAULT 0,
  provider_session_id  TEXT,               -- OBSERVED, updated continuously
  execution_handle     TEXT,               -- durable string, never a PID
  execution_backend    TEXT,

  parent_session_id    TEXT REFERENCES sessions(id),   -- lineage on compaction split
  fork_of_session_id   TEXT REFERENCES sessions(id),

  last_seq             INTEGER NOT NULL DEFAULT 0,
  snapshot_seq         INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  last_activity_at     INTEGER NOT NULL,
  cold_at              INTEGER,

  cost_usd             REAL NOT NULL DEFAULT 0,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_sessions_state    ON sessions(state, last_activity_at);
CREATE INDEX idx_sessions_owner    ON sessions(owner_principal, last_activity_at DESC);
CREATE INDEX idx_sessions_ws       ON sessions(workspace_id);
CREATE INDEX idx_sessions_parent   ON sessions(parent_session_id);
```

**Title is scoped, not globally unique** — `UNIQUE(owner_principal, title)` if you want uniqueness at all.

### 3.4 Channel bindings — separate table, always

```sql
CREATE TABLE channel_bindings (
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  channel          TEXT NOT NULL,          -- 'telegram' | 'web' | 'slack' | 'rest'
  account_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  thread_id        TEXT,
  is_primary       INTEGER NOT NULL DEFAULT 0,
  cursor_seq       INTEGER NOT NULL DEFAULT 0,   -- how far this channel has rendered
  bound_at         INTEGER NOT NULL,
  PRIMARY KEY (session_id, channel, conversation_id, COALESCE(thread_id,''))
) STRICT;

CREATE INDEX idx_bindings_lookup ON channel_bindings(channel, conversation_id, thread_id);
```

This is the table that makes G2 work. **The session ID must never encode the channel.** Inbound resolution is `(channel, conversation_id, thread_id) → session_id`, a lookup — not a string construction.

### 3.5 Turns, approvals, workspaces

```sql
CREATE TABLE turns (
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  turn_id          TEXT NOT NULL,
  generation       INTEGER NOT NULL,
  idempotency_key  TEXT NOT NULL,
  state            TEXT NOT NULL,   -- pending|delivering|running|awaiting_approval
                                    -- |completed|failed|cancelled|indeterminate
  submitted_at     INTEGER NOT NULL,
  ended_at         INTEGER,
  PRIMARY KEY (session_id, turn_id)
) STRICT;

CREATE UNIQUE INDEX idx_turns_idem ON turns(session_id, idempotency_key);

CREATE TABLE approvals (
  approval_id   TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  turn_id       TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  action        TEXT NOT NULL,
  payload       BLOB NOT NULL,
  state         TEXT NOT NULL,   -- pending|parked|resolved
  outcome       TEXT,            -- allow|allow_always|deny|cancelled
  resolved_by   TEXT,
  resolved_via  TEXT,            -- channel it was answered on
  created_at    INTEGER NOT NULL,
  parks_at      INTEGER NOT NULL,
  resolved_at   INTEGER
) STRICT;

CREATE INDEX idx_approvals_pending ON approvals(state, parks_at)
  WHERE state IN ('pending','parked');

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,    -- 'git-worktree' | 'plain-dir' | 'volume'
  root_path     TEXT NOT NULL,    -- STABLE for the workspace's lifetime
  repo_root     TEXT,
  branch        TEXT,
  lock_holder   TEXT REFERENCES sessions(id),
  created_at    INTEGER NOT NULL
) STRICT;
```

### 3.6 Snapshots

A six-month session has an unbounded log. Materialize every `N=500` events or `M=30min`, whichever first:

```sql
CREATE TABLE snapshots (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,
  state       BLOB NOT NULL,   -- JSON: session fields, pending approvals,
                               -- compacted transcript, cost, bindings
  PRIMARY KEY (session_id, seq)
) STRICT;
```

`current_state = snapshot(max_seq ≤ K) + replay(events > K)`. Bounds reconnect cost and cold-rehydrate cost.

### 3.7 Write contention

Multiple writers (gateway, per-session actors, spool ingesters) share one DB. Copy the tuning that Hermes learned the hard way:

```
busy_timeout          = 1000 ms      (not the 30s default)
retry                 = up to 15, jittered 20–150 ms
transactions          = BEGIN IMMEDIATE
wal_checkpoint(PASSIVE) every 50 writes
```

The short timeout plus jitter avoids the convoy effect where SQLite's deterministic internal backoff makes all writers retry in lockstep.

---

## 4. Broker sidecar — the core of durability

### 4.1 Why it exists

```
WITHOUT broker:                      WITH broker:

gateway ──stdio──> agent             gateway ──unix socket──> broker ──stdio──> agent
   │                                    │  (reconnectable)      │  (detached)
   └─ restart ⇒ SIGHUP ⇒ dead           └─ restart ⇒ reattach    └─ survives
```

The broker is a small, boring, rarely-changed binary. Its liveness is owned by the **backend** (tmux session / systemd transient scope / container), never by the gateway process tree.

### 4.2 Responsibilities

| Does | Does not |
|---|---|
| Own agent stdio, speak ACP | Make policy decisions |
| Assign `broker_seq`, spool every event to disk | Write to the gateway DB |
| Serve `ATTACH from_offset` | Render for channels |
| Forward prompts, return delivery state | Decide approvals (relays only) |
| Buffer while gateway is absent | Manage workspaces |

Keep it dumb. Every ounce of intelligence in the broker is intelligence you can't hot-fix without killing sessions.

### 4.3 The spool

```
$PRIME_HOME/sessions/<session_id>/<generation>/
  ├── spool.ndjson       # one event per line, append-only, fsync-batched
  ├── raw/               # tool output, terminal output — referenced by chunk_ref
  └── broker.sock        # control socket
```

`spool.ndjson` is the **buffer**; the gateway's `events` table is the **system of record**. Ingest is idempotent on `(session_id, generation, broker_seq)`. If the gateway is down for ten minutes, the agent's work still lands on disk and is ingested on reattach.

For the `tmux` backend, additionally run `tmux pipe-pane -o` to a raw log. Costs one line, saves you every time the broker itself dies unexpectedly.

### 4.4 Control protocol (gateway ↔ broker)

Newline-delimited JSON over unix socket. Deliberately not ACP — this is a different concern.

```
→ HELLO      { session_id, generation }
← HELLO_OK   { spool_offset, broker_seq, agent_state, caps }

→ ATTACH     { from_offset }
← (stream of spooled events, then live events)

→ PROMPT     { turn_id, idempotency_key, content }
← DELIVERY   { turn_id, state: confirmed | rejected | ambiguous }

→ CANCEL     { turn_id }
→ RESOLVE    { approval_id, outcome }
→ PROBE
← STATUS     { running | exited(code) | starting, pid, uptime }
→ SHUTDOWN   { graceful: bool, deadline_ms }
```

`ATTACH` is a first-class operation, distinct from start. This is the whole point.

### 4.5 One broker per session

Tempting alternative: pool brokers, multiplex ACP sessions (`multiplexed` agents support it). Rejected for v1 — one broker crash would take down N sessions, and blast radius is exactly what we're optimizing. Revisit only after measuring per-broker RSS.

---

## 5. Session lifecycle

```
                    ┌──────────────┐
                    │ initializing │
                    └──────┬───────┘
                           ▼
   ┌────────────┐    ┌──────────┐    ┌────────────┐
   │  blocked   │◄──►│   live   │◄──►│    idle    │
   └────────────┘    └────┬─────┘    └─────┬──────┘
    approval /             │                │ idle_timeout
    auth required          │                ▼
                           │          ┌──────────┐
                           └─────────►│   cold   │
                            crash /   └────┬─────┘
                            explicit       │ archive_after
                                           ▼
                                     ┌──────────┐
                                     │ archived │
                                     └──────────┘
```

| State | Broker | Agent | Cost | Reachable |
|---|---|---|---|---|
| `live` | up, attached | running | full | yes |
| `idle` | up | running, quiescent | memory only | yes |
| `blocked` | up | waiting on approval/auth | memory only | yes, needs input |
| `cold` | down | not running | disk only | rehydrate on message |
| `archived` | down | not running | tarball | rehydrate slowly |

### The key move: make rehydration routine

Idle timeout should be aggressive (30–60 min). Rehydration from `cold` on the next inbound message is then **the normal path, exercised constantly**. Crash recovery becomes the same code running unplanned rather than a special path that only executes during incidents.

This is the single highest-leverage decision in the design. Do not make `cold` an exceptional state.

---

## 6. Driver layer

### 6.1 Interface

```ts
interface AgentDriver {
  readonly transport: 'acp' | 'structured-cli' | 'pty';

  // Broker-side. Runs inside the broker, not the gateway.
  handshake(proc: AgentProcess): Promise<NegotiatedCaps>;
  openSession(spec: SessionSpec): Promise<ProviderSessionId>;
  loadSession(id: ProviderSessionId, onReplay: (e: Event) => void): Promise<void>;
  resumeSession?(id: ProviderSessionId): Promise<void>;   // only if caps.resume === 'native'

  prompt(turnId: string, content: Content[]): Promise<DeliveryResult>;
  cancel(turnId: string): Promise<void>;
  resolvePermission(reqId: string, outcome: Outcome): Promise<void>;

  events(): AsyncIterable<NormalizedEvent>;
}

type DeliveryResult =
  | { state: 'confirmed' }
  | { state: 'rejected'; error: string }
  | { state: 'ambiguous'; fence: string };   // NEVER auto-retry on this
```

### 6.2 ACP driver — the default, covers ~everything

ACP is not just one option among three. It already specifies most of what the gateway would otherwise hand-roll:

| prime concept | ACP mechanism |
|---|---|
| capability negotiation | `initialize` |
| session create | `session/new` |
| session restore (with replay) | `session/load` |
| session restore (no replay) | `sessionCapabilities.resume` |
| session fork | `session/fork` (experimental) |
| discovery | `listSessions` (if advertised) |
| prompt | `session/prompt` |
| streaming | `session/update` notifications |
| approvals | `session/request_permission` |
| cancel | `session/cancel` |
| workspace | `cwd` + `additionalDirectories` |

**Three implementation traps, all confirmed in the wild:**

1. **Replay ordering.** Agents stream `session/load` history as notifications *during* the request and respond only after the last one. Register your update routing **before** you await the RPC. Clients that listen only after the response resolves receive zero notifications. Zed does this correctly; Hermes shipped it wrong and patched it twice.

2. **There is no `session/resume` or `session/close` method.** Resume is `session/load` + a capability flag. Close is process lifecycle, not a protocol call. Design accordingly.

3. **Vendor `_meta`.** `claude-agent-acp` carries subagent structure through `_meta.claudeCode.parentToolUseId` and `_meta.claudeCode.subagent`, opted into via `clientCapabilities._meta["subagent-transcript"]`. Policy: **store raw in the event log, project selectively.** Otherwise you either lose subagent structure or leak vendor shapes into channel adapters.

### 6.3 Structured-CLI driver

For agents with a JSON/JSONL mode but no ACP path. `claude -p --output-format stream-json --input-format stream-json` is the reference case.

**Provider session ID is observed, never assumed.** Two independent confirmations that it can diverge from what you passed in: the CLI's interactive mode generates its own internal UUID for persistence separate from `--session-id`, and BotMux found the native ID can rotate mid-process, forcing them to watch transcripts and update their mapping. Therefore:

```
provider.session_observed fires on EVERY sighting.
sessions.provider_session_id = last observed value.
Never persist the value you sent.
```

Also handle: the interactive resume dialog (`Would you like to resume? 1. Yes / 2. No`) which blocks unattended runs with no error and no exit code — needs a **startup-stall detector**, not just a turn timeout. And project-scoped session lookup means the workspace path is part of session identity: **record it, never relocate it.**

### 6.4 PTY driver — fallback only, actively being deleted

Everything about this path is a liability: ANSI redraws, spinner frames, bracketed paste, UTF-8 chunk boundaries, Enter vs Meta+Enter, readiness detection, typing throttle. BotMux's Claude adapter needed all of it just to accomplish "send this prompt."

If you must ship it, the **delivery fence** is non-negotiable:

```
write(prompt) → submit → watch agent's own transcript for a fingerprint of the message
    ├─ found          → confirmed
    ├─ definitively absent after settle window → rejected, safe to retry
    └─ unknown        → AMBIGUOUS. Do not retry. Surface to the human.
```

Duplicate turns mean duplicate commits, deploys, migrations, API calls. `ambiguous` is a terminal state requiring human adjudication.

**Note this problem is an artifact of PTY.** Over ACP, `session/prompt` is a JSON-RPC request with an ID and a response — delivery is confirmed by the protocol. Build the fence in the PTY driver only; keep it out of the core.

### 6.5 Registry

```yaml
agents:
  claude:
    driver: acp
    command: ["npx","-y","@agentclientprotocol/claude-agent-acp"]
    backend: tmux
    caps:
      resume: native          # native | replay | none
      session_mode: resumable # stateless | resumable | pinned | multiplexed
      permissions: true
      cost_reporting: true

  gemini:
    driver: acp
    command: ["gemini","--acp"]
    backend: tmux
    caps: { resume: replay, session_mode: multiplexed }

  codex:
    driver: acp
    command: ["npx","-y","@zed-industries/codex-acp"]
    backend: tmux

  internal-claude:            # same driver, different executable + backend
    driver: acp
    command: ["/opt/corp/claude-wrapper","--acp"]
    backend: container
    container: { image: "corp/agent-base:2026.7", network: "restricted" }
```

`driver`, `command`, and `backend` are **separate axes**. `internal-claude` reuses the ACP driver entirely.

Declared caps are a **hint**; negotiated caps from `initialize` win. Store both — divergence is a useful alert that a vendor changed something.

`resume: native` must **fall back to `replay`** automatically when a provider session ID is rejected as expired.

---

## 7. Execution backend

```ts
interface ExecutionBackend {
  start(spec: RuntimeSpec): Promise<Handle>;   // Handle is DERIVED, not returned-by-luck
  attach(h: Handle): Promise<BrokerConn>;
  probe(h: Handle): Promise<'running' | { exited: number } | 'gone' | 'unknown'>;
  discover(): Promise<Handle[]>;               // enumerate orphans at boot
  stop(h: Handle, graceful: boolean): Promise<void>;
}
```

### Handle is deterministic and reconstructible from persisted state alone

```
handle = "prime/" + session_id + "/" + generation
```

- **tmux** → session name `prime/ses_8f72/42`
- **container** → container name `prime-ses_8f72-42`
- **systemd scope** → `prime-ses_8f72-42.scope`

**Never a PID.** PIDs get reused; a stale PID probe can return `running` for an unrelated process.

### `probe` returns four values, not a boolean

`unknown` is the load-bearing one. If a `tmux has-session` call times out, interpreting that as `missing` and recreating the runtime gives you two agents in one workspace. Tri-state (plus `unknown`) discipline applies everywhere runtime state is distributed: process, container, workspace, provider session, remote task.

### Backend selection

| Backend | Survives gateway restart | Survives reboot | Isolation | Use |
|---|---|---|---|---|
| `process` | ✗ | ✗ | none | short REST calls only — **never the default** |
| `tmux` | ✓ | ✗ | none | default for local dev |
| `systemd scope` | ✓ | ✓ (with restart policy) | cgroup | default for servers |
| `container` | ✓ | ✓ | full | multi-tenant, untrusted work |
| `remote` | ✓ | ✓ | host | heavy compute |

The bare `process` backend is the **degraded** option. If it's your default, you will accidentally design against reattachment and not notice until the first restart.

---

## 8. Two-phase start and boot reconciliation

### 8.1 Two-phase start

The nastiest failure is crashing between "spawned" and "recorded that I spawned" — you get an invisible orphan agent burning tokens with nobody listening.

```
1. generation = sessions.generation + 1
   handle     = derive(session_id, generation)
   APPEND runtime.start_requested { generation, handle, spec }     ← durable FIRST

2. backend.start(spec)                                              ← side effect

3. APPEND runtime.started { generation, handle, pid, backend }
```

Because the handle is *derived*, step 1 knows it before step 2 happens. That's what makes recovery possible.

### 8.2 Reconciliation, run at every boot

```python
def reconcile():
    known = set()

    for s in db.sessions_where(state not in TERMINAL):
        h = s.execution_handle
        known.add(h)

        match backend.probe(h):
            case 'running':
                conn = backend.attach(h)
                ingest_spool(s.id, s.generation, from_offset=s.last_ingested_offset)
                append(s.id, 'runtime.attached', {generation: s.generation})
                resolve_indeterminate_turns(s)
                set_state(s, 'live' if s.pending_turns else 'idle')

            case {'exited': code}:
                append(s.id, 'runtime.exited', {generation: s.generation, code})
                ingest_spool(s.id, s.generation)          # drain what it wrote
                set_state(s, 'cold')                      # restart on demand, not now

            case 'gone':
                append(s.id, 'runtime.lost', {generation: s.generation})
                ingest_spool(s.id, s.generation)
                set_state(s, 'cold')

            case 'unknown':
                set_state(s, 'unknown')                   # DO NOT recreate
                alert(s.id, 'probe indeterminate')

    for h in backend.discover():                          # orphans
        if h not in known:
            if parseable(h) and session_exists(session_of(h)):
                adopt(h)                                  # crashed after start_requested
            else:
                reap(h)                                   # genuinely stray
```

### 8.3 Indeterminate turns

The gnarly case: a tool call was in flight at crash time. You don't know whether the write landed.

```
for turn in session.turns_where(state in ('delivering','running')):
    if turn.generation < session.generation:
        mark(turn, 'indeterminate')
```

Do **not** guess. For filesystem effects, the workspace checkpoint (§9) lets you actually check — diff `HEAD` against the last `workspace.checkpoint` commit and report the delta to the human. That converts "I don't know what happened" into "here is exactly what changed."

---

## 9. Workspaces

### Model: git worktree per session

```
repo/                              # bare or primary clone
$PRIME_HOME/workspaces/ws_42/      # worktree, branch prime/ses_8f72
```

- **`root_path` is immutable for the workspace's lifetime.** Claude Code's session lookup is project-directory-scoped, so relocating a worktree orphans the provider session. Record it once, never move it.
- **Exclusive by default.** `lock_holder` on the workspace row. Two sessions sharing a workspace requires an explicit opt-in and a lease.
- **Backend binding:** `process`/`tmux` → cwd; `container` → mount; `remote` → rsync'd path or shared FS. The workspace abstraction must be expressible in all backends or the matrix gets holes.

### Checkpoints

Auto-commit at turn boundaries and before/after approved destructive ops. Record `commit_sha` in the event log.

**Use a separate ref namespace** — `refs/prime/checkpoints/<session_id>` — so you don't fight agents that run `git` themselves. This is the safer default and costs nothing.

Buys you: diffing what the agent did while you were away, rollback, and a concrete answer to indeterminate tool calls.

---

## 10. Approvals and policy

### Split the two concerns

```
  agent requests permission
            │
            ▼
    ┌───────────────┐   auto-allow / auto-deny
    │ POLICY ENGINE │──────────────────────────► resolve immediately
    │ (rules, tests)│                            (approval.auto_resolved)
    └───────┬───────┘
            │ needs a human
            ▼
    ┌───────────────┐
    │   APPROVALS   │  durable record, stable ID, idempotent resolution
    └───────┬───────┘
            │ fan out to ALL bound channels
            ▼
     Telegram  ·  Web  ·  Slack
```

The policy engine changes often and needs tests; the approval transport changes rarely. Different modules.

### Park, don't deny

With long-lived sessions an approval may sit for days. Default-deny-on-timeout silently kills long work.

```
pending ──parks_at reached──► parked   (session → blocked, notify all channels)
        ──human answers────► resolved
```

**Denial is an explicit act.** Parking is what timeouts do.

### Requirements

- Stable `approval_id`, survives restart
- **Idempotent resolution** — two channels answering simultaneously, or a retry, must not double-resolve. `UPDATE ... WHERE state != 'resolved'` and check rowcount.
- Record `resolved_by` **and** `resolved_via` (which channel) — this is audit-relevant
- Generation-stamped: an approval from generation 41 arriving after a restart into generation 42 is stale, drop it
- Cross-channel: asked on Telegram, answerable from web

### Control-plane bypass

When an agent is running, inbound messages queue. But `/stop`, `/cancel`, `/approve`, `/deny`, `/status` must reach the runner **inline**, bypassing the queue. Otherwise `/approve` sits behind the very turn it would unblock. Two-level guard:

```
L1  ChannelAdapter:  session busy? → queue message, set interrupt flag
L2  Router:          is it a control command? → dispatch inline
                     otherwise → interrupt or enqueue per policy
```

---

## 11. Concurrency: single writer per session

One actor (goroutine / task / thread) owns each live session. All mutations funnel through it.

- Makes `seq` allocation trivially correct
- Serializes concurrent input from multiple channels
- Eliminates a whole class of interleaving bugs

Cross-node later means a real lease with fencing tokens. Don't build that now — but keep the `generation` counter, because it *is* your fencing token when the time comes.

### Generation counters, unified

The generation serves three purposes with one number:

1. Component of the derived execution handle
2. Stale-event rejection — an event stamped gen 41 arriving after restart into gen 42 is discarded
3. Future fencing token for multi-node leases

Do not let these become three separate mechanisms.

---

## 12. Channels

```ts
interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // inbound
  onEvent(cb: (e: InboundEvent) => void): void;   // normalized, principal-resolved

  // outbound: render a slice of the event log
  render(sessionId: string, events: Event[], cursor: number): Promise<number>;

  readonly caps: {
    streaming: boolean;        // token-level SSE vs whole messages
    editMessages: boolean;     // Telegram edits vs SMS append-only
    interactiveButtons: boolean;
    maxMessageLen: number;
    rateLimit: RateLimit;
  };
}
```

### Channels are projections over the event log

Each binding carries `cursor_seq`. Reconnect is `render(events > cursor_seq)`. Web reconnect, multi-device, and catch-up-after-outage all fall out of this for free — you don't write them separately.

### Backpressure is adapter-side policy

Telegram rate-limits message edits; web wants token-level SSE; REST wants a completed response. All three consume the same event stream and decide independently how to pace it. **Never push this into the gateway.**

### Per-channel resilience

- Circuit breaker per channel with a trip event recording failure count and last error
- Indefinite retry with capped exponential backoff
- **But**: expose breaker state explicitly, because a revoked token and a network blip look identical under infinite retry. `/channel status` must show "retrying since T, last error E" — otherwise a permanently dead channel silently retries forever.

---

## 13. Identity, authz, secrets

### Principal resolution happens in the adapter

```
telegram_user_id 12345 → principal:alice → [workspace:ws_42, ws_51]
```

Retrofitting this is painful. Put it in the `ChannelAdapter` contract from commit one, even if v1 has exactly one principal.

### Agent credentials are per-vendor and expire

Each agent runtime owns its own auth and billing — a key configured for one does not configure another. For long-lived sessions this means **credentials expire mid-session**.

```
provider.auth_required → session state = blocked → notify all bound channels
```

Treat it exactly like an approval: a first-class blocked state with a resolution path, not an error that kills the session.

Also verify current billing behaviour for third-party agent paths (ACP, Agent SDK, `claude -p`) before committing — there were changes in this area around mid-2026 that affect whether subscription or API billing applies.

### Secrets must not land in the workspace or the event log

- Inject via broker environment at spawn, never via files in the workspace
- Redact on ingest: the spool ingester runs a redaction pass before events hit the DB
- Container backend: mount as tmpfs, never bake into the image

---

## 14. Failure modes

| Failure | Detection | Response |
|---|---|---|
| Gateway restart | boot | reconcile, reattach, ingest spool from offset |
| Broker crash | probe → `exited`/`gone` | session → `cold`; restart on next message with resume |
| Agent crash | broker sees stdio EOF | broker records `runtime.exited`, stays alive to serve spool |
| Crash between spawn & record | `start_requested` with no `started` | probe derived handle; adopt or mark failed |
| Orphan runtime | `discover()` − known handles | adopt if parseable & session exists, else reap |
| Probe timeout | `unknown` | **do nothing**, alert. Never recreate. |
| In-flight tool at crash | turn.generation < session.generation | mark `indeterminate`, diff workspace vs checkpoint |
| Ambiguous PTY delivery | delivery fence | terminal state, human adjudication, never auto-retry |
| Stale event post-restart | generation mismatch | discard |
| Provider session expired | resume rejected | fall back `native` → `replay` |
| Credentials expired | `provider.auth_required` | session → `blocked`, notify |
| Approval unanswered | `parks_at` reached | park, notify, **do not deny** |
| Channel down | circuit breaker | backoff + retry, expose breaker state |
| Context window full | agent-signalled compaction | lineage split via `parent_session_id` |
| Log growth | seq − snapshot_seq > N | snapshot |

---

## 15. Build order

Steps 1–4 are unglamorous and *are* the durability guarantee. Building channels and routing first means retrofitting reattachment later, which means rewriting the session manager.

| # | Milestone | Done when |
|---|---|---|
| 1 | Event log + snapshots + write-contention tuning | can replay a session's state from `events` alone |
| 2 | Broker + tmux backend: `start`/`attach`/`probe`/`discover` + spool | kill the gateway mid-turn, restart, session continues |
| 3 | Two-phase start + boot reconciliation | crash between phases, orphan is adopted not lost |
| 4 | Cold / rehydrate tiering | idle timeout exercises recovery continuously |
| 5 | ACP driver, one agent end-to-end, resume declared in registry | resume works and falls back when the ID expires |
| 6 | Approvals with policy engine + parking + cross-channel resolution | approve from web what Telegram asked |
| 7 | Second ACP agent | **audits your abstractions** — expect to find leaks here |
| 8 | Channel adapters (web SSE first, then Telegram) | cursor-based reconnect works |
| 9 | Workspaces: worktree + checkpoints | can diff what the agent did overnight |
| 10 | Container backend | isolation for untrusted work |
| 11 | Structured-CLI driver | for agents without ACP |
| 12 | PTY driver + delivery fence | only if genuinely required |

Milestone 7 is the real test. If adding the second agent requires touching the gateway core, the driver abstraction is wrong and it's cheap to fix now.

---

## 16. Open questions

1. **Broker pooling.** One-per-session is the safe start. Measure RSS after milestone 7 and revisit — multiplexed ACP agents make pooling tempting, but blast radius argues against it.

2. **Compaction and lineage.** When an agent signals context exhaustion, split into a child session via `parent_session_id`. Open: does the child inherit the workspace lock, the channel bindings, or both? (Probably both, but the transition must be atomic.)

3. **Snapshot fidelity for `resume: replay`.** Your compacted transcript has to be semantically faithful, not just truncated, or replay-resumed agents lose context silently. Consider storing a byte-fidelity sidecar of exactly what was sent to the provider — this is what makes prompt-cache-stable replay possible.

4. **Cost attribution across generations.** A session that restarts 40 times accumulates usage from 40 runtimes. Attribute per-generation and aggregate, so a runaway generation is visible rather than smeared.

5. **Multi-node.** The `generation` counter is your fencing token. The migration path is: replace the per-session actor with a leased actor, move `events` to Postgres keeping the `(session_id, seq)` key. Design the seq allocator so this is mechanical.

---

## Appendix A — Naming discipline

| Term | Means | Never |
|---|---|---|
| `session_id` | prime's opaque durable ID | encodes channel or provider |
| `provider_session_id` | vendor's ID, **observed** | canonical, or persisted-as-sent |
| `handle` | derived durable runtime address | a PID |
| `generation` | runtime incarnation counter | reset, reused |
| `turn_id` | one prompt→completion unit | reused across retries |
| `workspace_id` | durable filesystem identity | relocated |

## Appendix B — Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Gateway owns agent stdio directly | Gateway restart kills all sessions — violates the primary constraint |
| Session ID encodes channel | Breaks multi-channel observation; a Hermes pattern that doesn't fit here |
| Agent LRU cache with idle eviction | Eviction = kill for external processes; works only for in-process agents |
| PTY-first driving | Enormous machinery for "send a prompt"; brittle against vendor UI changes |
| Messages table as source of truth | No replay-from-offset, no audit, no multi-observer reconnect |
| Default-deny on approval timeout | Silently kills multi-day work |
| Separate ACP `session/resume` method | Doesn't exist — it's `session/load` plus a capability flag |
| Postgres from day one | SQLite WAL handles single-node fine; migrate when multi-node is real |
| Pooled brokers in v1 | One crash takes down N sessions |
