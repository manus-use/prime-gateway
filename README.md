# prime-gateway

A vendor-neutral gateway for driving coding agents (Claude Code, Gemini CLI, Codex, and any
other ACP-compatible agent) from any channel — Feishu/Lark, Telegram, web, Slack, REST.

**Status:** first channel implemented. A Feishu/Lark message drives Claude Code in a
configured repository and the answer streams back into an interactive card. The broker
sidecar is not built yet, so **restarting the gateway kills every live agent**; sessions
themselves survive and cold-resume on the next message.

Design: [`docs/architecture.md`](docs/architecture.md) (whole system),
[`docs/specs/2026-08-21-lark-channel-design.md`](docs/specs/2026-08-21-lark-channel-design.md)
(this slice).

## What it is

prime-gateway does not implement an agent loop. It launches real vendor agent runtimes and
speaks a structured protocol to them, while owning the things the vendors don't:

- **Durable sessions** that survive gateway restart, agent crash, and weeks of idleness
- **Multi-channel access** — one session drivable from several channels simultaneously
- **Central approvals** — the agent asks once, any bound channel can answer
- **Isolated workspaces** — git worktree per session, checkpointed at turn boundaries
- **Audit** — an append-only event log is the system of record

```
Channels ──> Gateway ──> Driver ──> Broker ──> Agent runtime
                │                      │
          event log (SQLite)     detached, reattachable
```

## The core idea

> A gateway session is a durable event log with an optional, reattachable agent runtime
> bound to it.

ACP agents run as local subprocesses over stdio, so whoever holds the pipe owns the
session's life. If the gateway holds it, restarting the gateway kills every session. The
**broker sidecar** breaks that coupling: it runs detached under tmux/systemd/container,
owns the agent's stdio, spools every event to disk, and serves `attach(from_offset)` when
the gateway comes back.

## Running it

Requires Node 22.12+ and an ACP-capable agent on `PATH`.

```bash
npm install
npm run build
npm start
```

### Feishu/Lark app setup

Create a custom app, then:

1. **Permissions:** the scopes the console lists for receiving and sending messages as the
   bot (`im/v1/messages`), downloading message resources for inbound attachments
   (`im/v1/messages/:message_id/resources`), and creating and updating cards
   (`cardkit/v1/cards`).
2. **Events:** subscribe to `im.message.receive_v1` and `card.action.trigger`, delivered over
   **long connection** — no public URL, no request signing to get wrong.
3. Add the bot to a chat, or message it directly.

### Configuration

Everything comes from the environment. Every required value is validated at boot; a
configuration mistake prints one line and exits 78.

| Variable | Required | Meaning |
|---|---|---|
| `LARK_APP_ID` / `LARK_APP_SECRET` | yes | App credentials. Never written to disk or the event log. |
| `LARK_DOMAIN` | no | Set for Lark (`https://open.larksuite.com`); omitted means Feishu. |
| `PRIME_OWNER_OPEN_ID` | yes | Your `open_id`. Always in both allowlists — an allowlist that excludes the owner locks out the only person who can fix it. |
| `PRIME_WORKSPACE` | yes | Absolute path the agent works in. |
| `PRIME_AGENT_COMMAND` | yes | The ACP agent binary, e.g. `claude-agent-acp`. |
| `PRIME_AGENT_ARGS` | no | Arguments, split on whitespace, quotes honoured. Not a shell: `$HOME` is not expanded. |
| `PRIME_AGENT_ENV_*` | no | Forwarded to the agent with the prefix stripped: `PRIME_AGENT_ENV_ANTHROPIC_API_KEY` becomes `ANTHROPIC_API_KEY`. Opt-in by prefix, because an agent holding the Feishu secret could post as the bot and answer its own approvals. |
| `PRIME_HOME` | no | State directory. Default `~/.prime-gateway`. |
| `PRIME_DB` / `PRIME_DOWNLOAD_DIR` | no | Derived from `PRIME_HOME` unless set. |
| `PRIME_ALLOW_TALK` | no | Comma-separated `open_id`s that may prompt the agent. |
| `PRIME_ALLOW_OPERATE` | no | Comma-separated `open_id`s that may answer approvals and run mutating commands. |
| `PRIME_ALLOW_CHATS` | no | Comma-separated `chat_id`s. Empty means any chat. |
| `PRIME_ALLOW_DM` | no | Answer direct messages without a mention. Default on. |
| `PRIME_ALLOW_MENTION_ALL` | no | Treat `@all` as addressing the bot. Default **off**: `@all` is a room-wide notification, not an instruction. |
| `PRIME_MAX_LIVE_SESSIONS` | no | Concurrent agent processes. Default 8. |

**Empty means closed.** An unset allowlist is everyone-except-the-owner, not
no-restrictions.

### Chat commands

| Command | Tier | Effect |
|---|---|---|
| `/new` | operate | Fresh session in this thread, retiring the current one |
| `/sessions`, `/ls` | talk | Sessions bound in this chat |
| `/attach <session-id>` | operate | Bind this thread to an existing session |
| `/status` | talk | What this session is doing |
| `/stop`, `/cancel` | operate | Cancel the current turn |
| `/help` | talk | List commands |
| `/cd <path>` | operate | Declared, and honestly unavailable in this build — every session shares the one configured workspace |

Approvals are answered by clicking a card button, never by typing: the agent's blocked
`session/request_permission` call *is* the pending request, and a chat verb would be a
second way to mutate it with no capability the button doesn't already have.

## Repo layout

```
src/channel/lark/       adapter (send/edit/upload) and inbound (events -> router)
src/channel/            card writer, renderer, escaper
src/core/               router, session actor, registry, status projection, lanes
src/db/                 event log, sessions, turns, approvals, bindings, dedup
src/driver/acp/         ACP client: spawn, initialize, resume, prompt, permissions
src/policy/auth.ts      allowlist tiers and the silent-refusal rule
schema/                 migrations; the event log is the system of record
docs/architecture.md    full design document
docs/specs/             the Lark channel design
docs/testing/           crash matrix for the durability contract
```

## Tests

```bash
npm test          # unit: in-process, no network, no child processes
npm run test:e2e  # spawns a hand-written fake ACP agent over stdio
npm run typecheck
```

The e2e suite exists for the failures only a separate process produces — an agent that
exits mid-turn, one that refuses to initialize, one that advertises a capability it does
not have. It has already found two driver bugs that in-process doubles cannot reach.

## Reading order

1. [`docs/architecture.md`](docs/architecture.md) §0–§2 — thesis and layer model
2. §4 — the broker, and §4.6, the durability contract everything else rests on
3. §15 — build order. Milestones 1–4 are the durability guarantee; do not reorder.
4. [`docs/testing/durability.md`](docs/testing/durability.md) — what "it works" has to mean
5. [`docs/specs/2026-08-21-lark-channel-design.md`](docs/specs/2026-08-21-lark-channel-design.md)
   — the implemented slice, and the seams left for the deferred parts

## Protocol strategy

| Method | Preference |
|---|---|
| Agent with native ACP mode (`gemini --acp`) | primary |
| Agent via ACP adapter (`claude-agent-acp`, `codex-acp`) | primary |
| Structured CLI (`claude -p --output-format stream-json`) | fallback, registry key only |
| PTY / TUI scraping | last resort, actively deprecated |

ACP already specifies capability negotiation, sessions, streaming, cancellation, and
permission requests. We don't reinvent it.

## References

- [Agent Client Protocol](https://agentclientprotocol.com)
- [ACP agent registry](https://agentclientprotocol.com/get-started/agents)
- [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)

## License

TBD
