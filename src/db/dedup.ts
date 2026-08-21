import type { Db } from './open.js';
import { txImmediate } from './open.js';

export type SeenOutcome = 'accepted' | 'rejected' | 'ignored';

/** Feishu re-pushes at 15s / 5min / 1h / 6h, so the claim must outlive all of them. */
export const SEEN_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Claim a Feishu message_id exactly once, durably.
 *
 * Returns true if this process is the first to claim it, false if it was already
 * seen. The insert and the check are the same statement, so two concurrent
 * deliveries of the same message cannot both win.
 *
 * IMPORTANT: only ever pass a platform-stable id here. Never a payload-derived
 * key: distinct clicks of the same button legitimately repeat, and claiming
 * those would silently swallow the second click. Same delivery is deduped; same
 * intent is not.
 */
export function claimMessage(
  db: Db,
  messageId: string,
  chatId: string,
  now: number,
  outcome: SeenOutcome = 'accepted',
): boolean {
  return txImmediate(db, (d) => {
    const res = d
      .prepare(
        `INSERT INTO seen_messages (message_id, chat_id, first_seen_at, outcome)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(messageId, chatId, now, outcome);
    return res.changes === 1;
  });
}

/**
 * Record the outcome of a message we already claimed. Best-effort metadata for
 * operators; never consulted for control flow.
 */
export function recordOutcome(db: Db, messageId: string, outcome: SeenOutcome): void {
  txImmediate(db, (d) => {
    d.prepare('UPDATE seen_messages SET outcome = ? WHERE message_id = ?').run(outcome, messageId);
  });
}

export function sweepSeen(db: Db, now: number, ttlMs: number = SEEN_TTL_MS): number {
  return txImmediate(db, (d) => {
    const res = d.prepare('DELETE FROM seen_messages WHERE first_seen_at < ?').run(now - ttlMs);
    return res.changes;
  });
}

export function wasSeen(db: Db, messageId: string): boolean {
  const row = db
    .prepare<[string], { n: number }>('SELECT 1 AS n FROM seen_messages WHERE message_id = ?')
    .get(messageId);
  return row !== undefined;
}
