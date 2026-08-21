# Durability test matrix

Tests for the contract in [`../architecture.md`](../architecture.md) §4.6.

These run against a **fake agent** — a process that emits a scripted, deterministic event
stream on demand. No ACP, no vendor binary, no network. Everything here should run in CI in
under a minute.

If these pass reliably, the hardest and most differentiating part of prime-gateway works.
Everything downstream is conventional.

---

## Harness

```
  test driver  ──►  gateway  ──►  broker  ──►  fake agent
       │                                        (scripted stream)
       └─ kill -9 at controlled points, then assert
```

**Fake agent requirements**

- Emits N events at a controlled rate on `prompt`
- Can be told to emit a permission request and block
- Can be told to hang (for stall/timeout tests)
- Deterministic content, so event streams are byte-comparable across runs

**Universal post-conditions.** After every test below, assert all of:

| # | Assertion |
|---|---|
| P1 | `broker_seq` for each `(session, generation)` is 1..N with no gaps and no repeats |
| P2 | No duplicate `(session_id, generation, broker_seq)` rows in `events` |
| P3 | `sessions.last_ingested_offset` points just past a newline in the spool |
| P4 | Session state is reachable and not `unknown` (except T-09, where `unknown` is correct) |
| P5 | No orphan runtime: every discovered handle maps to a live session, or was reaped |
| P6 | Exactly one execution of each turn — the fake agent's side-effect counter matches |

---

## Baseline: the walkthrough

**T-00 — happy path crash and reattach**

1. Start a session
2. Start a long agent turn (fake agent emits 5000 events over 30s)
3. `kill -9` the gateway at ~50% through
4. Assert the agent keeps working — spool keeps growing while the gateway is dead
5. Restart the gateway
6. Assert reattach from the exact recorded offset
7. Assert no duplicate events (P2) and no gaps (P1)
8. Send another prompt; assert it lands
9. `kill -9` the broker halfway through
10. Assert rehydration of the provider session
11. Assert the conversation continues correctly

This is the demo. The tests below are the ones that actually find bugs.

---

## Spool integrity

**T-01 — torn spool tail** &nbsp;·&nbsp; *contract S3, S4*

`kill -9` the broker during a high-rate token stream so the final line is truncated
mid-JSON.

- Ingester discards the partial trailing line
- Broker on restart truncates to the last newline before appending
- The next `broker_seq` continues correctly — no gap, no reuse
- Run 50 iterations with randomized kill timing; the truncation point must vary

**T-02 — kill during fsync batch**

`kill -9` between an event being written and the batch fsync.

- At most the un-fsynced tail is lost
- Whatever survives satisfies S1–S6
- The gateway does not observe a `broker_seq` gap

**T-03 — spool larger than memory**

Emit 500k events (~200MB spool), then restart the gateway.

- Ingest streams rather than loading the file
- Memory stays bounded
- Ingest is resumable if interrupted (see T-06)

---

## Ingest idempotency

**T-04 — deliberate double ingest** &nbsp;·&nbsp; *contract 4.6.3*

Ingest a spool range, rewind `last_ingested_offset` by hand, ingest again.

- Event count is **unchanged**
- Assert this explicitly. Passive absence of duplicates does not prove the dedup index is
  doing anything — this test is what proves it.

**T-05 — triple ingest with overlap**

Ingest `[0, 500)`, then `[300, 800)`, then `[0, 800)`.

- Final state identical to a single clean `[0, 800)` ingest
- Byte-compare the resulting event rows

**T-06 — crash mid-ingest** &nbsp;·&nbsp; *contract 4.6.3*

`kill -9` the gateway while it drains a 10k-event spool.

- On restart, ingest resumes from the last committed offset
- Total event count is exactly 10k
- This is where the single-transaction property is load-bearing

---

## Start and reconciliation

**T-07 — two-phase start gap** &nbsp;·&nbsp; *contract §8.1*

`kill -9` the gateway between `runtime.start_requested` and `runtime.started`.

- On restart, the derived handle is probed
- If running → adopted, `runtime.started` appended late
- If not → `runtime.start_failed`, retried
- **This is the case the two-phase scheme exists for.** T-00 never reaches it.

**T-08 — orphan adoption and reaping**

Start a runtime, delete its session row, restart the gateway.

- `discover()` finds the handle
- Unparseable or session-less handles are reaped
- Parseable handles with a live session are adopted, not duplicated

**T-09 — probe returns `unknown`** &nbsp;·&nbsp; *contract §7*

Block the tmux control socket so `has-session` times out.

- Session moves to `unknown`
- **Nothing is recreated**
- Alert fires
- Failure mode being prevented: two agents in one workspace, which is far worse than a lost
  session

**T-10 — double gateway start** &nbsp;·&nbsp; *contract 4.6.6*

Launch two gateway instances against the same `$PRIME_HOME`.

- Second instance fails fast on the lock file
- If it somehow reaches the broker, the broker refuses the second `HELLO`
- Offsets are never advanced by two writers

---

## Turn identity

**T-11 — prompt confirm ordering** &nbsp;·&nbsp; *contract 4.6.4*

`kill -9` the broker between spool write and fsync, and separately between fsync and
forward-to-agent.

- Gateway never records `confirmed` for a turn the broker has no record of
- P6 holds: the fake agent's side-effect counter shows exactly one execution

**T-12 — in-flight turn reconciliation**

For each row of the 4.6.4 table, construct the state and assert the resolution:

| Broker | Gateway | Expected |
|---|---|---|
| has T | T `delivering` | no resubmit |
| no in-flight | T `delivering` | `indeterminate`, no auto-retry |
| has T | no T | ingest from spool |
| no in-flight | no open turns | clean |

**T-13 — indeterminate is terminal**

Force the indeterminate case.

- No automatic retry under any circumstance
- Turn surfaces to the human
- Workspace diff against the last checkpoint is available and correct

---

## Generation semantics

**T-14 — late events from a dead generation** &nbsp;·&nbsp; *contract 4.6.5*

Crash, restart into generation N+1, then ingest leftover generation-N spool.

- Generation-N events **are** written to the log (history preserved)
- They do **not** drive state transitions
- Specifically: a `turn.completed` from gen 41 does not complete a turn in gen 42

**T-15 — generation monotonicity**

Restart 50 times in a loop.

- `generation` strictly increases, never resets, never reuses
- Handles remain unique across all 50
- No handle collision with a still-running orphan

---

## Approvals

**T-16 — approval survives restart** &nbsp;·&nbsp; *contract §10*

`kill -9` the gateway with an approval pending.

- On restart the approval is still pending and answerable
- Answer it from a **different channel** than it was asked on
- Resolution is idempotent: two channels answering simultaneously resolves once

**T-17 — parking, not denial**

Let an approval pass `parks_at`.

- State becomes `parked`, not `denied`
- Session becomes `blocked`
- All bound channels are notified
- A human can still answer afterwards

**T-18 — stale approval across generations**

Approval raised in gen 41; restart; resolve arrives in gen 42.

- Resolution is rejected as stale
- The turn does not proceed on a stale approval

---

## Rehydration

**T-19 — cold and back**

Idle a session past its timeout, then send a message.

- Broker gone, session `cold`
- Message triggers rehydrate
- Provider session resumes (native or replay per registry caps)
- Conversation continues correctly

**T-20 — resume fallback**

Make the provider reject the stored session ID as expired.

- `resume: native` falls back to `replay` automatically
- Session continues rather than failing
- Fallback is recorded in the event log

**T-21 — rehydrate storm**

Cold 100 sessions, then wake all of them simultaneously.

- No handle collisions
- No `broker_seq` corruption
- Backpressure is applied rather than fork-bombing the host

---

## Coverage gaps to close later

Not blocking the milestone-4 proof, but real:

- Disk full during spool write
- Clock skew across gateway restart (`ts` monotonicity)
- Workspace lock held by a session that no longer exists
- Container backend: host reboot with restart policy
- Credential expiry mid-turn → `blocked`, not session death
- Compaction split: does the child inherit workspace lock and channel bindings atomically?
