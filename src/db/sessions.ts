import type { Db } from './open.js';
import { txImmediate } from './open.js';
import type { SessionRow, SessionState } from '../types.js';

interface SessionRaw {
  id: string;
  agent_id: string;
  workspace_id: string;
  owner_principal: string;
  state: string;
  title: string | null;
  generation: number;
  provider_session_id: string | null;
  execution_handle: string | null;
  execution_backend: string | null;
  last_seq: number;
  created_at: number;
  last_activity_at: number;
  cold_at: number | null;
}

function decode(r: SessionRaw): SessionRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    workspaceId: r.workspace_id,
    ownerPrincipal: r.owner_principal,
    state: r.state as SessionState,
    title: r.title,
    generation: r.generation,
    providerSessionId: r.provider_session_id,
    executionHandle: r.execution_handle,
    executionBackend: r.execution_backend,
    lastSeq: r.last_seq,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
    coldAt: r.cold_at,
  };
}

const COLS = `id, agent_id, workspace_id, owner_principal, state, title, generation,
              provider_session_id, execution_handle, execution_backend, last_seq,
              created_at, last_activity_at, cold_at`;

export function getSession(db: Db, id: string): SessionRow | undefined {
  const row = db.prepare<[string], SessionRaw>(`SELECT ${COLS} FROM sessions WHERE id = ?`).get(id);
  return row === undefined ? undefined : decode(row);
}

export function createSession(
  db: Db,
  s: {
    id: string;
    agentId: string;
    workspaceId: string;
    ownerPrincipal: string;
    title?: string | null;
  },
  now: number,
): SessionRow {
  return txImmediate(db, (d) => {
    d.prepare(
      `INSERT INTO sessions
         (id, agent_id, workspace_id, owner_principal, state, title, generation,
          last_seq, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, 'initializing', ?, 0, 0, ?, ?)`,
    ).run(s.id, s.agentId, s.workspaceId, s.ownerPrincipal, s.title ?? null, now, now);
    const row = d.prepare<[string], SessionRaw>(`SELECT ${COLS} FROM sessions WHERE id = ?`).get(s.id);
    if (row === undefined) throw new Error('createSession wrote no row');
    return decode(row);
  });
}

export function setState(db: Db, id: string, state: SessionState, now: number): void {
  txImmediate(db, (d) => {
    d.prepare(
      `UPDATE sessions SET state = ?, last_activity_at = ?,
              cold_at = CASE WHEN ? IN ('cold','quarantined') THEN ? ELSE NULL END
        WHERE id = ?`,
    ).run(state, now, state, now, id);
  });
}

/**
 * Provider session id is OBSERVED, never assumed.
 *
 * Agents generate their own internal id for persistence, and it can rotate
 * mid-process. So this is called on every sighting and always stores what the
 * agent just told us -- never the value we sent it.
 */
export function observeProviderSessionId(db: Db, id: string, providerSessionId: string): void {
  txImmediate(db, (d) => {
    d.prepare('UPDATE sessions SET provider_session_id = ? WHERE id = ?').run(providerSessionId, id);
  });
}

/**
 * Bump the generation and return the new value.
 *
 * The generation is a fencing token: it is bumped BEFORE teardown, so any
 * in-flight callback or timer that revalidates its generation after an await
 * discovers it is stale and declines to act. Every restart, /new, and workspace
 * repin goes through here.
 */
export function bumpGeneration(db: Db, id: string): number {
  return txImmediate(db, (d) => {
    d.prepare('UPDATE sessions SET generation = generation + 1 WHERE id = ?').run(id);
    const row = d
      .prepare<[string], { generation: number }>('SELECT generation FROM sessions WHERE id = ?')
      .get(id);
    if (row === undefined) throw new Error(`bumpGeneration on unknown session ${id}`);
    return row.generation;
  });
}

export function setExecution(
  db: Db,
  id: string,
  handle: string | null,
  backend: string | null,
): void {
  txImmediate(db, (d) => {
    d.prepare('UPDATE sessions SET execution_handle = ?, execution_backend = ? WHERE id = ?').run(
      handle,
      backend,
      id,
    );
  });
}

export function listSessionsByState(db: Db, states: readonly SessionState[]): SessionRow[] {
  if (states.length === 0) return [];
  const holes = states.map(() => '?').join(',');
  return db
    .prepare<string[], SessionRaw>(
      `SELECT ${COLS} FROM sessions WHERE state IN (${holes}) ORDER BY last_activity_at DESC`,
    )
    .all(...states)
    .map(decode);
}
