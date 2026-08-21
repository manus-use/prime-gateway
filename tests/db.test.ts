import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/open.js';
import { appendEvent, appendEvents, lastSeq, readEvents } from '../src/db/events.js';
import { claimMessage, recordOutcome, sweepSeen, wasSeen } from '../src/db/dedup.js';
import {
  bumpGeneration,
  createSession,
  getSession,
  listSessionsByState,
  observeProviderSessionId,
  setExecution,
  setState,
} from '../src/db/sessions.js';
import { createTurn, endTurn, getTurn, openTurns } from '../src/db/turns.js';
import {
  createApproval,
  getApproval,
  oldestPending,
  parkOverdue,
  pendingForSession,
  resolveApproval,
  setApprovalCard,
} from '../src/db/approvals.js';
import {
  advanceCursor,
  bindSession,
  bindingsForSession,
  bindingsInConversation,
  clearActiveCardIfCurrent,
  resolveBinding,
  revokeBindingsAt,
} from '../src/db/bindings.js';
import type { BindingKey } from '../src/types.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';

const NOW = 1_760_000_000_000;

const KEY: BindingKey = {
  channel: 'lark',
  appId: 'cli_app',
  conversationId: 'oc_chat',
  threadId: '',
};

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => {
  h.close();
});

function newSession(id = 's_1'): void {
  createSession(
    h.db,
    { id, agentId: 'acp', workspaceId: 'plain-dir:abc', ownerPrincipal: 'on_owner' },
    NOW,
  );
}

describe('migrate', () => {
  it('is a no-op when already current', () => {
    const version = migrate(h.db, SCHEMA_DIR);
    expect(version).toBeGreaterThan(0);
    expect(migrate(h.db, SCHEMA_DIR)).toBe(version);
  });

  it('records the version in the header, transactionally with the DDL', () => {
    // In `user_version`, not a table -- a runner that creates its own version table
    // cannot coexist with a migration file that also creates one.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBeGreaterThan(0);
  });
});

describe('events', () => {
  it('assigns seq inside the write transaction, so callers never choose it', () => {
    newSession();
    const a = appendEvent(h.db, 's_1', { type: 'turn_submitted', actor: 'user', payload: {} }, NOW);
    const b = appendEvent(h.db, 's_1', { type: 'turn_ended', actor: 'gateway', payload: {} }, NOW);
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(lastSeq(h.db, 's_1')).toBe(2);
  });

  it('numbers each session independently', () => {
    newSession('s_1');
    newSession('s_2');
    appendEvent(h.db, 's_1', { type: 'plan', actor: 'agent', payload: null }, NOW);
    const first = appendEvent(h.db, 's_2', { type: 'plan', actor: 'agent', payload: null }, NOW);
    expect(first.seq).toBe(1);
  });

  it('refuses to append to a session that does not exist', () => {
    expect(() =>
      appendEvent(h.db, 's_missing', { type: 'plan', actor: 'agent', payload: null }, NOW),
    ).toThrow(/unknown session/);
  });

  it('reads a half-open range, which is what a render cursor needs', () => {
    newSession();
    appendEvents(
      h.db,
      's_1',
      [1, 2, 3].map((n) => ({ type: 'agent_message_chunk' as const, actor: 'agent' as const, payload: { n } })),
      NOW,
    );
    expect(readEvents(h.db, 's_1', 1, 3).map((e) => e.seq)).toEqual([2, 3]);
    expect(readEvents(h.db, 's_1', 3, 3)).toEqual([]);
  });

  it('round-trips a payload through jsonb without losing shape', () => {
    newSession();
    const payload = { text: 'hi', paths: ['/tmp/a'], nested: { n: 1, ok: true } };
    appendEvent(h.db, 's_1', { type: 'turn_submitted', actor: 'user', payload }, NOW);
    expect(readEvents(h.db, 's_1', 0, 1)[0]?.payload).toEqual(payload);
  });

  it('defaults generation to the session it is appended to', () => {
    newSession();
    bumpGeneration(h.db, 's_1');
    const e = appendEvent(h.db, 's_1', { type: 'plan', actor: 'agent', payload: null }, NOW);
    expect(e.generation).toBe(1);
  });
});

describe('seen_messages', () => {
  it('claims a delivery exactly once', () => {
    expect(claimMessage(h.db, 'om_1', 'oc_chat', NOW)).toBe(true);
    expect(claimMessage(h.db, 'om_1', 'oc_chat', NOW)).toBe(false);
    expect(wasSeen(h.db, 'om_1')).toBe(true);
  });

  it('records an outcome without affecting the claim', () => {
    claimMessage(h.db, 'om_1', 'oc_chat', NOW);
    recordOutcome(h.db, 'om_1', 'rejected');
    expect(claimMessage(h.db, 'om_1', 'oc_chat', NOW)).toBe(false);
  });

  it('sweeps only past the TTL, which must outlive the whole re-push ladder', () => {
    claimMessage(h.db, 'om_old', 'oc_chat', NOW);
    expect(sweepSeen(h.db, NOW + 7 * 60 * 60 * 1000)).toBe(0);
    expect(sweepSeen(h.db, NOW + 9 * 60 * 60 * 1000)).toBe(1);
    expect(wasSeen(h.db, 'om_old')).toBe(false);
  });
});

describe('turns', () => {
  it('returns the existing turn for a repeated idempotency key', () => {
    newSession();
    const first = createTurn(
      h.db,
      { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'k' },
      NOW,
    );
    const again = createTurn(
      h.db,
      { sessionId: 's_1', turnId: 't_2', generation: 0, idempotencyKey: 'k' },
      NOW,
    );
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.turn.turnId).toBe('t_1');
  });

  it('maps each terminal onto its own final state', () => {
    newSession();
    const terminals = ['completed', 'failed', 'cancelled', 'ambiguous'] as const;
    const expected = ['completed', 'failed', 'cancelled', 'indeterminate'];
    terminals.forEach((terminal, i) => {
      createTurn(
        h.db,
        { sessionId: 's_1', turnId: `t_${i}`, generation: 0, idempotencyKey: `k${i}` },
        NOW,
      );
      endTurn(h.db, 's_1', `t_${i}`, terminal, NOW);
      expect(getTurn(h.db, 's_1', `t_${i}`)?.state).toBe(expected[i]);
      expect(getTurn(h.db, 's_1', `t_${i}`)?.terminal).toBe(terminal);
    });
  });

  it('drops a turn out of openTurns once it has a terminal', () => {
    newSession();
    createTurn(h.db, { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'k' }, NOW);
    expect(openTurns(h.db, 's_1')).toHaveLength(1);
    endTurn(h.db, 's_1', 't_1', 'completed', NOW);
    expect(openTurns(h.db, 's_1')).toHaveLength(0);
  });

  it('keeps an existing fence when none is supplied', () => {
    newSession();
    createTurn(h.db, { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'k' }, NOW);
    endTurn(h.db, 's_1', 't_1', 'ambiguous', NOW, 'boot1:0');
    endTurn(h.db, 's_1', 't_1', 'failed', NOW);
    expect(getTurn(h.db, 's_1', 't_1')?.fence).toBe('boot1:0');
  });
});

describe('approvals', () => {
  const OPTIONS = [
    { optionId: 'allow', name: 'Allow' },
    { optionId: 'deny', name: 'Deny' },
  ];

  function seed(generation = 0, parkAfterMs?: number): void {
    newSession();
    createTurn(
      h.db,
      { sessionId: 's_1', turnId: 't_1', generation, idempotencyKey: 'k' },
      NOW,
    );
    createApproval(
      h.db,
      {
        approvalId: 'a_1',
        sessionId: 's_1',
        turnId: 't_1',
        generation,
        action: 'rm -rf /',
        payload: { tool: 'bash' },
        options: OPTIONS,
      },
      NOW,
      parkAfterMs,
    );
  }

  it('resolves once and records who and how', () => {
    seed();
    const result = resolveApproval(
      h.db,
      {
        approvalId: 'a_1',
        optionId: 'allow',
        expectedGeneration: 0,
        resolvedBy: 'on_owner',
        resolvedVia: 'lark',
      },
      NOW,
    );
    expect(result.kind).toBe('resolved');
    const row = getApproval(h.db, 'a_1');
    expect(row?.state).toBe('resolved');
    expect(row?.optionId).toBe('allow');
    expect(row?.resolvedBy).toBe('on_owner');
    expect(row?.resolvedVia).toBe('lark');
  });

  it('is idempotent: a second click gets `already` and the first answer stands', () => {
    seed();
    const args = {
      approvalId: 'a_1',
      expectedGeneration: 0,
      resolvedBy: 'on_owner',
      resolvedVia: 'lark',
    };
    resolveApproval(h.db, { ...args, optionId: 'allow' }, NOW);
    const second = resolveApproval(h.db, { ...args, optionId: 'deny' }, NOW + 1);
    expect(second.kind).toBe('already');
    expect(getApproval(h.db, 'a_1')?.optionId).toBe('allow');
  });

  it('refuses a superseded generation', () => {
    // The CAS is the load-bearing part: a nonce proves the card was not altered,
    // never that what it points at is still current.
    seed(0);
    bumpGeneration(h.db, 's_1');
    const result = resolveApproval(
      h.db,
      {
        approvalId: 'a_1',
        optionId: 'allow',
        // What the session says now, which is what the actor passes.
        expectedGeneration: getSession(h.db, 's_1')?.generation ?? -1,
        resolvedBy: 'on_owner',
        resolvedVia: 'lark',
      },
      NOW,
    );
    expect(result.kind).toBe('stale');
    expect(getApproval(h.db, 'a_1')?.state).toBe('pending');
  });

  it('refuses an option the agent never offered', () => {
    // `action.value` is client-supplied and not verified by Lark.
    seed();
    const result = resolveApproval(
      h.db,
      {
        approvalId: 'a_1',
        optionId: 'allow_always_and_forever',
        expectedGeneration: 0,
        resolvedBy: 'on_owner',
        resolvedVia: 'lark',
      },
      NOW,
    );
    expect(result.kind).toBe('bad_option');
    expect(getApproval(h.db, 'a_1')?.state).toBe('pending');
  });

  it('reports unknown for an id that does not exist', () => {
    seed();
    const result = resolveApproval(
      h.db,
      {
        approvalId: 'a_nope',
        optionId: 'allow',
        expectedGeneration: 0,
        resolvedBy: 'on_owner',
        resolvedVia: 'lark',
      },
      NOW,
    );
    expect(result.kind).toBe('unknown');
  });

  it('checks `already` before the generation, so a re-click after a restart is not called stale', () => {
    seed();
    resolveApproval(
      h.db,
      { approvalId: 'a_1', optionId: 'allow', expectedGeneration: 0, resolvedBy: 'x', resolvedVia: 'lark' },
      NOW,
    );
    bumpGeneration(h.db, 's_1');
    const second = resolveApproval(
      h.db,
      { approvalId: 'a_1', optionId: 'allow', expectedGeneration: 1, resolvedBy: 'x', resolvedVia: 'lark' },
      NOW,
    );
    expect(second.kind).toBe('already');
  });

  it('parks without deciding, and a parked approval stays answerable', () => {
    // No timeout-to-default: denying silently kills multi-day work, allowing is
    // indefensible.
    seed(0, 1000);
    expect(parkOverdue(h.db, NOW + 500)).toBe(0);
    expect(parkOverdue(h.db, NOW + 1500)).toBe(1);
    expect(getApproval(h.db, 'a_1')?.state).toBe('parked');
    expect(pendingForSession(h.db, 's_1')).toHaveLength(1);
    const result = resolveApproval(
      h.db,
      { approvalId: 'a_1', optionId: 'deny', expectedGeneration: 0, resolvedBy: 'x', resolvedVia: 'lark' },
      NOW + 2000,
    );
    expect(result.kind).toBe('resolved');
  });

  it('never re-parks a resolved approval', () => {
    seed(0, 1000);
    resolveApproval(
      h.db,
      { approvalId: 'a_1', optionId: 'allow', expectedGeneration: 0, resolvedBy: 'x', resolvedVia: 'lark' },
      NOW,
    );
    expect(parkOverdue(h.db, NOW + 5000)).toBe(0);
  });

  it('orders pending approvals oldest first', () => {
    seed();
    createApproval(
      h.db,
      {
        approvalId: 'a_2',
        sessionId: 's_1',
        turnId: 't_1',
        generation: 0,
        action: 'later',
        payload: null,
        options: OPTIONS,
      },
      NOW + 10,
    );
    expect(oldestPending(h.db, 's_1')?.approvalId).toBe('a_1');
    expect(pendingForSession(h.db, 's_1').map((a) => a.approvalId)).toEqual(['a_1', 'a_2']);
  });

  it('round-trips options and payload', () => {
    seed();
    const row = getApproval(h.db, 'a_1');
    expect(row?.options).toEqual(OPTIONS);
    expect(row?.payload).toEqual({ tool: 'bash' });
  });

  it('remembers which card carried the request', () => {
    seed();
    setApprovalCard(h.db, 'a_1', 'om_card_1');
    expect(getApproval(h.db, 'a_1')?.cardMessageId).toBe('om_card_1');
  });
});

describe('bindings', () => {
  it('resolves a live binding and ignores a revoked one', () => {
    // /new revokes rather than deletes, so a redelivery after a rotation must
    // resolve to nothing rather than resurrecting the rotated session.
    newSession();
    bindSession(h.db, KEY, 's_1', NOW);
    expect(resolveBinding(h.db, KEY)?.sessionId).toBe('s_1');
    expect(revokeBindingsAt(h.db, KEY, NOW + 1)).toBe(1);
    expect(resolveBinding(h.db, KEY)).toBeUndefined();
  });

  it('keys on thread id, so chat scope and a thread are different bindings', () => {
    newSession('s_1');
    newSession('s_2');
    bindSession(h.db, KEY, 's_1', NOW);
    bindSession(h.db, { ...KEY, threadId: 'omt_1' }, 's_2', NOW);
    expect(resolveBinding(h.db, KEY)?.sessionId).toBe('s_1');
    expect(resolveBinding(h.db, { ...KEY, threadId: 'omt_1' })?.sessionId).toBe('s_2');
  });

  it('keys on app id, so two bots can share one chat', () => {
    newSession('s_1');
    newSession('s_2');
    bindSession(h.db, KEY, 's_1', NOW);
    bindSession(h.db, { ...KEY, appId: 'cli_other' }, 's_2', NOW);
    expect(resolveBinding(h.db, { ...KEY, appId: 'cli_other' })?.sessionId).toBe('s_2');
  });

  it('starts a newly bound location at cursor 0, so history replays into it', () => {
    newSession();
    expect(bindSession(h.db, KEY, 's_1', NOW).cursorSeq).toBe(0);
  });

  it('advances the cursor monotonically', () => {
    // A late-finishing older render must not walk the cursor backwards and cause
    // newer output to be re-rendered.
    newSession();
    bindSession(h.db, KEY, 's_1', NOW);
    advanceCursor(h.db, KEY, 's_1', 10);
    advanceCursor(h.db, KEY, 's_1', 4);
    expect(resolveBinding(h.db, KEY)?.cursorSeq).toBe(10);
  });

  it('un-revokes on re-bind rather than inserting a duplicate row', () => {
    newSession();
    bindSession(h.db, KEY, 's_1', NOW);
    revokeBindingsAt(h.db, KEY, NOW + 1);
    bindSession(h.db, KEY, 's_1', NOW + 2);
    expect(bindingsForSession(h.db, 's_1')).toHaveLength(1);
  });

  it('clears the active card only when it is still the current one', () => {
    // A "withdrawn" error for a card we have already rotated past would otherwise
    // clear a perfectly good current card.
    newSession();
    bindSession(h.db, KEY, 's_1', NOW);
    expect(clearActiveCardIfCurrent(h.db, 's_1', 'om_stale')).toBe(false);
    h.db
      .prepare('UPDATE channel_bindings SET active_message_id = ? WHERE session_id = ?')
      .run('om_live', 's_1');
    expect(clearActiveCardIfCurrent(h.db, 's_1', 'om_stale')).toBe(false);
    expect(clearActiveCardIfCurrent(h.db, 's_1', 'om_live')).toBe(true);
  });

  it('lists the live bindings in a conversation, newest first', () => {
    newSession('s_1');
    newSession('s_2');
    bindSession(h.db, KEY, 's_1', NOW);
    bindSession(h.db, { ...KEY, threadId: 'omt_1' }, 's_2', NOW + 5);
    const rows = bindingsInConversation(h.db, KEY.channel, KEY.appId, KEY.conversationId);
    expect(rows.map((b) => b.sessionId)).toEqual(['s_2', 's_1']);
  });
});

describe('sessions', () => {
  it('starts initializing with generation 0', () => {
    newSession();
    const s = getSession(h.db, 's_1');
    expect(s?.state).toBe('initializing');
    expect(s?.generation).toBe(0);
  });

  it('bumps the generation monotonically and returns the new value', () => {
    newSession();
    expect(bumpGeneration(h.db, 's_1')).toBe(1);
    expect(bumpGeneration(h.db, 's_1')).toBe(2);
  });

  it('stamps cold_at only for cold and quarantined', () => {
    newSession();
    setState(h.db, 's_1', 'live', NOW);
    expect(getSession(h.db, 's_1')?.coldAt).toBeNull();
    setState(h.db, 's_1', 'cold', NOW + 1);
    expect(getSession(h.db, 's_1')?.coldAt).toBe(NOW + 1);
    setState(h.db, 's_1', 'quarantined', NOW + 2);
    expect(getSession(h.db, 's_1')?.coldAt).toBe(NOW + 2);
  });

  it('stores the provider session id it was told, not the one it sent', () => {
    newSession();
    observeProviderSessionId(h.db, 's_1', 'prov_a');
    observeProviderSessionId(h.db, 's_1', 'prov_rotated');
    expect(getSession(h.db, 's_1')?.providerSessionId).toBe('prov_rotated');
  });

  it('records an execution handle and can clear it', () => {
    newSession();
    setExecution(h.db, 's_1', 'boot1:0', 'acp');
    expect(getSession(h.db, 's_1')?.executionHandle).toBe('boot1:0');
    setExecution(h.db, 's_1', null, null);
    expect(getSession(h.db, 's_1')?.executionHandle).toBeNull();
  });

  it('lists by state and returns nothing for an empty state list', () => {
    newSession('s_1');
    newSession('s_2');
    setState(h.db, 's_2', 'terminated', NOW);
    expect(listSessionsByState(h.db, ['initializing']).map((s) => s.id)).toEqual(['s_1']);
    expect(listSessionsByState(h.db, [])).toEqual([]);
  });
});
