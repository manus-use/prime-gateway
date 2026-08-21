import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_MAILBOX_DEPTH,
  MailboxFull,
  REPLAY_MAX_TURNS,
  SessionActor,
  SessionHeld,
} from '../src/core/session-actor.js';
import { approvalNonce } from '../src/core/ids.js';
import { createSession, getSession, setState } from '../src/db/sessions.js';
import { bindSession, resolveBinding } from '../src/db/bindings.js';
import { createTurn, openTurns } from '../src/db/turns.js';
import { createApproval, getApproval } from '../src/db/approvals.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import type { BindingKey, Event, Principal } from '../src/types.js';
import { ChannelError } from '../src/channel/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver, type TurnControl } from './helpers/driver.js';
import { ManualClock, settle, testDb, type TestDb } from './helpers/db.js';

const NOW = 1_760_000_000_000;

const KEY: BindingKey = {
  channel: 'lark',
  appId: 'cli_app',
  conversationId: 'oc_chat',
  threadId: '',
};

const CLICKER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: null };

interface Harness {
  db: TestDb;
  actor: SessionActor;
  driver: FakeDriver;
  channel: FakeChannel;
  clock: ManualClock;
  notes: string[];
  submit(text?: string, messageId?: string): Promise<string>;
  events(): readonly Event[];
  eventTypes(): string[];
}

const open: TestDb[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function harness(): Harness {
  const db = testDb();
  open.push(db);
  const clock = new ManualClock(NOW);
  const channel = new FakeChannel({ clock });
  const driver = new FakeDriver();
  const notes: string[] = [];

  createSession(
    db.db,
    { id: 's_1', agentId: 'fake', workspaceId: 'plain-dir:x', ownerPrincipal: 'on_owner' },
    NOW,
  );
  bindSession(db.db, KEY, 's_1', NOW);

  const actor = new SessionActor({
    db: db.db,
    sessionId: 's_1',
    driver,
    channel,
    key: KEY,
    target: { chatId: KEY.conversationId, threadId: KEY.threadId },
    cwd: '/tmp/workspace',
    clock,
    note: (line) => notes.push(line),
  });

  return {
    db,
    actor,
    driver,
    channel,
    clock,
    notes,
    submit(text = 'do the thing', messageId = 'om_1'): Promise<string> {
      return actor.submit({ messageId, appId: KEY.appId, input: { text, paths: [] } });
    },
    events(): readonly Event[] {
      return readEvents(db.db, 's_1', 0, lastSeq(db.db, 's_1'));
    },
    eventTypes(): string[] {
      return this.events().map((e) => e.type);
    },
  };
}

describe('a turn that goes well', () => {
  it('records the prompt, the output and the terminal, in that order', async () => {
    const h = harness();
    h.driver.scripts = [
      (ctl) => {
        ctl.emit({ kind: 'message-chunk', text: 'done' });
        ctl.end('completed');
      },
    ];
    expect(await h.submit()).toBe('completed');
    expect(h.eventTypes()).toEqual([
      'turn_submitted',
      'session_state_changed',
      'agent_message_chunk',
      'turn_ended',
    ]);
  });

  it('leaves the session idle with no turn open', async () => {
    const h = harness();
    await h.submit();
    expect(getSession(h.db.db, 's_1')?.state).toBe('idle');
    expect(openTurns(h.db.db, 's_1')).toHaveLength(0);
  });

  it('stores the provider session id the agent reported, not the one it was given', async () => {
    // Agents mint their own id and may rotate it. Storing what we sent means the
    // next resume addresses a session the agent has already replaced.
    const h = harness();
    h.driver.providerSessionId = 'prov_rotated';
    await h.submit();
    expect(getSession(h.db.db, 's_1')?.providerSessionId).toBe('prov_rotated');
  });

  it('renders the turn into a card and advances the persisted cursor', async () => {
    const h = harness();
    h.driver.scripts = [
      (ctl) => {
        ctl.emit({ kind: 'message-chunk', text: 'the answer' });
        ctl.end('completed');
      },
    ];
    await h.submit();
    await h.actor.flushCard();

    expect(h.channel.lastCard?.text).toContain('the answer');
    expect(resolveBinding(h.db.db, KEY)?.cursorSeq).toBe(lastSeq(h.db.db, 's_1'));
  });

  it('reuses one runtime across turns', async () => {
    const h = harness();
    await h.submit('one', 'om_1');
    await h.submit('two', 'om_2');
    expect(h.driver.starts).toHaveLength(1);
    expect(h.driver.lastRuntime?.prompts.map((p) => p.text)).toEqual(['one', 'two']);
  });
});

describe('turn terminals', () => {
  it('calls a stream that ends without a terminal ambiguous, and holds the session', async () => {
    // The driver is contracted to emit a terminal. Its absence means the iterator
    // was torn down under us, so whether the work happened is unknown.
    const h = harness();
    h.driver.scripts = [
      (ctl) => {
        ctl.emit({ kind: 'message-chunk', text: 'half an answer' });
      },
    ];
    expect(await h.submit()).toBe('ambiguous');
    expect(getSession(h.db.db, 's_1')?.state).toBe('quarantined');
  });

  it('records an ambiguous terminal as indeterminate rather than as a failure', async () => {
    const h = harness();
    h.driver.scripts = [() => undefined];
    await h.submit();
    const turn = firstTurn(h);
    expect(turn.state).toBe('indeterminate');
    expect(turn.terminal).toBe('ambiguous');
  });

  it('quarantines when the prompt was delivered and nothing came back', async () => {
    // The one rule that decides whether a session is usable afterwards: delivered
    // and silent is not the same as never delivered.
    const h = harness();
    // A first turn just to get a runtime attached.
    await h.submit('warm up', 'om_0');
    const runtime = h.driver.lastRuntime;
    if (runtime === undefined) throw new Error('no runtime');
    // Fails from inside `prompt`, i.e. after the runtime accepted the turn.
    runtime.failPromptWith = new Error('transport died');

    expect(await h.submit('the real one', 'om_1')).toBe('ambiguous');
    expect(getSession(h.db.db, 's_1')?.state).toBe('quarantined');
  });

  it('does not quarantine a failure that happened before delivery', async () => {
    // Nothing reached the agent, so there is nothing ambiguous about it. Treating a
    // bad binary path as needing manual rescue makes the state meaningless.
    const h = harness();
    h.driver.failStartWith = new Error('spawn ENOENT');
    expect(await h.submit()).toBe('failed');
    expect(getSession(h.db.db, 's_1')?.state).toBe('cold');
  });

  it('drops the runtime when it quarantines', async () => {
    // A quarantined session that keeps a live runtime can still be prompted, which
    // is the exact thing the state exists to prevent.
    const h = harness();
    h.driver.scripts = [() => undefined];
    await h.submit();
    expect(h.actor.presence).not.toBe('live');
    expect(h.driver.lastRuntime?.closes).toBe(1);
  });

  it('reports an agent-side error as a failed turn without quarantining', async () => {
    const h = harness();
    h.driver.scripts = [
      (ctl) => {
        ctl.emit({ kind: 'error', message: 'model overloaded', retryable: true });
        ctl.end('failed');
      },
    ];
    expect(await h.submit()).toBe('failed');
    expect(getSession(h.db.db, 's_1')?.state).toBe('idle');
    expect(h.eventTypes()).toContain('agent_error');
  });
});

describe('idempotency and ordering', () => {
  it('does not re-run a turn for a redelivered message', async () => {
    // Past `seen_messages`, this is the last line of defence. Re-prompting an agent
    // with write access is not a cosmetic duplicate.
    const h = harness();
    expect(await h.submit('same', 'om_1')).toBe('completed');
    expect(await h.submit('same', 'om_1')).toBe('completed');
    expect(h.driver.lastRuntime?.prompts).toHaveLength(1);
    expect(h.notes.some((n) => n.startsWith('duplicate submit'))).toBe(true);
  });

  it('runs queued prompts one at a time, in order', async () => {
    const h = harness();
    const observed: string[] = [];
    const slow = (label: string) => async (ctl: TurnControl) => {
      observed.push(`start ${label}`);
      await settle();
      observed.push(`end ${label}`);
      ctl.end('completed');
    };
    h.driver.scripts = [slow('a'), slow('b')];
    await Promise.all([h.submit('a', 'om_a'), h.submit('b', 'om_b')]);
    expect(observed).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('refuses a prompt once the mailbox is full, loudly', async () => {
    // Silently dropping it loses the message and leaves the only record in a log
    // file nobody is reading.
    const h = harness();
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

    const inFlight: Array<Promise<string>> = [];
    for (let i = 0; i < MAX_MAILBOX_DEPTH; i += 1) {
      inFlight.push(h.submit(`p${i}`, `om_${i}`));
    }
    await expect(h.submit('one too many', 'om_over')).rejects.toBeInstanceOf(MailboxFull);

    release();
    await Promise.all(inFlight);
  });

  it('keeps the mailbox alive after a rejected prompt', async () => {
    // A dead mailbox reproduces the stuck-session failure the cap exists to
    // prevent, one level down.
    const h = harness();
    setState(h.db.db, 's_1', 'quarantined', NOW);
    await expect(h.submit('held', 'om_1')).rejects.toBeInstanceOf(SessionHeld);

    setState(h.db.db, 's_1', 'idle', NOW);
    expect(await h.submit('after', 'om_2')).toBe('completed');
  });

  it('refuses to auto-resume a quarantined session from the ordinary message path', async () => {
    const h = harness();
    setState(h.db.db, 's_1', 'quarantined', NOW);
    await expect(h.submit()).rejects.toBeInstanceOf(SessionHeld);
    expect(h.driver.starts).toHaveLength(0);
  });

  it('cancels a turn whose generation moved while the runtime was starting', async () => {
    // Prompting a runtime a newer generation owns is how a retired session comes
    // back to life and writes to a workspace it no longer holds.
    const h = harness();
    h.driver.onStart = (): void => {
      h.db.db.prepare('UPDATE sessions SET generation = generation + 1 WHERE id = ?').run('s_1');
    };
    expect(await h.submit()).toBe('cancelled');
    expect(h.driver.lastRuntime?.prompts).toHaveLength(0);
    const ended = h.events().find((e) => e.type === 'turn_ended');
    expect((ended?.payload as { detail?: string }).detail).toContain('superseded');
  });

  it('rejects a submit after close', async () => {
    const h = harness();
    await h.actor.close();
    await expect(h.submit()).rejects.toThrow(/closed/);
  });
});

describe('approvals', () => {
  function askScript(action = 'rm -rf /'): (ctl: TurnControl) => Promise<void> {
    return async (ctl) => {
      const outcome = await ctl.ask(action, [
        { optionId: 'allow', name: 'Allow' },
        { optionId: 'deny', name: 'Deny' },
      ]);
      ctl.emit({ kind: 'message-chunk', text: `outcome:${outcome.kind}` });
      ctl.end('completed');
    };
  }

  /** Start a turn, wait until it is parked on a permission request. */
  async function parked(h: Harness): Promise<{ turn: Promise<string>; approvalId: string }> {
    const turn = h.submit();
    for (let i = 0; i < 50; i += 1) {
      await settle();
      const row = h.events().find((e) => e.type === 'approval_requested');
      if (row !== undefined) {
        return { turn, approvalId: (row.payload as { approvalId: string }).approvalId };
      }
    }
    throw new Error('never parked on an approval');
  }

  function click(
    h: Harness,
    approvalId: string,
    over: { optionId?: string; nonce?: string } = {},
  ): ReturnType<SessionActor['resolveFromCard']> {
    const row = getApproval(h.db.db, approvalId);
    return h.actor.resolveFromCard({
      approvalId,
      optionId: over.optionId ?? 'allow',
      nonce: over.nonce ?? approvalNonce('s_1', approvalId, row?.generation ?? 0),
      principal: CLICKER,
      via: 'lark',
    });
  }

  it('writes the approval before posting the card', async () => {
    // A crash between the two must leave a question we can re-ask, not a button
    // that resolves nothing and cannot be told apart from a forged one.
    const h = harness();
    h.driver.scripts = [askScript()];
    const { turn, approvalId } = await parked(h);
    expect(getApproval(h.db.db, approvalId)?.state).toBe('pending');
    expect(h.channel.approvalCards).toHaveLength(1);

    click(h, approvalId);
    await turn;
  });

  it('releases the agent with the option the human picked', async () => {
    const h = harness();
    h.driver.scripts = [askScript()];
    const { turn, approvalId } = await parked(h);
    const report = click(h, approvalId, { optionId: 'deny' });

    expect(report.kind).toBe('resolved');
    expect(report.unblocked).toBe(true);
    expect(await turn).toBe('completed');
    expect(h.events().some((e) => e.type === 'approval_resolved')).toBe(true);
    const chunk = h.events().find((e) => e.type === 'agent_message_chunk');
    expect((chunk?.payload as { text: string }).text).toBe('outcome:selected');
  });

  it('records who answered and through which channel', async () => {
    const h = harness();
    h.driver.scripts = [askScript()];
    const { turn, approvalId } = await parked(h);
    click(h, approvalId);
    await turn;
    const row = getApproval(h.db.db, approvalId);
    expect(row?.resolvedBy).toBe('on_owner');
    expect(row?.resolvedVia).toBe('lark');
  });

  it('refuses a nonce that does not match', async () => {
    const h = harness();
    h.driver.scripts = [askScript()];
    const { turn, approvalId } = await parked(h);
    const report = click(h, approvalId, { nonce: 'f'.repeat(32) });
    expect(report.kind).toBe('stale');
    expect(report.unblocked).toBe(false);
    expect(getApproval(h.db.db, approvalId)?.state).toBe('pending');

    click(h, approvalId);
    await turn;
  });

  it('refuses a nonce of the wrong length without throwing', async () => {
    // `timingSafeEqual` throws on a length mismatch, so the length check has to
    // happen outside it.
    const h = harness();
    h.driver.scripts = [askScript()];
    const { turn, approvalId } = await parked(h);
    expect(click(h, approvalId, { nonce: 'short' }).kind).toBe('stale');
    click(h, approvalId);
    await turn;
  });

  it('refuses an option the agent never offered', async () => {
    // Buttons come from the offered set, but `action.value` is client-supplied and
    // Lark does not verify it.
    const h = harness();
    h.driver.scripts = [askScript()];
    const { turn, approvalId } = await parked(h);
    const report = click(h, approvalId, { optionId: 'allow_always' });
    expect(report.kind).toBe('bad_option');
    expect(report.unblocked).toBe(false);

    click(h, approvalId);
    await turn;
  });

  it('lets the first answer stand on a second click', async () => {
    const h = harness();
    h.driver.scripts = [askScript()];
    const { turn, approvalId } = await parked(h);
    click(h, approvalId, { optionId: 'allow' });
    const second = click(h, approvalId, { optionId: 'deny' });
    expect(second.kind).toBe('already');
    expect(second.message).toContain('allow');
    expect(second.unblocked).toBe(false);
    await turn;
  });

  it('reports unknown for an approval belonging to another session', async () => {
    // `approvalId` arrives from the client, so without the session check a button in
    // one chat could address another chat's approval.
    const h = harness();
    createSession(
      h.db.db,
      { id: 's_other', agentId: 'fake', workspaceId: 'w', ownerPrincipal: 'on_owner' },
      NOW,
    );
    createTurn(
      h.db.db,
      { sessionId: 's_other', turnId: 't_o', generation: 0, idempotencyKey: 'k' },
      NOW,
    );
    createApproval(
      h.db.db,
      {
        approvalId: 'a_other',
        sessionId: 's_other',
        turnId: 't_o',
        generation: 0,
        action: 'x',
        payload: null,
        options: [{ optionId: 'allow', name: 'Allow' }],
      },
      NOW,
    );

    const report = h.actor.resolveFromCard({
      approvalId: 'a_other',
      optionId: 'allow',
      nonce: approvalNonce('s_other', 'a_other', 0),
      principal: CLICKER,
      via: 'lark',
    });
    expect(report.kind).toBe('unknown');
    expect(getApproval(h.db.db, 'a_other')?.state).toBe('pending');
  });

  it('reports unknown for an id that never existed', () => {
    const h = harness();
    expect(
      h.actor.resolveFromCard({
        approvalId: 'a_nope',
        optionId: 'allow',
        nonce: 'f'.repeat(32),
        principal: CLICKER,
        via: 'lark',
      }).kind,
    ).toBe('unknown');
  });

  it('refuses a click whose session has moved on, even with a valid nonce', () => {
    // The nonce proves the card was not altered. Only the log can say whether what
    // it points at is still current, which is why the CAS is not redundant.
    const h = harness();
    createTurn(h.db.db, { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'k' }, NOW);
    createApproval(
      h.db.db,
      {
        approvalId: 'a_1',
        sessionId: 's_1',
        turnId: 't_1',
        generation: 0,
        action: 'x',
        payload: null,
        options: [{ optionId: 'allow', name: 'Allow' }],
      },
      NOW,
    );
    h.db.db.prepare('UPDATE sessions SET generation = 1 WHERE id = ?').run('s_1');

    const report = click(h, 'a_1');
    expect(report.kind).toBe('stale');
    expect(getApproval(h.db.db, 'a_1')?.state).toBe('pending');
  });

  it('says the answer landed but released nothing when the asker is gone', () => {
    // After a restart the answer is durable and the RPC is not. Saying "done" is a
    // lie the user discovers when nothing happens.
    const h = harness();
    createTurn(h.db.db, { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'k' }, NOW);
    createApproval(
      h.db.db,
      {
        approvalId: 'a_1',
        sessionId: 's_1',
        turnId: 't_1',
        generation: 0,
        action: 'x',
        payload: null,
        options: [{ optionId: 'allow', name: 'Allow' }],
      },
      NOW,
    );

    const report = click(h, 'a_1');
    expect(report.kind).toBe('resolved');
    expect(report.unblocked).toBe(false);
    expect(report.message).toContain('new turn');
  });

  it('releases the agent as cancelled when the card could not be posted', async () => {
    // Leaving it pending hangs the turn on a question nobody ever saw.
    const h = harness();
    h.driver.scripts = [askScript()];
    h.channel.failNext('sendApprovalCard', new ChannelError(230001, 'no permission', false));

    expect(await h.submit()).toBe('completed');
    const chunk = h.events().find((e) => e.type === 'agent_message_chunk');
    expect((chunk?.payload as { text: string }).text).toBe('outcome:cancelled');
    expect(h.eventTypes()).toContain('agent_error');
  });

  it('releases a pending approval when the turn ends without one', async () => {
    // Every failure path has to reach the settle: an exception that skips it does
    // not fail the turn, it blocks the agent forever.
    const h = harness();
    let settled: string | undefined;
    h.driver.scripts = [
      (ctl) => {
        // Deliberately not awaited: the script returns while the request is still
        // pending, so the stream ends with the agent parked on it -- an iterator
        // torn down mid-approval.
        void ctl.ask('x', [{ optionId: 'allow', name: 'Allow' }]).then((outcome) => {
          settled = outcome.kind;
        });
      },
    ];
    // Nobody clicks.
    expect(await h.submit()).toBe('ambiguous');
    await settle();
    expect(settled).toBe('cancelled');
  });

  it('releases pending approvals on cancel, because a blocked agent cannot see one', async () => {
    const h = harness();
    h.driver.scripts = [askScript()];
    const { turn, approvalId } = await parked(h);
    await h.actor.cancel();

    expect(await turn).toBe('completed');
    const chunk = h.events().find((e) => e.type === 'agent_message_chunk');
    expect((chunk?.payload as { text: string }).text).toBe('outcome:cancelled');
    expect(h.driver.lastRuntime?.cancels).toBe(1);
    expect(getApproval(h.db.db, approvalId)?.state).toBe('pending');
  });

  it('marks the turn as awaiting approval while it is parked', async () => {
    const h = harness();
    h.driver.scripts = [askScript()];
    const { turn, approvalId } = await parked(h);
    expect(firstTurn(h).state).toBe('awaiting_approval');
    click(h, approvalId);
    await turn;
    expect(firstTurn(h).state).toBe('completed');
  });
});

describe('cancel', () => {
  it('is a no-op with no runtime', async () => {
    const h = harness();
    await expect(h.actor.cancel()).resolves.toBeUndefined();
  });

  it('does not throw when the runtime refuses to cancel', async () => {
    const h = harness();
    await h.submit();
    const runtime = h.driver.lastRuntime;
    if (runtime === undefined) throw new Error('no runtime');
    runtime.cancel = async (): Promise<void> => {
      throw new Error('pipe closed');
    };
    await expect(h.actor.cancel()).resolves.toBeUndefined();
    expect(h.notes.some((n) => n.includes('cancel failed'))).toBe(true);
  });
});

describe('close', () => {
  it('freezes the card before tearing the runtime down', async () => {
    // The other order leaves a card claiming work is in progress for however long
    // shutdown takes.
    const h = harness();
    await h.submit();
    await h.actor.flushCard();
    await h.actor.close();

    expect(h.channel.calls.at(-1)).toBe('finish');
    expect(h.driver.lastRuntime?.closes).toBe(1);
  });

  it('marks the session cold, because the runtime died with the gateway', async () => {
    const h = harness();
    await h.submit();
    await h.actor.close();
    expect(getSession(h.db.db, 's_1')?.state).toBe('cold');
  });

  it('leaves a quarantined session quarantined', async () => {
    // Downgrading it to cold makes the next boot resume a session that needs a
    // human decision.
    const h = harness();
    h.driver.scripts = [() => undefined];
    await h.submit();
    await h.actor.close();
    expect(getSession(h.db.db, 's_1')?.state).toBe('quarantined');
  });

  it('is idempotent', async () => {
    const h = harness();
    await h.submit();
    await h.actor.close();
    await h.actor.close();
    expect(h.driver.lastRuntime?.closes).toBe(1);
  });

  it('bumps the generation before closing the runtime, as a fencing token', async () => {
    // Bumping afterwards leaves a window in which stale work still looks current.
    const h = harness();
    await h.submit();
    await h.actor.close();
    expect(getSession(h.db.db, 's_1')?.generation).toBe(1);
    expect(h.eventTypes()).toContain('generation_bumped');
  });
});

describe('presence', () => {
  it('is absent before a runtime exists', () => {
    expect(harness().actor.presence).toBe('absent');
  });

  it('is live while a runtime is attached', async () => {
    const h = harness();
    await h.submit();
    expect(h.actor.presence).toBe('live');
  });

  it('distinguishes cold from absent after a close', async () => {
    // Collapsing them is how a dead process falls into the create branch and
    // produces two sessions on one thread.
    const h = harness();
    await h.submit();
    await h.actor.close();
    expect(h.actor.presence).toBe('cold');
  });
});

describe('status', () => {
  it('reports working while a turn is in flight', async () => {
    const h = harness();
    h.driver.scripts = [
      async (ctl) => {
        await settle();
        ctl.end('completed');
      },
    ];
    const turn = h.submit();
    await settle();
    expect(h.actor.status().label).toBe('working');
    await turn;
    expect(h.actor.status().label).toBe('idle');
  });

  it('reports waiting-for-you while parked on an approval', async () => {
    const h = harness();
    h.driver.scripts = [
      async (ctl) => {
        await ctl.ask('x', [{ optionId: 'allow', name: 'Allow' }]);
        ctl.end('completed');
      },
    ];
    const turn = h.submit();
    for (let i = 0; i < 50 && h.actor.status().label !== 'waiting-for-you'; i += 1) await settle();
    expect(h.actor.status().label).toBe('waiting-for-you');
    await h.actor.cancel();
    await turn;
  });
});

describe('replay', () => {
  it('hands the driver the prompts from the log, not its own idea of history', async () => {
    const h = harness();
    await h.submit('first', 'om_1');
    await h.actor.close();

    const revived = new SessionActor({
      db: h.db.db,
      sessionId: 's_1',
      driver: h.driver,
      channel: h.channel,
      key: KEY,
      target: { chatId: KEY.conversationId, threadId: KEY.threadId },
      cwd: '/tmp/workspace',
      clock: h.clock,
    });
    setState(h.db.db, 's_1', 'idle', NOW);
    await revived.submit({ messageId: 'om_2', appId: KEY.appId, input: { text: 'second', paths: [] } });

    expect(h.driver.starts.at(-1)?.replay?.map((p) => p.text)).toEqual(['first']);
    await revived.close();
  });

  it('passes no replay for a session with no history', async () => {
    const h = harness();
    await h.submit();
    expect(h.driver.starts[0]?.replay).toBeUndefined();
  });

  it('truncates a long replay and says so, rather than silently forgetting', async () => {
    // Truncated history nobody was told about looks exactly like an agent that
    // forgot.
    const h = harness();
    for (let i = 0; i <= REPLAY_MAX_TURNS; i += 1) {
      h.db.db
        .prepare(
          `INSERT INTO events (session_id, seq, ts, generation, turn_id, type, actor, payload)
           VALUES (?, ?, ?, 0, ?, 'turn_submitted', 'user', jsonb(?))`,
        )
        .run('s_1', i + 1, NOW, `t_old_${i}`, JSON.stringify({ text: `p${i}`, paths: [] }));
    }
    h.db.db.prepare('UPDATE sessions SET last_seq = ? WHERE id = ?').run(REPLAY_MAX_TURNS + 1, 's_1');

    await h.submit('now', 'om_now');
    expect(h.driver.starts[0]?.replay).toHaveLength(REPLAY_MAX_TURNS);
    // The oldest is the one dropped: recent context is what a resumed turn needs.
    expect(h.driver.starts[0]?.replay?.[0]?.text).toBe('p1');
    expect(h.notes.some((n) => n.includes('replay truncated'))).toBe(true);
  });
});

// -- helpers ----------------------------------------------------------------

function firstTurn(h: Harness): { state: string; terminal: string | null } {
  const row = h.db.db
    .prepare('SELECT state, terminal FROM turns WHERE session_id = ? ORDER BY submitted_at LIMIT 1')
    .get('s_1') as { state: string; terminal: string | null } | undefined;
  if (row === undefined) throw new Error('no turn');
  return row;
}
