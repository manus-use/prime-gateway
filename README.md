# prime-gateway

A vendor-neutral gateway for driving coding agents (Claude Code, Gemini CLI, Codex, and any
other ACP-compatible agent) from any channel — Telegram, web, Slack, REST.

**Status:** design phase. No implementation yet. See [`docs/architecture.md`](docs/architecture.md).

## What it is

prime-gateway does not implement an agent loop. It launches real vendor agent runtimes and
speaks a structured protocol to them, while owning the things the vendors don't:

- **Durable sessions** that survive gateway restart, agent crash, and weeks of idleness
- **Multi-channel access** — one session drivable from Telegram and web simultaneously
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

## Protocol strategy

| Method | Preference |
|---|---|
| Agent with native ACP mode (`gemini --acp`) | primary |
| Agent via ACP adapter (`claude-agent-acp`, `codex-acp`) | primary |
| Structured CLI (`claude -p --output-format stream-json`) | fallback |
| PTY / TUI scraping | last resort, actively deprecated |

ACP already specifies capability negotiation, sessions, streaming, cancellation, and
permission requests. We don't reinvent it.

## Repo layout

```
docs/architecture.md         full design document
docs/testing/durability.md   crash matrix for the durability contract
schema/001_initial.sql       event log + session schema
```

## Reading order

1. [`docs/architecture.md`](docs/architecture.md) §0–§2 — thesis and layer model
2. §4 — the broker, and §4.6, the durability contract everything else rests on
3. §15 — build order. Milestones 1–4 are the durability guarantee; do not reorder.
4. [`docs/testing/durability.md`](docs/testing/durability.md) — what "it works" has to mean

## References

- [Agent Client Protocol](https://agentclientprotocol.com)
- [ACP agent registry](https://agentclientprotocol.com/get-started/agents)
- [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)

## License

TBD
