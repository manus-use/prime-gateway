import type { Db } from './open.js';
import { txImmediate } from './open.js';
import type { ApprovalRow, ApprovalState, PermissionOption } from '../types.js';

interface ApprovalRaw {
  approval_id: string;
  session_id: string;
  turn_id: string;
  generation: number;
  action: string;
  payload: string | Buffer | Uint8Array;
  options: string | Buffer | Uint8Array | null;
  state: string;
  option_id: string | null;
  outcome: string | null;
  resolved_by: string | null;
  resolved_via: string | null;
  card_message_id: string | null;
  created_at: number;
  parks_at: number;
  resolved_at: number | null;
}

function text(v: string | Buffer | Uint8Array | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
}

function decode(r: ApprovalRaw): ApprovalRow {
  const optionsText = text(r.options);
  return {
    approvalId: r.approval_id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    generation: r.generation,
    action: r.action,
    payload: JSON.parse(text(r.payload) ?? 'null') as unknown,
    options: optionsText === null ? [] : (JSON.parse(optionsText) as PermissionOption[]),
    state: r.state as ApprovalState,
    optionId: r.option_id,
    resolvedBy: r.resolved_by,
    resolvedVia: r.resolved_via,
    cardMessageId: r.card_message_id,
    createdAt: r.created_at,
    parksAt: r.parks_at,
    resolvedAt: r.resolved_at,
  };
}

const COLS = `approval_id, session_id, turn_id, generation, action, json(payload) AS payload,
              json(options) AS options, state, option_id, outcome, resolved_by, resolved_via,
              card_message_id, created_at, parks_at, resolved_at`;

/** How long before an unanswered approval is marked parked. Parking is not denial. */
export const PARK_AFTER_MS = 10 * 60 * 1000;

export function createApproval(
  db: Db,
  a: {
    approvalId: string;
    sessionId: string;
    turnId: string;
    generation: number;
    action: string;
    payload: unknown;
    options: readonly PermissionOption[];
  },
  now: number,
  parkAfterMs: number = PARK_AFTER_MS,
): ApprovalRow {
  return txImmediate(db, (d) => {
    d.prepare(
      `INSERT INTO approvals
         (approval_id, session_id, turn_id, generation, action, payload, options,
          state, created_at, parks_at)
       VALUES (?, ?, ?, ?, ?, jsonb(?), jsonb(?), 'pending', ?, ?)`,
    ).run(
      a.approvalId,
      a.sessionId,
      a.turnId,
      a.generation,
      a.action,
      JSON.stringify(a.payload ?? null),
      JSON.stringify(a.options),
      now,
      now + parkAfterMs,
    );
    const row = d
      .prepare<[string], ApprovalRaw>(`SELECT ${COLS} FROM approvals WHERE approval_id = ?`)
      .get(a.approvalId);
    if (row === undefined) throw new Error('createApproval wrote no row');
    return decode(row);
  });
}

export type ResolveResult =
  | { kind: 'resolved'; approval: ApprovalRow }
  /** Already resolved. Re-clicks are idempotent; the first answer stands. */
  | { kind: 'already'; approval: ApprovalRow }
  /** The card referred to a superseded generation. */
  | { kind: 'stale'; approval: ApprovalRow }
  | { kind: 'unknown' }
  /** The option id was not one the agent offered. */
  | { kind: 'bad_option'; approval: ApprovalRow };

/**
 * Resolve an approval, with a compare-and-swap on the generation.
 *
 * The CAS is the load-bearing part. A card's nonce proves only that the card
 * itself was not altered -- it can never prove that what the card points at is
 * still current, so the generation is re-checked against the log here. Without
 * it, a button clicked before a restart resolves a request that no longer exists
 * against a runtime that has already moved on.
 *
 * Idempotent by design: a second click returns `already` rather than overwriting.
 * That is what makes click -> crash -> click-after-restart safe.
 */
export function resolveApproval(
  db: Db,
  args: {
    approvalId: string;
    optionId: string;
    expectedGeneration: number;
    resolvedBy: string;
    resolvedVia: string;
  },
  now: number,
): ResolveResult {
  return txImmediate(db, (d) => {
    const row = d
      .prepare<[string], ApprovalRaw>(`SELECT ${COLS} FROM approvals WHERE approval_id = ?`)
      .get(args.approvalId);
    if (row === undefined) return { kind: 'unknown' };
    const approval = decode(row);

    if (approval.state === 'resolved') return { kind: 'already', approval };
    if (approval.generation !== args.expectedGeneration) return { kind: 'stale', approval };
    if (!approval.options.some((o) => o.optionId === args.optionId)) {
      return { kind: 'bad_option', approval };
    }

    d.prepare(
      `UPDATE approvals
          SET state = 'resolved', option_id = ?, outcome = ?, resolved_by = ?,
              resolved_via = ?, resolved_at = ?
        WHERE approval_id = ? AND state != 'resolved' AND generation = ?`,
    ).run(
      args.optionId,
      args.optionId,
      args.resolvedBy,
      args.resolvedVia,
      now,
      args.approvalId,
      args.expectedGeneration,
    );

    const after = d
      .prepare<[string], ApprovalRaw>(`SELECT ${COLS} FROM approvals WHERE approval_id = ?`)
      .get(args.approvalId);
    if (after === undefined) throw new Error('approval vanished mid-transaction');
    return { kind: 'resolved', approval: decode(after) };
  });
}

export function setApprovalCard(db: Db, approvalId: string, messageId: string): void {
  txImmediate(db, (d) => {
    d.prepare('UPDATE approvals SET card_message_id = ? WHERE approval_id = ?').run(
      messageId,
      approvalId,
    );
  });
}

export function getApproval(db: Db, approvalId: string): ApprovalRow | undefined {
  const row = db
    .prepare<[string], ApprovalRaw>(`SELECT ${COLS} FROM approvals WHERE approval_id = ?`)
    .get(approvalId);
  return row === undefined ? undefined : decode(row);
}

/**
 * The oldest unresolved approval for a session, if any.
 *
 * Used by the "plain text reply answers a pending approval" path, which needs a
 * single unambiguous target.
 */
export function oldestPending(db: Db, sessionId: string): ApprovalRow | undefined {
  const row = db
    .prepare<[string], ApprovalRaw>(
      `SELECT ${COLS} FROM approvals
        WHERE session_id = ? AND state IN ('pending','parked')
        ORDER BY created_at LIMIT 1`,
    )
    .get(sessionId);
  return row === undefined ? undefined : decode(row);
}

export function pendingForSession(db: Db, sessionId: string): ApprovalRow[] {
  return db
    .prepare<[string], ApprovalRaw>(
      `SELECT ${COLS} FROM approvals
        WHERE session_id = ? AND state IN ('pending','parked') ORDER BY created_at`,
    )
    .all(sessionId)
    .map(decode);
}

/**
 * Mark overdue approvals as parked.
 *
 * Parking is a visibility change, NOT a decision. There is no timeout-to-default:
 * defaulting to deny silently kills multi-day work, and defaulting to allow is
 * indefensible. A parked approval stays answerable forever.
 */
export function parkOverdue(db: Db, now: number): number {
  return txImmediate(db, (d) => {
    const res = d
      .prepare(`UPDATE approvals SET state = 'parked' WHERE state = 'pending' AND parks_at <= ?`)
      .run(now);
    return res.changes;
  });
}
