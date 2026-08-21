import type { Db } from './open.js';
import { txImmediate } from './open.js';
import type { BindingKey, BindingRow } from '../types.js';

interface BindingRaw {
  session_id: string;
  channel: string;
  account_id: string;
  conversation_id: string;
  thread_id: string;
  is_primary: number;
  cursor_seq: number;
  bound_at: number;
  revoked_at: number | null;
  active_card_id: string | null;
  active_message_id: string | null;
  card_created_at: number | null;
}

function decode(r: BindingRaw): BindingRow {
  return {
    sessionId: r.session_id,
    channel: r.channel,
    appId: r.account_id,
    conversationId: r.conversation_id,
    threadId: r.thread_id,
    isPrimary: r.is_primary === 1,
    cursorSeq: r.cursor_seq,
    boundAt: r.bound_at,
    revokedAt: r.revoked_at,
    activeCardId: r.active_card_id,
    activeMessageId: r.active_message_id,
    cardCreatedAt: r.card_created_at,
  };
}

/** `account_id` carries the bot's app id; see schema/002 for why there is no app_id column. */
const COLS = `session_id, channel, account_id, conversation_id, thread_id, is_primary,
              cursor_seq, bound_at, revoked_at, active_card_id, active_message_id, card_created_at`;

/**
 * Resolve a live binding.
 *
 * The key is recomputed on every call and never persisted as a key: session_id
 * is immutable and opaque, and the binding is the mutable mapping between it and
 * a place in a chat.
 *
 * `revoked_at IS NULL` is not optional. /new revokes rather than deletes, so a
 * redelivery arriving after a rotation must resolve to nothing rather than
 * resurrecting the rotated session.
 */
export function resolveBinding(db: Db, key: BindingKey): BindingRow | undefined {
  const row = db
    .prepare<[string, string, string, string], BindingRaw>(
      `SELECT ${COLS} FROM channel_bindings
        WHERE channel = ? AND account_id = ? AND conversation_id = ? AND thread_id = ?
          AND revoked_at IS NULL`,
    )
    .get(key.channel, key.appId, key.conversationId, key.threadId);
  return row === undefined ? undefined : decode(row);
}

export function bindSession(
  db: Db,
  key: BindingKey,
  sessionId: string,
  now: number,
  isPrimary = true,
): BindingRow {
  return txImmediate(db, (d) => {
    d.prepare(
      `INSERT INTO channel_bindings
         (session_id, channel, account_id, conversation_id, thread_id, is_primary, cursor_seq, bound_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(session_id, channel, conversation_id, thread_id) DO UPDATE SET
         revoked_at = NULL, account_id = excluded.account_id, bound_at = excluded.bound_at`,
    ).run(
      sessionId,
      key.channel,
      key.appId,
      key.conversationId,
      key.threadId,
      isPrimary ? 1 : 0,
      now,
    );
    const row = d
      .prepare<[string, string, string, string, string], BindingRaw>(
        `SELECT ${COLS} FROM channel_bindings
          WHERE session_id = ? AND channel = ? AND account_id = ? AND conversation_id = ? AND thread_id = ?`,
      )
      .get(sessionId, key.channel, key.appId, key.conversationId, key.threadId);
    if (row === undefined) throw new Error('bindSession wrote no row');
    return decode(row);
  });
}

/** Revoke every live binding at this location. /new, /attach. */
export function revokeBindingsAt(db: Db, key: BindingKey, now: number): number {
  return txImmediate(db, (d) => {
    const res = d
      .prepare(
        `UPDATE channel_bindings SET revoked_at = ?
          WHERE channel = ? AND account_id = ? AND conversation_id = ? AND thread_id = ?
            AND revoked_at IS NULL`,
      )
      .run(now, key.channel, key.appId, key.conversationId, key.threadId);
    return res.changes;
  });
}

/**
 * Advance a channel's render cursor, monotonically.
 *
 * `max(cursor_seq, ?)` rather than a plain assignment: renders can complete out
 * of order, and a late-finishing older render must not walk the cursor
 * backwards and cause the newer output to be re-rendered.
 */
export function advanceCursor(db: Db, key: BindingKey, sessionId: string, seq: number): void {
  txImmediate(db, (d) => {
    d.prepare(
      `UPDATE channel_bindings SET cursor_seq = max(cursor_seq, ?)
        WHERE session_id = ? AND channel = ? AND account_id = ? AND conversation_id = ? AND thread_id = ?`,
    ).run(seq, sessionId, key.channel, key.appId, key.conversationId, key.threadId);
  });
}

export function setActiveCard(
  db: Db,
  key: BindingKey,
  sessionId: string,
  card: { cardId: string | null; messageId: string | null; createdAt: number | null },
): void {
  txImmediate(db, (d) => {
    d.prepare(
      `UPDATE channel_bindings
          SET active_card_id = ?, active_message_id = ?, card_created_at = ?
        WHERE session_id = ? AND channel = ? AND account_id = ? AND conversation_id = ? AND thread_id = ?`,
    ).run(
      card.cardId,
      card.messageId,
      card.createdAt,
      sessionId,
      key.channel,
      key.appId,
      key.conversationId,
      key.threadId,
    );
  });
}

/**
 * Clear the active card, but only if `messageId` is still the active one.
 *
 * The guard is the point. A 230011 (withdrawn) for a card we have already
 * rotated past would otherwise clear a perfectly good current card and force a
 * pointless re-render.
 */
export function clearActiveCardIfCurrent(db: Db, sessionId: string, messageId: string): boolean {
  return txImmediate(db, (d) => {
    const res = d
      .prepare(
        `UPDATE channel_bindings
            SET active_card_id = NULL, active_message_id = NULL, card_created_at = NULL
          WHERE session_id = ? AND active_message_id = ?`,
      )
      .run(sessionId, messageId);
    return res.changes > 0;
  });
}

export function bindingsForSession(db: Db, sessionId: string): BindingRow[] {
  return db
    .prepare<[string], BindingRaw>(
      `SELECT ${COLS} FROM channel_bindings WHERE session_id = ? AND revoked_at IS NULL`,
    )
    .all(sessionId)
    .map(decode);
}

export function bindingsInConversation(
  db: Db,
  channel: string,
  appId: string,
  conversationId: string,
): BindingRow[] {
  return db
    .prepare<[string, string, string], BindingRaw>(
      `SELECT ${COLS} FROM channel_bindings
        WHERE channel = ? AND account_id = ? AND conversation_id = ? AND revoked_at IS NULL
        ORDER BY bound_at DESC`,
    )
    .all(channel, appId, conversationId)
    .map(decode);
}
