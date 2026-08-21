# Writer contract

Every table in this schema has exactly one module allowed to write it. This file
is the registry. If you are adding a write and it is not listed here, you are
adding a second writer to something, and you need to either route through the
existing owner or amend this file first.

## Why a registry rather than a convention

"There is only one writer" is a claim that decays silently. It survives the first
implementation, then a repair script, a boot reconciler, or a test helper writes
the same row from another path, and the two writers disagree about a field
neither of them owns. Nothing crashes. A row is just wrong afterwards.

`txImmediate` protects against *interleaving*. It does not protect against two
modules holding different beliefs about what a column means. That is what this
file is for.

## Ownership

| Table | Sole writer | Notes |
| --- | --- | --- |
| `events` | `db/events.ts` | `appendEvents` only. `seq` is assigned inside the transaction from `sessions.last_seq`; nothing else may set it. Rows are never updated or deleted. |
| `sessions` | `db/sessions.ts` | Except `last_seq`, which `appendEvents` advances in the same transaction that writes the events — the two facts must not be able to disagree. |
| `turns` | `db/turns.ts` | |
| `approvals` | `db/approvals.ts` | |
| `channel_bindings` | `db/bindings.ts` | |
| `seen_messages` | `db/dedup.ts` | |
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`. |

## Rules that hold across all of them

**Append-only means append-only.** `events` has no UPDATE and no DELETE path.
Anything that looks like a correction is a new event that supersedes an old one.
A projection that needs to hide superseded content filters at read time. The log
is evidence, and evidence you can edit is not evidence.

**One transaction per fact.** If two rows must be true together, they are written
in one `txImmediate` call. The pair that matters most is `events` + the
`sessions.last_seq` bump: a committed event with a stale `last_seq` hands the
next append a duplicate `seq`.

**No `await` inside `txImmediate`.** The callback is synchronous by contract. An
`await` under the write lock lets unrelated work interleave while the lock is
held, and better-sqlite3 will happily let you start a second statement on the
same connection from that interleaved work.

**Never write from a projection.** Channel adapters read the log and advance
their own `cursor_seq`. That cursor is the only thing a projection owns. A
projection that writes session state has made the display authoritative over the
log, which inverts the whole design.

**Reads outside transactions are allowed to be stale.** They are snapshots. Any
decision that must not be made on a stale read — resolving an approval, claiming
a message, opening a turn — re-reads inside `txImmediate` and compares. The
generation CAS in `resolveApproval` is the reference example: the read that
picked the row is untrusted, and the write re-checks.
