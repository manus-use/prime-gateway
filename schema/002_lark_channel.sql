-- prime-gateway migration 002: Lark channel
-- See docs/specs/2026-08-21-lark-channel-design.md §2.

-- ---------------------------------------------------------------------------
-- Durable inbound dedup.
--
-- The Lark SDK ACKs on receipt, so anything we drop is never redelivered.
-- In-memory dedup cannot survive a restart, and Feishu's redelivery ladder
-- runs 15s / 5min / 1h / 6h. Swept at 8h.
--
-- Keyed on message_id, NEVER event_id: message_id is stable across re-pushes,
-- event_id re-mints. Only platform-stable ids are ever claimed here --
-- payload-derived keys must not be, because distinct clicks of the same
-- button legitimately repeat. Same delivery is deduped; same intent is not.
-- ---------------------------------------------------------------------------
CREATE TABLE seen_messages (
  message_id    TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  outcome       TEXT NOT NULL    -- accepted | rejected | ignored
) STRICT;

CREATE INDEX idx_seen_sweep ON seen_messages(first_seen_at);

-- ---------------------------------------------------------------------------
-- channel_bindings additions.
--
-- No app_id column is added: the existing `account_id` already means "which
-- account of this channel", which for Lark is the bot's app id. That column is
-- what lets N bots coexist in one chat without collision -- two bots
-- @-mentioned in one message get two sessions -- so the only change needed is
-- to put it in the lookup index, which 001 did not.
-- ---------------------------------------------------------------------------

-- /new revokes rather than deletes, so a late redelivery resolves to the
-- revoked binding and is discarded instead of resurrecting a rotated session.
ALTER TABLE channel_bindings ADD COLUMN revoked_at INTEGER;

-- cardkit entities expire after 14 days. Past ~13 days, or on error 200750,
-- mint a fresh card and continue from cursor_seq.
ALTER TABLE channel_bindings ADD COLUMN active_card_id  TEXT;
ALTER TABLE channel_bindings ADD COLUMN active_message_id TEXT;
ALTER TABLE channel_bindings ADD COLUMN card_created_at INTEGER;

-- Inbound resolution keys on the bot too, and only ever considers live bindings.
DROP INDEX IF EXISTS idx_bindings_lookup;
CREATE INDEX idx_bindings_lookup
  ON channel_bindings(channel, account_id, conversation_id, thread_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- approvals additions.
--
-- ACP supplies options: Array<{optionId, name, kind}>. Buttons are generated
-- from the agent's own option set -- hardcoding allow/deny invents outcomes
-- the agent did not offer and drops ones it did.
-- ---------------------------------------------------------------------------
ALTER TABLE approvals ADD COLUMN option_id TEXT;
ALTER TABLE approvals ADD COLUMN options   BLOB;   -- JSON array, as offered

-- The card that carries this approval, so a resolution can freeze it.
ALTER TABLE approvals ADD COLUMN card_message_id TEXT;

-- ---------------------------------------------------------------------------
-- Turn terminals are evidence-graded, not boolean. Non-empty final text is
-- not a reliable completion contract; empty output is a terminal; cancellation
-- is a terminal, not a deletion.
-- ---------------------------------------------------------------------------
ALTER TABLE turns ADD COLUMN terminal TEXT;   -- completed | failed | cancelled | ambiguous
ALTER TABLE turns ADD COLUMN fence    TEXT;   -- set when delivery was ambiguous

UPDATE schema_version SET version = 2;
