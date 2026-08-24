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

Settings live in a YAML file; credentials live in the environment. Start from
[`config.example.yaml`](config.example.yaml):

```bash
cp config.example.yaml ~/.prime-gateway/config.yaml
export LARK_APP_SECRET=...
```

`PGW_CONFIG` names the file if you keep it elsewhere; otherwise it is
`$PGW_HOME/config.yaml`, default `~/.prime-gateway/config.yaml`. A file that is named but
missing is an error, while the default location being absent is an ordinary
environment-only deploy.

**Credentials never go in the file.** The agent runs as the same user and is not sandboxed
in this build, so anything on disk it can read. The environment is not airtight either — a
same-uid process can read `/proc/<pid>/environ` on Linux — but it does not persist, is not
backed up, cannot be copied into a worktree, and cannot be committed by accident. A key
that looks like a credential (`secret`, `token`, `password`, `apiKey`, …) is refused at
boot rather than quietly accepted, and so is `agent.env`, which would put values in the
file rather than names.

| File setting | Env override | Meaning |
|---|---|---|
| — | `LARK_APP_SECRET` **(required)** | The app secret. Environment only; never written to disk or the event log. |
| `lark.appId` | `LARK_APP_ID` | App id. Required from one source or the other. |
| `lark.domain` | `LARK_DOMAIN` | Set for Lark (`https://open.larksuite.com`); omitted means Feishu. |
| `auth.owner` | `PGW_OWNER_OPEN_ID` | Your `open_id`. Required. Always in both allowlists — an allowlist that excludes the owner locks out the only person who can fix it. |
| `auth.talk` | `PGW_ALLOW_TALK` | `open_id`s that may prompt the agent. |
| `auth.operate` | `PGW_ALLOW_OPERATE` | `open_id`s that may answer approvals and run mutating commands. |
| `auth.chats` | `PGW_ALLOW_CHATS` | `chat_id`s the bot will work in. Empty means any chat it was added to. |
| `auth.directMessages` | `PGW_ALLOW_DM` | Answer direct messages without a mention. Default on. |
| `auth.mentionAll` | `PGW_ALLOW_MENTION_ALL` | Treat `@all` as addressing the bot. Default **off**: `@all` is a room-wide notification, not an instruction. |
| `workspace` | `PGW_WORKSPACE` | Absolute path the agent works in. Required. |
| `agent.driver` | `PGW_AGENT_DRIVER` | `acp` (default) or `structured-cli`. See [Protocol strategy](#protocol-strategy) — the CLI driver cannot ask before acting. |
| `agent.command` | `PGW_AGENT_COMMAND` | The agent binary, e.g. `claude-agent-acp`. Required. |
| `agent.args` | `PGW_AGENT_ARGS` | A list, or one string split on whitespace with quotes honoured. Not a shell: `$HOME` is not expanded, because the agent is spawned with `shell: false`. |
| `agent.unsupervised` | `PGW_AGENT_UNSUPERVISED` | Required by, and only by, `structured-cli`: a written acknowledgement that the agent acts with no approval card and no gate from `auth.operate`. Setting it alongside the `acp` driver is an error — a config must not claim a posture the gateway is not in. |
| `agent.passEnv` | — | Variable **names** forwarded to the agent from the gateway's own environment. A name that is not set is an error, because forwarding nothing surfaces later as the agent failing to authenticate. Leave it empty for a subscription-authenticated agent: its credentials are under `$HOME`, which is forwarded already. |
| — | `PGW_AGENT_ENV_*` | Forwarded with the prefix stripped: `PGW_AGENT_ENV_ANTHROPIC_API_KEY` becomes `ANTHROPIC_API_KEY`. Wins over `passEnv`. Opt-in by prefix, because an agent holding the Feishu secret could post as the bot and answer its own approvals. |
| `maxLiveSessions` | `PGW_MAX_LIVE_SESSIONS` | Concurrent agent processes. Default 8. |
| `db`, `downloads` | `PGW_DB`, `PGW_DOWNLOAD_DIR` | Derived from `PGW_HOME` unless set. |
| — | `PGW_HOME` | State directory, and where the config file is looked for. Default `~/.prime-gateway`. |

Three rules make a mistake fail loudly instead of silently:

- **The environment wins.** Every file setting has an override, so a container needs no
  file and an emergency lockdown needs no edit. Lists are *replaced*, not merged — merging
  would leave no way to revoke. `PGW_ALLOW_TALK=` set-but-empty means the owner alone.
- **Empty means closed.** An unset allowlist is everyone-except-the-owner, not
  no-restrictions.
- **An unknown key is an error.** A typo'd setting silently taking its default is how a
  value someone deliberately changed turns out never to have applied — and for the auth
  keys that failure is silent *and* permissive.

Everything is validated at boot; a configuration mistake prints one line and exits 78.

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
src/driver/cli/         CLI fallback: one process per turn, argv in, NDJSON out
src/policy/auth.ts      allowlist tiers and the silent-refusal rule
src/config.ts           the file/environment split, validated at boot
schema/                 migrations; the event log is the system of record
docs/architecture.md    full design document
docs/specs/             the Lark channel design
docs/testing/           crash matrix for the durability contract
```

## Tests

```bash
npm test          # unit: in-process, no network, no child processes
npm run test:e2e  # spawns hand-written fake agents, one per driver
npm run typecheck
```

The e2e suite exists for the failures only a separate process produces — an agent that
exits mid-turn, one that refuses to initialize, one that advertises a capability it does
not have, one that writes its logger output onto the same stdout it streams events on.
It has already found two driver bugs that in-process doubles cannot reach.

## Reading order

1. [`docs/architecture.md`](docs/architecture.md) §0–§2 — thesis and layer model
2. §4 — the broker, and §4.6, the durability contract everything else rests on
3. §15 — build order. Milestones 1–4 are the durability guarantee; do not reorder.
4. [`docs/testing/durability.md`](docs/testing/durability.md) — what "it works" has to mean
5. [`docs/specs/2026-08-21-lark-channel-design.md`](docs/specs/2026-08-21-lark-channel-design.md)
   — the implemented slice, and the seams left for the deferred parts

## Protocol strategy

| Method | Driver | Preference |
|---|---|---|
| Agent with native ACP mode (`gemini --acp`) | `acp` | primary |
| Agent via ACP adapter (`claude-agent-acp`, `codex-acp`) | `acp` | primary |
| Structured CLI (`bytesec run --format json`) | `structured-cli` | fallback |
| PTY / TUI scraping | — | last resort, actively deprecated |

ACP already specifies capability negotiation, sessions, streaming, cancellation, and
permission requests. We don't reinvent it.

The CLI driver exists because an agent's ACP server can be broken while its command
line works perfectly, and being unable to talk to an agent at all is worse than
talking to it badly. It is a genuinely worse thing, in three specific ways:

- **No approvals.** A command line has no permission protocol — the agent never asks,
  it just acts. Approval cards stop appearing and the `operate` tier stops gating tool
  use. That is a security posture, not a rough edge, which is why `agent.unsupervised`
  has to be written down before this driver will load.
- **No resume.** Each turn is a fresh process with a fresh agent session, and the ids
  it mints cannot be handed back. Continuity is reconstructed by composing the
  conversation into the prompt as a fenced transcript, so the agent recovers what was
  *said* but not the tool state behind it — and pays input tokens for it every turn.
  Sessions started this way report `replayed`, never `resumed`.
- **No cooperative cancel.** Cancelling kills the process, so work already done stands.

Everything specific to a protocol stops at its driver. Adding the second one required
no change to `src/driver/types.ts`, which is the return on declaring that seam while
there was only one implementation behind it.

## References

- [Agent Client Protocol](https://agentclientprotocol.com)
- [ACP agent registry](https://agentclientprotocol.com/get-started/agents)
- [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)

## License

TBD
