import type { Db } from './open.js';
import { txImmediate } from './open.js';
import type { TurnRow, TurnState, TurnTerminal } from '../types.js';

interface TurnRaw {
  session_id: string;
  turn_id: string;
  generation: number;
  idempotency_key: string;
  state: string;
  terminal: string | null;
  fence: string | null;
  submitted_at: number;
  ended_at: number | null;
}

function decode(r: TurnRaw): TurnRow {
  return {
    sessionId: r.session_id,
    turnId: r.turn_id,
    generation: r.generation,
    idempotencyKey: r.idempotency_key,
    state: r.state as TurnState,
    terminal: r.terminal as TurnTerminal | null,
    fence: r.fence,
    submittedAt: r.submitted_at,
    endedAt: r.ended_at,
  };
}

const COLS = `session_id, turn_id, generation, idempotency_key, state, terminal, fence,
              submitted_at, ended_at`;

const OPEN_STATES = ['pending', 'delivering', 'running', 'awaiting_approval'] as const;

/**
 * Create a turn, or return the existing one for the same idempotency key.
 *
 * The uniqueness is on (session_id, idempotency_key), so a redelivered inbound
 * message that got past dedup for any reason still cannot open a second turn.
 */
export function createTurn(
  db: Db,
  t: { sessionId: string; turnId: string; generation: number; idempotencyKey: string },
  now: number,
): { turn: TurnRow; created: boolean } {
  return txImmediate(db, (d) => {
    const existing = d
      .prepare<[string, string], TurnRaw>(
        `SELECT ${COLS} FROM turns WHERE session_id = ? AND idempotency_key = ?`,
      )
      .get(t.sessionId, t.idempotencyKey);
    if (existing !== undefined) return { turn: decode(existing), created: false };

    d.prepare(
      `INSERT INTO turns (session_id, turn_id, generation, idempotency_key, state, submitted_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(t.sessionId, t.turnId, t.generation, t.idempotencyKey, now);

    const row = d
      .prepare<[string, string], TurnRaw>(`SELECT ${COLS} FROM turns WHERE session_id = ? AND turn_id = ?`)
      .get(t.sessionId, t.turnId);
    if (row === undefined) throw new Error('createTurn wrote no row');
    return { turn: decode(row), created: true };
  });
}

export function setTurnState(db: Db, sessionId: string, turnId: string, state: TurnState): void {
  txImmediate(db, (d) => {
    d.prepare('UPDATE turns SET state = ? WHERE session_id = ? AND turn_id = ?').run(
      state,
      sessionId,
      turnId,
    );
  });
}

/**
 * Close a turn with an evidence-graded terminal.
 *
 * `terminal` is decoupled from whatever text was displayed. Empty output is a
 * terminal; cancellation is a terminal, not a deletion; and `ambiguous` records
 * that we could not establish whether the prompt was consumed -- which is a
 * distinct fact from failure, and the one that gates quarantine.
 */
export function endTurn(
  db: Db,
  sessionId: string,
  turnId: string,
  terminal: TurnTerminal,
  now: number,
  fence?: string,
): void {
  const state: TurnState =
    terminal === 'completed'
      ? 'completed'
      : terminal === 'failed'
        ? 'failed'
        : terminal === 'cancelled'
          ? 'cancelled'
          : 'indeterminate';
  txImmediate(db, (d) => {
    d.prepare(
      `UPDATE turns SET state = ?, terminal = ?, ended_at = ?, fence = COALESCE(?, fence)
        WHERE session_id = ? AND turn_id = ?`,
    ).run(state, terminal, now, fence ?? null, sessionId, turnId);
  });
}

export function getTurn(db: Db, sessionId: string, turnId: string): TurnRow | undefined {
  const row = db
    .prepare<[string, string], TurnRaw>(`SELECT ${COLS} FROM turns WHERE session_id = ? AND turn_id = ?`)
    .get(sessionId, turnId);
  return row === undefined ? undefined : decode(row);
}

export function openTurns(db: Db, sessionId: string): TurnRow[] {
  const holes = OPEN_STATES.map(() => '?').join(',');
  return db
    .prepare<string[], TurnRaw>(
      `SELECT ${COLS} FROM turns WHERE session_id = ? AND state IN (${holes}) ORDER BY submitted_at`,
    )
    .all(sessionId, ...OPEN_STATES)
    .map(decode);
}

/** Turns left open by a crash, across all sessions. Boot reconciliation input. */
export function allOpenTurns(db: Db): TurnRow[] {
  const holes = OPEN_STATES.map(() => '?').join(',');
  return db
    .prepare<string[], TurnRaw>(`SELECT ${COLS} FROM turns WHERE state IN (${holes})`)
    .all(...OPEN_STATES)
    .map(decode);
}
