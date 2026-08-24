import { afterEach, describe, expect, it } from 'vitest';
import { Router } from '../src/core/router.js';
import { SessionRegistry } from '../src/core/registry.js';
import { MAX_MAILBOX_DEPTH, type SessionActor } from '../src/core/session-actor.js';
import { approvalNonce, replyUuid } from '../src/core/ids.js';
import { Authorizer, defaultAuthConfig, type AuthConfig, type Decision } from '../src/policy/auth.js';
import { getApproval, pendingForSession } from '../src/db/approvals.js';
import { resolveBinding } from '../src/db/bindings.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import { setState } from '../src/db/sessions.js';
import type { Db } from '../src/db/open.js';
import type { InboundMessage, PermissionOption, Principal } from '../src/types.js';
import type { Workspace, WorkspaceProvider } from '../src/core/workspace.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver, type TurnControl } from './helpers/driver.js';
import { ManualClock, settle, testDb, type TestDb } from './helpers/db.js';

/**
 * The router's job is the boring-looking part where every mistake is expensive:
 * claim before policy, silence for refusals about *who* you are, an explanation
 * for refusals about *what* you asked, and a mutating verb that refuses rather
 * than races the actor.
 *
 * Every test here goes in through `onMessage`/`onCardAction` -- the two entry
 * points a real Lark event reaches -- because the invariants are about the order
 * those two do things in, not about any one step.
 */

const NOW = 1_760_000_000_000;
const APP = 'cli_app';
const CHAT = 'oc_chat';
const CHANNEL = 'lark';

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };

const OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow', name: 'Allow once' },
  { optionId: 'deny', name: 'Deny' },
];

class FakeWorkspaces implements WorkspaceProvider {
  readonly kind = 'plain-dir' as const;

  async acquire(sessionId: string): Promise<Workspace> {
    void sessionId;
    return { id: 'plain-dir:test', kind: this.kind, cwd: '/tmp/workspace' };
  }

  async release(sessionId: string): Promise<void> {
    void sessionId;
  }
}

interface Harness {
  db: Db;
  router: Router;
  registry: SessionRegistry;
  channel: FakeChannel;
  driver: FakeDriver;
  clock: ManualClock;
  notes: string[];
  authorizer: Authorizer;
}

const open: TestDb[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function harness(
  opts: { auth?: Partial<AuthConfig>; authorizer?: Authorizer } = {},
): Harness {
  const t = testDb();
  open.push(t);
  const clock = new ManualClock(NOW);
  const channel = new FakeChannel({ clock });
  const driver = new FakeDriver();
  const notes: string[] = [];
  const authorizer =
    opts.authorizer ?? new Authorizer({ ...defaultAuthConfig(OWNER.openId), ...opts.auth });
  const registry = new SessionRegistry({
    db: t.db,
    driver,
    channel,
    workspaces: new FakeWorkspaces(),
    channelId: CHANNEL,
    appId: APP,
    clock,
    note: (line) => notes.push(line),
  });
  const router = new Router({
    db: t.db,
    registry,
    authorizer,
    channel,
    channelId: CHANNEL,
    appId: APP,
    clock,
    note: (line) => notes.push(line),
  });
  return { db: t.db, router, registry, channel, driver, clock, notes, authorizer };
}

let seq = 0;

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: `om_${++seq}`,
    appId: APP,
    chatId: CHAT,
    chatType: 'p2p',
    threadId: '',
    sender: OWNER,
    senderIsBot: false,
    text: 'do the thing',
    mentionedBot: false,
    mentionAll: false,
    attachments: [],
    createTime: NOW,
    ...over,
  };
}

/** Let the un-awaited submit chain, the driver script and the card writer run. */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await settle();
}

function lastReply(h: Harness): string {
  return h.channel.texts.at(-1)?.text ?? '';
}

function sessionCount(h: Harness): number {
  return (h.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;
}

function boundSessionId(h: Harness, threadId = ''): string | undefined {
  return resolveBinding(h.db, {
    channel: CHANNEL,
    appId: APP,
    conversationId: CHAT,
    threadId,
  })?.sessionId;
}

/** A session with a live actor and a turn that never ends. */
async function working(h: Harness): Promise<{ sessionId: string; actor: SessionActor }> {
  h.driver.scripts = [() => new Promise<void>(() => undefined)];
  await h.router.onMessage(msg({ text: 'long one' }));
  await flush();
  const sessionId = boundSessionId(h);
  if (sessionId === undefined) throw new Error('nothing bound');
  const actor = h.registry.liveActor(sessionId);
  if (actor === undefined) throw new Error('no live actor');
  return { sessionId, actor };
}

describe('Router: dedup', () => {
  it('turns a redelivery into one turn and says so', async () => {
    const h = harness();
    const message = msg({ text: 'once' });

    await h.router.onMessage(message);
    await flush();
    await h.router.onMessage(message);
    await flush();

    expect(h.driver.lastRuntime?.prompts.map((p) => p.text)).toEqual(['once']);
    expect(h.notes.some((n) => n.includes('duplicate delivery'))).toBe(true);
  });

  it('claims the message before policy runs, so a throwing check cannot loop', async () => {
    // Store-first is not an optimization. Checking policy first works right up
    // until the policy check itself throws -- and then Feishu's re-push ladder
    // delivers the same message four more times over six hours.
    class ThrowingAuth extends Authorizer {
      override admits(): Decision {
        throw new Error('policy exploded');
      }
    }
    const h = harness({ authorizer: new ThrowingAuth(defaultAuthConfig(OWNER.openId)) });
    const message = msg();

    await h.router.onMessage(message);
    await h.router.onMessage(message);

    expect(h.notes.filter((n) => n.includes('policy exploded'))).toHaveLength(1);
    expect(h.notes.some((n) => n.includes('duplicate delivery'))).toBe(true);
  });

  it('does not dedup card clicks, because two clicks are two intents', async () => {
    const h = harness();
    const { approvalId, nonce } = await ask(h);

    const first = await h.router.onCardAction(click(approvalId, 'allow', nonce));
    const second = await h.router.onCardAction(click(approvalId, 'allow', nonce));

    expect(first).toContain('Sent');
    // The second is refused by `resolveApproval`, not by `seen_messages`: the
    // first answer stands, and the user is told which one it was.
    expect(second).toContain('Already answered');
  });
});

describe('Router: refusals', () => {
  it('stays silent about who the sender is', async () => {
    const h = harness();
    await h.router.onMessage(msg({ sender: GUEST }));
    // Replying would confirm the bot is present and listening to someone who was
    // not supposed to have its attention.
    expect(h.channel.calls).toEqual([]);
  });

  it('stays silent in a group it was not addressed in', async () => {
    const h = harness();
    await h.router.onMessage(msg({ chatType: 'group', mentionedBot: false }));
    expect(h.channel.calls).toEqual([]);
  });

  it('explains a refusal about what was asked', async () => {
    const h = harness();
    await h.router.onMessage(
      msg({ chatType: 'group', mentionedBot: true, mentionAll: true }),
    );
    // This one goes to someone already allowed to talk, who otherwise sees the
    // bot ignore them for no visible reason.
    expect(lastReply(h)).toContain('@all');
  });

  it('explains a disabled direct message', async () => {
    const h = harness({ auth: { allowDirectMessages: false } });
    await h.router.onMessage(msg());
    expect(lastReply(h)).toContain('Direct messages are disabled');
  });

  it('never creates a session to have somewhere to log a refusal', async () => {
    const h = harness();
    await h.router.onMessage(msg({ sender: GUEST }));
    // Otherwise an unauthorized sender allocates sessions by being refused, which
    // is a denial-of-service with extra steps.
    expect(sessionCount(h)).toBe(0);
    // Naming the sender is the point of the line: the first-run failure is an owner
    // id that does not match, and the id needed to fix it is the one being refused.
    const note = h.notes.find((n) => n.includes('with no bound session'));
    expect(note).toBeDefined();
    expect(note).toContain(GUEST.openId);
  });

  it('logs a refusal into the session that already exists, sender only', async () => {
    const h = harness({ auth: { allowTalk: [OWNER.openId, GUEST.openId] } });
    await h.router.onMessage(msg({ text: 'hello' }));
    await flush();
    const sessionId = boundSessionId(h);
    expect(sessionId).toBeDefined();

    h.authorizer.reconfigure(defaultAuthConfig(OWNER.openId));
    await h.router.onMessage(msg({ sender: GUEST, text: 'secret plan' }));

    const events = readEvents(h.db, sessionId ?? '', 0, lastSeq(h.db, sessionId ?? ''));
    const rejected = events.filter((e) => e.type === 'policy_rejected');
    expect(rejected).toHaveLength(1);
    const payload = rejected[0]?.payload as { reason: string; sender: string };
    expect(payload.reason).toBe('sender_not_allowed');
    expect(payload.sender).toBe(GUEST.openId);
    // A rejected message was never accepted. Storing its body would keep exactly
    // the data we just declined to act on.
    expect(JSON.stringify(rejected[0]?.payload)).not.toContain('secret plan');
  });
});

describe('Router: commands', () => {
  it('refuses an unknown command instead of forwarding it as a prompt', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/statsu' }));
    expect(lastReply(h)).toContain('/statsu');
    expect(lastReply(h)).toContain('/help');
    expect(sessionCount(h)).toBe(0);
  });

  it('escapes the unknown command name it echoes back', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/no_such_thing' }));
    // The name is user-authored text on its way into a markdown render.
    expect(lastReply(h)).toContain('no\\_such\\_thing');
  });

  it('lists commands with their tier', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/help' }));
    expect(lastReply(h)).toContain('/new');
    expect(lastReply(h)).toContain('operator');
  });

  it('answers /status without a session rather than creating one', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/status' }));
    expect(lastReply(h)).toBe('No session here yet.');
    expect(sessionCount(h)).toBe(0);
  });

  it('reports the projected status, not a state name', async () => {
    const h = harness();
    await working(h);
    await h.router.onMessage(msg({ text: '/status' }));
    expect(lastReply(h)).toContain('**working**');
    expect(lastReply(h)).toContain('1 open turn(s)');
  });

  it('says so when nothing is bound in the chat', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/sessions' }));
    expect(lastReply(h)).toBe('No sessions bound in this chat.');
  });

  it('marks which of the chat sessions is the one you are in', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'chat scope' }));
    await flush();
    await h.router.onMessage(msg({ text: 'in a thread', threadId: 'omt_1' }));
    await flush();

    await h.router.onMessage(msg({ text: '/sessions', threadId: 'omt_1' }));
    const reply = lastReply(h);
    expect(reply).toContain(boundSessionId(h, '') ?? 'missing');
    expect(reply).toContain(boundSessionId(h, 'omt_1') ?? 'missing');
    expect(reply.split('\n').filter((l) => l.includes('(here)'))).toHaveLength(1);
    expect(reply).toContain('thread `omt_1` (here)');
  });

  it('rotates on /new and says the old session is recoverable', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const before = boundSessionId(h);

    await h.router.onMessage(msg({ text: '/new' }));
    const after = boundSessionId(h);

    expect(after).not.toBe(before);
    expect(lastReply(h)).toContain(after ?? 'missing');
    expect(lastReply(h)).toContain('archived, not deleted');
  });

  it('shows usage for /attach with no argument', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/attach' }));
    expect(lastReply(h)).toContain('Usage:');
    expect(boundSessionId(h)).toBeUndefined();
  });

  it('passes an attach refusal straight through to the chat', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/attach s_nope' }));
    expect(lastReply(h)).toBe('No session s_nope.');
  });

  it('rebinds the thread on a successful /attach', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const first = boundSessionId(h) ?? '';
    await h.router.onMessage(msg({ text: '/new' }));

    await h.router.onMessage(msg({ text: `/attach ${first}` }));

    expect(boundSessionId(h)).toBe(first);
    expect(lastReply(h)).toContain('History replays');
  });

  it('asks for a session before acting on one', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/stop' }));
    expect(lastReply(h)).toBe('Nothing is bound here yet. Send a message first.');
  });

  it('says nothing is running when the session has no runtime', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    await h.registry.release(boundSessionId(h) ?? '');

    await h.router.onMessage(msg({ text: '/stop' }));

    // A resumable session with nothing attached. Starting one just to cancel it
    // would be the opposite of what was asked.
    expect(lastReply(h)).toBe('Nothing is running.');
    expect(h.driver.starts).toHaveLength(1);
  });

  it('cancels a turn in flight and calls cancellation a terminal', async () => {
    const h = harness();
    const { actor } = await working(h);

    await h.router.onMessage(msg({ text: '/stop' }));

    expect(h.driver.lastRuntime?.cancels).toBe(1);
    expect(lastReply(h)).toContain('not a deletion');
    // `/stop` is not a mutating verb: refusing it mid-turn would refuse it in
    // exactly the situation it exists for.
    expect(actor.status().busy).toBe(true);
  });

  it('admits that /cd is unavailable instead of silently succeeding', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();

    await h.router.onMessage(msg({ text: '/cd /somewhere/else' }));

    expect(lastReply(h)).toContain('Not available in this build');
  });

  it('refuses an operate verb to a talk-tier sender, and changes nothing', async () => {
    const h = harness({
      auth: { allowTalk: [OWNER.openId, GUEST.openId], allowOperate: [OWNER.openId] },
    });
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const before = boundSessionId(h);

    await h.router.onMessage(msg({ text: '/new', sender: GUEST }));

    expect(lastReply(h)).toContain('operator permission');
    expect(boundSessionId(h)).toBe(before);
  });

  it('records a tier refusal with the command that was refused', async () => {
    const h = harness({
      auth: { allowTalk: [OWNER.openId, GUEST.openId], allowOperate: [OWNER.openId] },
    });
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const sessionId = boundSessionId(h) ?? '';

    await h.router.onMessage(msg({ text: '/new', sender: GUEST }));

    const events = readEvents(h.db, sessionId, 0, lastSeq(h.db, sessionId));
    const payload = events.filter((e) => e.type === 'policy_rejected').at(-1)?.payload as {
      reason: string;
      detail: string;
    };
    expect(payload.reason).toBe('insufficient_tier');
    expect(payload.detail).toContain('new:');
  });

  it('refuses a mutating verb mid-turn rather than racing the actor', async () => {
    const h = harness();
    await working(h);
    const before = boundSessionId(h);

    await h.router.onMessage(msg({ text: '/new' }));

    // Bypassing means two writers for one session, and the loser's write is the
    // one the user asked for.
    expect(lastReply(h)).toContain('Busy (working)');
    expect(boundSessionId(h)).toBe(before);
  });

  it('names the approval when that is what the user has to do', async () => {
    const h = harness();
    await ask(h);

    await h.router.onMessage(msg({ text: '/new' }));

    expect(lastReply(h)).toContain('pending approval');
  });

  it('lets a read-only verb through mid-turn', async () => {
    const h = harness();
    await working(h);
    await h.router.onMessage(msg({ text: '/sessions' }));
    expect(lastReply(h)).toContain('(here)');
  });

  it('allows a mutating verb once the actor is idle', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    expect(h.registry.liveActor(boundSessionId(h) ?? '')?.status().busy).toBe(false);

    await h.router.onMessage(msg({ text: '/new' }));

    expect(lastReply(h)).toContain('Fresh session');
  });
});

describe('Router: prompts', () => {
  it('refuses an empty message instead of burning a turn on it', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '   ' }));
    expect(lastReply(h)).toBe('That message had nothing in it.');
    expect(sessionCount(h)).toBe(0);
  });

  it('submits an attachment-only message, passing the downloaded paths', async () => {
    const h = harness();
    await h.router.onMessage(
      msg({
        text: '',
        attachments: [
          { fileKey: 'f1', kind: 'image', name: 'a.png', localPath: '/tmp/a.png' },
          // Not downloaded. Attachments are injected as paths, so one without a
          // path is nothing the agent can open.
          { fileKey: 'f2', kind: 'file', name: 'b.pdf' },
        ],
      }),
    );
    await flush();

    expect(h.driver.lastRuntime?.prompts.at(0)?.paths).toEqual(['/tmp/a.png']);
  });

  it('keeps chat order across two messages arriving together', async () => {
    const h = harness();
    // The ingress lane is chat-wide because a topic's seed message carries no
    // thread_id yet: you cannot key a lane on a session you have not identified.
    await Promise.all([
      h.router.onMessage(msg({ text: 'one' })),
      h.router.onMessage(msg({ text: 'two' })),
    ]);
    await flush(20);

    expect(h.driver.lastRuntime?.prompts.map((p) => p.text)).toEqual(['one', 'two']);
  });

  it('tells the user when the mailbox is full', async () => {
    const h = harness();
    h.driver.scripts = [() => new Promise<void>(() => undefined)];
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const actor = h.registry.liveActor(boundSessionId(h) ?? '');
    if (actor === undefined) throw new Error('no actor');
    for (let i = 0; i < MAX_MAILBOX_DEPTH - 1; i += 1) {
      void actor
        .submit({ messageId: `om_fill_${i}`, appId: APP, input: { text: 'fill', paths: [] } })
        .catch(() => undefined);
    }

    await h.router.onMessage(msg({ text: 'one too many' }));
    await flush();

    expect(lastReply(h)).toContain('queue of prompts waiting');
  });

  it('explains a held session rather than resuming it', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const sessionId = boundSessionId(h) ?? '';
    await h.registry.release(sessionId);
    setState(h.db, sessionId, 'quarantined', NOW);

    await h.router.onMessage(msg({ text: 'carry on' }));
    await flush();

    expect(lastReply(h)).toContain('held');
    expect(lastReply(h)).toContain('/new');
    // Held means held: the refusal happens before anything starts.
    expect(h.driver.starts).toHaveLength(1);
  });

  it('reports an unexpected submit failure with the reason', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const actor = h.registry.liveActor(boundSessionId(h) ?? '');
    // Closed but still in the registry, which is what a shutdown race looks like.
    await actor?.close();

    await h.router.onMessage(msg({ text: 'after close' }));
    await flush();

    expect(lastReply(h)).toContain('Could not run that:');
    expect(lastReply(h)).toContain('is closed');
  });

  it('keys a control reply on the message and its purpose', async () => {
    const h = harness();
    const message = msg({ text: '/help' });
    await h.router.onMessage(message);

    // Feishu re-pushes an unacknowledged event four times over six hours. The
    // uuid is what turns those into one visible reply.
    expect(h.channel.texts.at(-1)?.uuid).toBe(replyUuid(APP, message.messageId, 'help'));
  });

  it('does not fail a message because its reply failed', async () => {
    const h = harness();
    h.channel.failNext('sendText', new Error('rate limited'));

    await h.router.onMessage(msg({ text: '/help' }));

    expect(h.notes.some((n) => n.includes('reply (help) failed'))).toBe(true);
  });
});

describe('Router: card actions', () => {
  it('refuses a button with no payload', async () => {
    const h = harness();
    expect(await h.router.onCardAction(click('', '', ''))).toContain('missing its payload');
  });

  it('requires operator tier to answer, the same as the equivalent command', async () => {
    const h = harness({
      auth: { allowTalk: [OWNER.openId, GUEST.openId], allowOperate: [OWNER.openId] },
    });
    const { approvalId, nonce } = await ask(h);

    const reply = await h.router.onCardAction({
      ...click(approvalId, 'allow', nonce),
      operator: GUEST,
    });

    // A card is a different input surface, not a different permission model.
    expect(reply).toContain('operator permission');
    expect(pendingForSession(h.db, boundSessionId(h) ?? '')).toHaveLength(1);
  });

  it('refuses an approval id it has never seen', async () => {
    const h = harness();
    await ask(h);
    expect(await h.router.onCardAction(click('a_nope', 'allow', 'n'))).toContain(
      'no longer exists',
    );
  });

  it('refuses a click on a session no chat points at any more', async () => {
    const h = harness();
    const { approvalId, nonce } = await ask(h);
    // `/new` revokes the binding. Inventing one to satisfy the click would
    // resurrect a session the user retired.
    await h.registry.rotate(
      { channel: CHANNEL, appId: APP, conversationId: CHAT, threadId: '' },
      OWNER,
    );

    expect(await h.router.onCardAction(click(approvalId, 'allow', nonce))).toContain(
      'no longer bound',
    );
  });

  it('releases the agent with the option that was clicked', async () => {
    const h = harness();
    const state = await ask(h);

    const reply = await h.router.onCardAction(click(state.approvalId, 'deny', state.nonce));
    await flush();

    expect(reply).toBe('Sent: deny.');
    expect(state.outcome()).toEqual({ kind: 'selected', optionId: 'deny' });
    const row = getApproval(h.db, state.approvalId);
    expect(row?.state).toBe('resolved');
    // Identity comes from `operator.openId` on the callback, never from the card
    // payload, which Lark does not verify.
    expect(row?.resolvedBy).toBe(OWNER.unionId);
    expect(row?.resolvedVia).toBe(CHANNEL);
  });

  it('refuses an option the agent did not offer', async () => {
    const h = harness();
    const { approvalId, nonce } = await ask(h);
    expect(await h.router.onCardAction(click(approvalId, 'allow_everything', nonce))).toContain(
      'not one of the offered options',
    );
  });

  it('refuses a button from an earlier run of the session', async () => {
    const h = harness();
    const { approvalId } = await ask(h);
    expect(await h.router.onCardAction(click(approvalId, 'allow', 'not-the-nonce'))).toContain(
      'earlier run',
    );
  });
});

// ---------------------------------------------------------------------------
// Approval helpers
// ---------------------------------------------------------------------------

interface AskState {
  sessionId: string;
  approvalId: string;
  nonce: string;
  outcome: () => unknown;
}

/** Drive a turn to a pending permission request and return what a card would carry. */
async function ask(h: Harness): Promise<AskState> {
  let outcome: unknown;
  h.driver.scripts = [
    async (ctl: TurnControl) => {
      outcome = await ctl.ask('rm -rf /', OPTIONS);
      ctl.end('completed');
    },
  ];
  await h.router.onMessage(msg({ text: 'please delete everything' }));

  const sessionId = boundSessionId(h) ?? '';
  let row = pendingForSession(h.db, sessionId).at(0);
  for (let i = 0; i < 40 && row === undefined; i += 1) {
    await settle();
    row = pendingForSession(h.db, sessionId).at(0);
  }
  if (row === undefined) throw new Error('no approval was requested');

  return {
    sessionId,
    approvalId: row.approvalId,
    nonce: approvalNonce(sessionId, row.approvalId, row.generation),
    outcome: () => outcome,
  };
}

function click(
  approvalId: string,
  optionId: string,
  nonce: string,
): { chatId: string; messageId: string; operator: Principal; value: Record<string, unknown> } {
  return {
    chatId: CHAT,
    messageId: 'om_click',
    operator: OWNER,
    value: { approvalId, optionId, nonce },
  };
}
