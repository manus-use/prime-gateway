import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_LIVE, SessionRegistry } from '../src/core/registry.js';
import { BOOT_ID } from '../src/core/ids.js';
import type { Workspace, WorkspaceProvider } from '../src/core/workspace.js';
import { createSession, getSession, setExecution, setState } from '../src/db/sessions.js';
import { bindSession, bindingsForSession, resolveBinding } from '../src/db/bindings.js';
import { createTurn, getTurn, setTurnState } from '../src/db/turns.js';
import { createApproval, getApproval } from '../src/db/approvals.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import type { BindingKey, Principal, TurnState } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

const NOW = 1_760_000_000_000;
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: null };

function key(over: Partial<BindingKey> = {}): BindingKey {
  return {
    channel: 'lark',
    appId: 'cli_app',
    conversationId: 'oc_chat',
    threadId: '',
    ...over,
  };
}

class FakeWorkspaces implements WorkspaceProvider {
  readonly kind = 'plain-dir' as const;
  readonly acquired: string[] = [];
  readonly released: string[] = [];

  async acquire(sessionId: string): Promise<Workspace> {
    this.acquired.push(sessionId);
    return { id: 'plain-dir:test', kind: this.kind, cwd: '/tmp/workspace' };
  }

  async release(sessionId: string): Promise<void> {
    this.released.push(sessionId);
  }
}

interface Harness {
  db: TestDb;
  registry: SessionRegistry;
  driver: FakeDriver;
  channel: FakeChannel;
  workspaces: FakeWorkspaces;
  clock: ManualClock;
  notes: string[];
  eventTypes(sessionId: string): string[];
}

const open: TestDb[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function harness(maxLive = DEFAULT_MAX_LIVE): Harness {
  const db = testDb();
  open.push(db);
  const clock = new ManualClock(NOW);
  const driver = new FakeDriver();
  const channel = new FakeChannel({ clock });
  const workspaces = new FakeWorkspaces();
  const notes: string[] = [];

  const registry = new SessionRegistry({
    db: db.db,
    driver,
    channel,
    workspaces,
    channelId: 'lark',
    appId: 'cli_app',
    clock,
    maxLive,
    note: (line) => notes.push(line),
  });

  return {
    db,
    registry,
    driver,
    channel,
    workspaces,
    clock,
    notes,
    eventTypes(sessionId: string): string[] {
      return readEvents(db.db, sessionId, 0, lastSeq(db.db, sessionId)).map((e) => e.type);
    },
  };
}

describe('bindOrCreate', () => {
  it('creates and binds in one step, and logs both', () => {
    // Creating a session outside the binding step is how one thread ends up with two
    // sessions, each holding half the conversation.
    const h = harness();
    const { session, created } = h.registry.bindOrCreate(key(), OWNER);

    expect(created).toBe(true);
    expect(resolveBinding(h.db.db, key())?.sessionId).toBe(session.id);
    expect(h.eventTypes(session.id)).toEqual(['session_created', 'binding_resolved']);
  });

  it('returns the same session for the same location', () => {
    const h = harness();
    const first = h.registry.bindOrCreate(key(), OWNER);
    const second = h.registry.bindOrCreate(key(), OWNER);
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
  });

  it('gives a thread its own session', () => {
    const h = harness();
    const chat = h.registry.bindOrCreate(key(), OWNER);
    const thread = h.registry.bindOrCreate(key({ threadId: 'omt_1' }), OWNER);
    expect(thread.session.id).not.toBe(chat.session.id);
  });

  it('records the owner rather than the app', () => {
    const h = harness();
    expect(h.registry.bindOrCreate(key(), OWNER).session.ownerPrincipal).toBe('on_owner');
  });

  it('cannot be given a binding that points at a missing session', () => {
    // `bindOrCreate` has a branch for a dangling pointer. The schema makes it
    // unreachable, which is worth pinning down: if the foreign key is ever dropped,
    // this test starts failing and the branch stops being dead defence.
    const h = harness();
    expect(() => bindSession(h.db.db, key(), 's_ghost', NOW)).toThrow(/FOREIGN KEY/);
  });
});

describe('rotate', () => {
  it('archives the old session and binds a fresh one', async () => {
    const h = harness();
    const before = h.registry.bindOrCreate(key(), OWNER).session;
    const after = await h.registry.rotate(key(), OWNER);

    expect(after.id).not.toBe(before.id);
    expect(getSession(h.db.db, before.id)?.state).toBe('archived');
    expect(resolveBinding(h.db.db, key())?.sessionId).toBe(after.id);
  });

  it('keeps the old session reachable by id', async () => {
    // Revoke, never delete. A /new that destroyed history would make every
    // accidental /new unrecoverable.
    const h = harness();
    const before = h.registry.bindOrCreate(key(), OWNER).session;
    await h.registry.rotate(key(), OWNER);

    expect(getSession(h.db.db, before.id)).toBeDefined();
    expect(h.eventTypes(before.id)).toContain('session_state_changed');
  });

  it('works on a location with nothing bound yet', async () => {
    const h = harness();
    await expect(h.registry.rotate(key(), OWNER)).resolves.toBeDefined();
  });

  it('releases the old actor and its workspace', async () => {
    const h = harness();
    const before = h.registry.bindOrCreate(key(), OWNER).session;
    await h.registry.actorFor(before.id, key());
    await h.registry.rotate(key(), OWNER);

    expect(h.workspaces.released).toEqual([before.id]);
    expect(h.registry.liveActor(before.id)).toBeUndefined();
  });
});

describe('attach', () => {
  it('refuses an id that does not exist, with a reason to say out loud', async () => {
    const h = harness();
    const result = await h.registry.attach(key(), 's_nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('s_nope');
  });

  it('refuses a terminated session', async () => {
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    setState(h.db.db, session.id, 'terminated', NOW);
    const result = await h.registry.attach(key({ threadId: 'omt_1' }), session.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('ended');
  });

  it('accepts an archived session, because /attach is how you get back to one', async () => {
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    await h.registry.rotate(key(), OWNER);
    const result = await h.registry.attach(key({ threadId: 'omt_1' }), session.id);
    expect(result.ok).toBe(true);
  });

  it('is a no-op when the location already points there', async () => {
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    const before = resolveBinding(h.db.db, key())?.cursorSeq;
    expect((await h.registry.attach(key(), session.id)).ok).toBe(true);
    expect(resolveBinding(h.db.db, key())?.cursorSeq).toBe(before);
  });

  it('replaces a different binding and starts the cursor at 0', async () => {
    // A newly bound location replays the session's history rather than resuming
    // mid-sentence.
    const h = harness();
    const stays = h.registry.bindOrCreate(key({ conversationId: 'oc_other' }), OWNER).session;
    h.registry.bindOrCreate(key(), OWNER);

    const result = await h.registry.attach(key(), stays.id);
    expect(result.ok).toBe(true);
    const binding = resolveBinding(h.db.db, key());
    expect(binding?.sessionId).toBe(stays.id);
    expect(binding?.cursorSeq).toBe(0);
  });

  it('leaves one live binding per location', async () => {
    const h = harness();
    const first = h.registry.bindOrCreate(key(), OWNER).session;
    const second = h.registry.bindOrCreate(key({ conversationId: 'oc_two' }), OWNER).session;
    await h.registry.attach(key(), second.id);

    expect(bindingsForSession(h.db.db, first.id)).toHaveLength(0);
    expect(bindingsForSession(h.db.db, second.id)).toHaveLength(2);
  });
});

describe('actors', () => {
  it('hands out one actor per session', async () => {
    // At most one actor per session, ever. Two writers to one session is the bug the
    // whole actor model exists to remove.
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    const a = await h.registry.actorFor(session.id, key());
    const b = await h.registry.actorFor(session.id, key());
    expect(a).toBe(b);
    expect(h.workspaces.acquired).toEqual([session.id]);
  });

  it('does not create an actor from liveActor', () => {
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    expect(h.registry.liveActor(session.id)).toBeUndefined();
  });

  it('retires the least recently used idle actor at the cap', async () => {
    const h = harness(2);
    const one = h.registry.bindOrCreate(key({ conversationId: 'oc_1' }), OWNER).session;
    const two = h.registry.bindOrCreate(key({ conversationId: 'oc_2' }), OWNER).session;
    const three = h.registry.bindOrCreate(key({ conversationId: 'oc_3' }), OWNER).session;

    await h.registry.actorFor(one.id, key({ conversationId: 'oc_1' }));
    h.clock.advance(10);
    await h.registry.actorFor(two.id, key({ conversationId: 'oc_2' }));
    h.clock.advance(10);
    await h.registry.actorFor(three.id, key({ conversationId: 'oc_3' }));

    expect(h.registry.liveActor(one.id)).toBeUndefined();
    expect(h.registry.liveActor(two.id)).toBeDefined();
    expect(h.registry.liveCount).toBe(2);
  });

  it('retires by going cold, not by ending the session', async () => {
    // Retiring is a memory decision. The next message in that thread resumes it.
    const h = harness(1);
    const one = h.registry.bindOrCreate(key({ conversationId: 'oc_1' }), OWNER).session;
    const two = h.registry.bindOrCreate(key({ conversationId: 'oc_2' }), OWNER).session;
    await h.registry.actorFor(one.id, key({ conversationId: 'oc_1' }));
    await h.registry.actorFor(two.id, key({ conversationId: 'oc_2' }));

    expect(getSession(h.db.db, one.id)?.state).toBe('cold');
    expect(h.workspaces.released).toEqual([one.id]);
  });

  it('never retires a busy actor, even over the cap', async () => {
    // Being over the cap is a capacity problem that shows up in a metric. Closing a
    // session mid-turn destroys work the user is waiting for.
    const h = harness(1);
    const busy = h.registry.bindOrCreate(key({ conversationId: 'oc_1' }), OWNER).session;
    const actor = await h.registry.actorFor(busy.id, key({ conversationId: 'oc_1' }));

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.driver.scripts = [
      async (ctl) => {
        await gate;
        ctl.end('completed');
      },
    ];
    const turn = actor.submit({
      messageId: 'om_1',
      appId: 'cli_app',
      input: { text: 'work', paths: [] },
    });
    while (actor.status().label !== 'working') await new Promise(setImmediate);

    const other = h.registry.bindOrCreate(key({ conversationId: 'oc_2' }), OWNER).session;
    await h.registry.actorFor(other.id, key({ conversationId: 'oc_2' }));

    expect(h.registry.liveActor(busy.id)).toBeDefined();
    expect(h.registry.liveCount).toBe(2);
    expect(h.notes.some((n) => n.includes('over capacity'))).toBe(true);

    release();
    await turn;
  });

  it('finds a session by id through its binding', async () => {
    // The card-callback path knows an approvalId and works backwards.
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    const actor = await h.registry.actorForBoundSession(session.id);
    expect(actor?.sessionId).toBe(session.id);
  });

  it('refuses to reach a session nothing binds any more', async () => {
    // A button on a rotated-away session points at a place in the chat that no
    // longer exists; inventing a binding to satisfy the click would resurrect it.
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    await h.registry.rotate(key(), OWNER);
    expect(await h.registry.actorForBoundSession(session.id)).toBeUndefined();
  });

  it('does not start a runtime just to reach a session', async () => {
    // Recording an answer must not spawn an agent as a side effect of a click.
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    await h.registry.actorForBoundSession(session.id);
    expect(h.driver.starts).toHaveLength(0);
  });

  it('closes every actor on shutdown and releases their workspaces', async () => {
    const h = harness();
    const one = h.registry.bindOrCreate(key({ conversationId: 'oc_1' }), OWNER).session;
    const two = h.registry.bindOrCreate(key({ conversationId: 'oc_2' }), OWNER).session;
    await h.registry.actorFor(one.id, key({ conversationId: 'oc_1' }));
    await h.registry.actorFor(two.id, key({ conversationId: 'oc_2' }));

    await h.registry.closeAll();
    expect(h.registry.liveCount).toBe(0);
    expect(h.workspaces.released.sort()).toEqual([one.id, two.id].sort());
  });

  it('keeps closing after one actor fails to close', async () => {
    const h = harness();
    const one = h.registry.bindOrCreate(key({ conversationId: 'oc_1' }), OWNER).session;
    const two = h.registry.bindOrCreate(key({ conversationId: 'oc_2' }), OWNER).session;
    const actor = await h.registry.actorFor(one.id, key({ conversationId: 'oc_1' }));
    await h.registry.actorFor(two.id, key({ conversationId: 'oc_2' }));
    Object.defineProperty(actor, 'close', {
      value: async (): Promise<void> => {
        throw new Error('card write failed');
      },
    });

    await h.registry.closeAll();
    expect(h.workspaces.released).toContain(two.id);
    expect(h.notes.some((n) => n.includes('failed'))).toBe(true);
  });
});

describe('reconcileBoot', () => {
  function seed(
    h: Harness,
    opts: { turnState?: TurnState; state?: 'live' | 'idle' | 'cold'; handle?: string } = {},
  ): string {
    const id = `s_${opts.turnState ?? 'none'}_${opts.state ?? 'live'}`;
    createSession(
      h.db.db,
      { id, agentId: 'fake', workspaceId: 'w', ownerPrincipal: 'on_owner' },
      NOW,
    );
    setState(h.db.db, id, opts.state ?? 'live', NOW);
    if (opts.handle !== undefined) setExecution(h.db.db, id, opts.handle, 'fake');
    bindSession(h.db.db, key(), id, NOW);
    if (opts.turnState !== undefined) {
      createTurn(h.db.db, { sessionId: id, turnId: 't_1', generation: 0, idempotencyKey: 'k' }, NOW);
      setTurnState(h.db.db, id, 't_1', opts.turnState);
    }
    return id;
  }

  it('holds a session whose prompt was in flight', () => {
    // Delivering means the prompt was handed over and nothing came back. Whether
    // the agent consumed it is unknowable, which is what quarantine is for.
    const h = harness();
    const id = seed(h, { turnState: 'delivering' });
    const [finding] = h.registry.reconcileBoot();

    expect(finding?.held).toBe(true);
    expect(getSession(h.db.db, id)?.state).toBe('quarantined');
    expect(h.eventTypes(id)).toContain('turn_delivery_ambiguous');
  });

  it('does not hold a session whose turn was established', () => {
    // Delivery is established, the outcome is not. The log shows what the agent did
    // and the next message can continue.
    const h = harness();
    const id = seed(h, { turnState: 'running' });
    const [finding] = h.registry.reconcileBoot();

    expect(finding?.held).toBe(false);
    expect(getSession(h.db.db, id)?.state).toBe('cold');
    expect(h.eventTypes(id)).toContain('turn_ended');
  });

  it('does not hold a session that was parked on an approval', () => {
    const h = harness();
    const id = seed(h, { turnState: 'awaiting_approval' });
    const [finding] = h.registry.reconcileBoot();
    expect(finding?.held).toBe(false);
    expect(getSession(h.db.db, id)?.state).toBe('cold');
  });

  it('holds a turn that never left pending', () => {
    const h = harness();
    seed(h, { turnState: 'pending' });
    expect(h.registry.reconcileBoot()[0]?.held).toBe(true);
  });

  it('never guesses a turn to completion', () => {
    // Nothing on this path may claim work succeeded.
    const h = harness();
    const id = seed(h, { turnState: 'running' });
    h.registry.reconcileBoot();
    const turn = getTurn(h.db.db, id, 't_1');
    expect(turn?.terminal).toBe('ambiguous');
    expect(turn?.state).toBe('indeterminate');
  });

  it('leaves unanswered approvals pending and says so', () => {
    // Parking is a visibility change, not a decision. There is no
    // timeout-to-default: denying silently kills multi-day work and allowing is
    // indefensible.
    const h = harness();
    const id = seed(h, { turnState: 'running' });
    createApproval(
      h.db.db,
      {
        approvalId: 'a_1',
        sessionId: id,
        turnId: 't_1',
        generation: 0,
        action: 'x',
        payload: null,
        options: [{ optionId: 'allow', name: 'Allow' }],
      },
      NOW,
    );

    const [finding] = h.registry.reconcileBoot();
    expect(getApproval(h.db.db, 'a_1')?.state).toBe('pending');
    expect(finding?.message).toContain('unanswered');
  });

  it('says where each finding has to be reported', () => {
    // A finding nobody is told about is the same as no reconciliation: the user just
    // sees a session that stopped.
    const h = harness();
    seed(h, { turnState: 'delivering' });
    expect(h.registry.reconcileBoot()[0]?.bindings).toEqual([key()]);
  });

  it('says nothing about a session that was already cold and idle', () => {
    // Otherwise every boot posts a message about every session that ever existed.
    const h = harness();
    seed(h, { state: 'cold' });
    expect(h.registry.reconcileBoot()).toEqual([]);
  });

  it('reports an interrupted idle session without an empty parenthetical', () => {
    const h = harness();
    seed(h, { state: 'idle' });
    const [finding] = h.registry.reconcileBoot();
    expect(finding?.held).toBe(false);
    expect(finding?.message).not.toContain('()');
  });

  it('leaves the sessions belonging to this process alone', () => {
    // Only reachable if reconcile runs late, which is a bug -- but a no-op beats
    // fighting a live actor for the same session.
    const h = harness();
    const id = seed(h, { turnState: 'delivering', handle: `${BOOT_ID}:0` });
    expect(h.registry.reconcileBoot()).toEqual([]);
    expect(getSession(h.db.db, id)?.state).toBe('live');
  });

  it('ignores a terminated session', () => {
    const h = harness();
    const id = seed(h, { turnState: 'running' });
    setState(h.db.db, id, 'terminated', NOW);
    expect(h.registry.reconcileBoot()).toEqual([]);
  });

  it('is safe to run twice', () => {
    // A boot that crashes partway through reconciliation retries the whole thing.
    const h = harness();
    const id = seed(h, { turnState: 'delivering' });
    h.registry.reconcileBoot();
    const after = h.registry.reconcileBoot();
    expect(after).toEqual([]);
    expect(getSession(h.db.db, id)?.state).toBe('quarantined');
  });
});

describe('park', () => {
  it('parks overdue approvals and reports how many', () => {
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    createTurn(
      h.db.db,
      { sessionId: session.id, turnId: 't_1', generation: 0, idempotencyKey: 'k' },
      NOW,
    );
    createApproval(
      h.db.db,
      {
        approvalId: 'a_1',
        sessionId: session.id,
        turnId: 't_1',
        generation: 0,
        action: 'x',
        payload: null,
        options: [{ optionId: 'allow', name: 'Allow' }],
      },
      NOW,
      1000,
    );

    expect(h.registry.park()).toBe(0);
    h.clock.advance(2000);
    expect(h.registry.park()).toBe(1);
    expect(getApproval(h.db.db, 'a_1')?.state).toBe('parked');
  });
});
