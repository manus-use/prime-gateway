-- prime-gateway initial schema
-- SQLite, WAL mode. See docs/architecture.md §3.
--
-- PRAGMAs to set on every connection:
--   PRAGMA journal_mode = WAL;
--   PRAGMA foreign_keys = ON;
--   PRAGMA busy_timeout = 1000;        -- NOT the 30s default; see §3.7
--   PRAGMA synchronous = NORMAL;

-- ---------------------------------------------------------------------------
-- Event log: the system of record. Append-only. Never updated, never deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  session_id    TEXT    NOT NULL,
  seq           INTEGER NOT NULL,   -- monotonic per session, gateway-assigned
  ts            INTEGER NOT NULL,   -- unix millis
  generation    INTEGER NOT NULL,   -- runtime incarnation that produced this
  broker_seq    INTEGER,            -- broker-assigned; NULL for gateway-origin events
  turn_id       TEXT,               -- NULL for session-level events
  type          TEXT    NOT NULL,
  actor         TEXT    NOT NULL,   -- user | agent | gateway | policy
  payload       BLOB    NOT NULL,   -- JSON
  PRIMARY KEY (session_id, seq)
) STRICT;

-- Idempotent ingest of the broker spool: the same (generation, broker_seq)
-- can be replayed any number of times and will land exactly once.
CREATE UNIQUE INDEX idx_events_broker_dedup
  ON events(session_id, generation, broker_seq)
  WHERE broker_seq IS NOT NULL;

CREATE INDEX idx_events_turn ON events(session_id, turn_id, seq);
CREATE INDEX idx_events_type ON events(session_id, type, seq);

-- ---------------------------------------------------------------------------
-- Sessions: a projection over `events` with a durability guarantee.
-- Rebuildable from the log at any time. Exists so you can query it.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  workspace_id         TEXT NOT NULL,
  owner_principal      TEXT NOT NULL,
  state                TEXT NOT NULL,   -- initializing | live | idle | blocked
                                        -- | cold | archived | unknown | terminated
  title                TEXT,

  generation           INTEGER NOT NULL DEFAULT 0,
  provider_session_id  TEXT,            -- OBSERVED from the agent, updated continuously.
                                        -- Never persist the value you sent.
  execution_handle     TEXT,            -- derived durable string, NEVER a PID
  execution_backend    TEXT,            -- process | tmux | container | remote

  parent_session_id    TEXT REFERENCES sessions(id),  -- lineage on compaction split
  fork_of_session_id   TEXT REFERENCES sessions(id),

  last_seq             INTEGER NOT NULL DEFAULT 0,
  last_ingested_offset INTEGER NOT NULL DEFAULT 0,    -- byte offset into the spool
  snapshot_seq         INTEGER NOT NULL DEFAULT 0,

  created_at           INTEGER NOT NULL,
  last_activity_at     INTEGER NOT NULL,
  cold_at              INTEGER,

  cost_usd             REAL    NOT NULL DEFAULT 0,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_sessions_state  ON sessions(state, last_activity_at);
CREATE INDEX idx_sessions_owner  ON sessions(owner_principal, last_activity_at DESC);
CREATE INDEX idx_sessions_ws     ON sessions(workspace_id);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);

-- Titles are scoped, not globally unique.
CREATE UNIQUE INDEX idx_sessions_title
  ON sessions(owner_principal, title) WHERE title IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Channel bindings. The session ID must NEVER encode the channel; inbound
-- resolution is a lookup here, not a string construction.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_bindings (
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  channel          TEXT NOT NULL,   -- telegram | web | slack | rest | cli
  account_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  thread_id        TEXT NOT NULL DEFAULT '',
  is_primary       INTEGER NOT NULL DEFAULT 0,
  cursor_seq       INTEGER NOT NULL DEFAULT 0,   -- how far this channel has rendered
  bound_at         INTEGER NOT NULL,
  PRIMARY KEY (session_id, channel, conversation_id, thread_id)
) STRICT;

CREATE INDEX idx_bindings_lookup
  ON channel_bindings(channel, conversation_id, thread_id);

-- ---------------------------------------------------------------------------
-- Turns
-- ---------------------------------------------------------------------------
CREATE TABLE turns (
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  turn_id          TEXT NOT NULL,
  generation       INTEGER NOT NULL,
  idempotency_key  TEXT NOT NULL,
  state            TEXT NOT NULL,   -- pending | delivering | running | awaiting_approval
                                    -- | completed | failed | cancelled | indeterminate
  submitted_at     INTEGER NOT NULL,
  ended_at         INTEGER,
  PRIMARY KEY (session_id, turn_id)
) STRICT;

CREATE UNIQUE INDEX idx_turns_idem ON turns(session_id, idempotency_key);
CREATE INDEX idx_turns_open ON turns(session_id, state)
  WHERE state IN ('pending','delivering','running','awaiting_approval');

-- ---------------------------------------------------------------------------
-- Approvals. Timeout parks; it does not deny. Denial is an explicit act.
-- ---------------------------------------------------------------------------
CREATE TABLE approvals (
  approval_id   TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  turn_id       TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  action        TEXT NOT NULL,
  payload       BLOB NOT NULL,
  state         TEXT NOT NULL,   -- pending | parked | resolved
  outcome       TEXT,            -- allow | allow_always | deny | cancelled
  resolved_by   TEXT,
  resolved_via  TEXT,            -- which channel answered
  created_at    INTEGER NOT NULL,
  parks_at      INTEGER NOT NULL,
  resolved_at   INTEGER
) STRICT;

CREATE INDEX idx_approvals_pending ON approvals(state, parks_at)
  WHERE state IN ('pending','parked');

-- ---------------------------------------------------------------------------
-- Workspaces. root_path is immutable for the workspace's lifetime: provider
-- session lookup is project-directory-scoped, so relocating orphans the session.
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,   -- git-worktree | plain-dir | volume
  root_path     TEXT NOT NULL,
  repo_root     TEXT,
  branch        TEXT,
  lock_holder   TEXT REFERENCES sessions(id),
  created_at    INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- Snapshots. current = snapshot(max seq <= K) + replay(events > K).
-- Bounds reconnect and cold-rehydrate cost on long-lived sessions.
-- ---------------------------------------------------------------------------
CREATE TABLE snapshots (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,
  state       BLOB NOT NULL,   -- JSON
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;

-- ---------------------------------------------------------------------------
CREATE TABLE schema_version (
  version INTEGER NOT NULL
) STRICT;
INSERT INTO schema_version(version) VALUES (1);
