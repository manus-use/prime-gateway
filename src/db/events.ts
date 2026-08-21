import type { Db } from './open.js';
import { txImmediate } from './open.js';
import type { Event, NewEvent } from '../types.js';

interface EventRowRaw {
  session_id: string;
  seq: number;
  ts: number;
  generation: number;
  broker_seq: number | null;
  turn_id: string | null;
  type: string;
  actor: string;
  /** `json(payload)` yields TEXT; a legacy row could still be a raw blob. */
  payload: string | Buffer | Uint8Array;
}

function decode(r: EventRowRaw): Event {
  const text = typeof r.payload === 'string' ? r.payload : Buffer.from(r.payload).toString('utf8');
  return {
    sessionId: r.session_id,
    seq: r.seq,
    ts: r.ts,
    generation: r.generation,
    brokerSeq: r.broker_seq,
    turnId: r.turn_id,
    type: r.type as Event['type'],
    actor: r.actor as Event['actor'],
    payload: JSON.parse(text) as unknown,
  };
}

/**
 * Append events to a session's log and advance `sessions.last_seq`.
 *
 * seq is assigned inside the write transaction from last_seq, so two concurrent
 * appends cannot pick the same number. Callers never choose seq.
 *
 * Returns the appended events with their assigned seq.
 */
export function appendEvents(db: Db, sessionId: string, events: readonly NewEvent[], now: number): Event[] {
  if (events.length === 0) return [];
  return txImmediate(db, (d) => {
    const cur = d
      .prepare<[string], { last_seq: number; generation: number }>(
        'SELECT last_seq, generation FROM sessions WHERE id = ?',
      )
      .get(sessionId);
    if (cur === undefined) throw new Error(`append to unknown session ${sessionId}`);

    const insert = d.prepare(
      `INSERT INTO events (session_id, seq, ts, generation, broker_seq, turn_id, type, actor, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, jsonb(?))`,
    );

    let seq = cur.last_seq;
    const out: Event[] = [];
    for (const e of events) {
      seq += 1;
      const row: Event = {
        sessionId,
        seq,
        ts: e.ts ?? now,
        generation: e.generation ?? cur.generation,
        brokerSeq: e.brokerSeq ?? null,
        turnId: e.turnId ?? null,
        type: e.type,
        actor: e.actor,
        payload: e.payload,
      };
      insert.run(
        row.sessionId,
        row.seq,
        row.ts,
        row.generation,
        row.brokerSeq,
        row.turnId,
        row.type,
        row.actor,
        JSON.stringify(row.payload ?? null),
      );
      out.push(row);
    }

    d.prepare('UPDATE sessions SET last_seq = ?, last_activity_at = ? WHERE id = ?').run(
      seq,
      now,
      sessionId,
    );
    return out;
  });
}

export function appendEvent(db: Db, sessionId: string, event: NewEvent, now: number): Event {
  const [only] = appendEvents(db, sessionId, [event], now);
  if (only === undefined) throw new Error('appendEvents returned nothing for a single event');
  return only;
}

/** Events with `seq` in (afterSeq, throughSeq]. The renderer's only read path. */
export function readEvents(
  db: Db,
  sessionId: string,
  afterSeq: number,
  throughSeq: number,
): Event[] {
  if (throughSeq <= afterSeq) return [];
  const rows = db
    .prepare<[string, number, number], EventRowRaw>(
      `SELECT session_id, seq, ts, generation, broker_seq, turn_id, type, actor, json(payload) AS payload
         FROM events
        WHERE session_id = ? AND seq > ? AND seq <= ?
        ORDER BY seq`,
    )
    .all(sessionId, afterSeq, throughSeq);
  return rows.map(decode);
}

export function lastSeq(db: Db, sessionId: string): number {
  const row = db
    .prepare<[string], { last_seq: number }>('SELECT last_seq FROM sessions WHERE id = ?')
    .get(sessionId);
  return row?.last_seq ?? 0;
}
