import { describe, expect, it } from 'vitest';
import { Authorizer, defaultAuthConfig, mergeResolved, type AuthConfig } from '../src/policy/auth.js';
import type { InboundMessage, Principal } from '../src/types.js';

const OWNER = 'ou_owner';

function principal(openId: string): Principal {
  return { openId, unionId: `on_${openId}`, displayName: null };
}

function message(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'om_1',
    appId: 'cli_app',
    chatId: 'oc_chat',
    chatType: 'p2p',
    threadId: '',
    sender: principal(OWNER),
    senderIsBot: false,
    text: 'hello',
    mentionedBot: false,
    mentionAll: false,
    attachments: [],
    createTime: 1_760_000_000_000,
    ...over,
  };
}

function auth(over: Partial<AuthConfig> = {}): Authorizer {
  return new Authorizer({ ...defaultAuthConfig(OWNER), ...over });
}

describe('Authorizer.admits', () => {
  it('admits the owner in a direct message', () => {
    expect(auth().admits(message())).toEqual({ ok: true });
  });

  it('is closed when the allowlist is empty', () => {
    // An empty list reads naturally as "no restrictions configured", which is the
    // opposite of what a missing allowlist must mean.
    const decision = auth({ allowTalk: [], allowOperate: [] }).admits(message());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('sender_not_allowed');
  });

  it('rejects a bot sender before anything else', () => {
    // Two bots @-ing each other loop until someone notices the bill, and an
    // authorized loop is the expensive kind.
    const decision = auth().admits(message({ senderIsBot: true }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('bot_sender');
  });

  it('lets an explicitly allowlisted bot through', () => {
    expect(auth({ allowBots: [OWNER] }).admits(message({ senderIsBot: true }))).toEqual({ ok: true });
  });

  it('rejects a bot sender even when the chat is also not allowlisted', () => {
    // Ordering claim: the bot check is first, so its reason is the one reported.
    const decision = auth({ allowChats: ['oc_other'] }).admits(
      message({ senderIsBot: true, chatId: 'oc_chat' }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('bot_sender');
  });

  it('treats an empty chat allowlist as any chat', () => {
    expect(auth().admits(message({ chatId: 'oc_anything' }))).toEqual({ ok: true });
  });

  it('honours a non-empty chat allowlist', () => {
    const decision = auth({ allowChats: ['oc_only'] }).admits(message());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('chat_not_allowed');
  });

  it('ignores an unmentioned group message', () => {
    // Acting on it would make the bot answer every message in the room.
    const decision = auth().admits(message({ chatType: 'group', mentionedBot: false }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('no_mention');
  });

  it('does not treat @all as an instruction by default', () => {
    const decision = auth().admits(
      message({ chatType: 'group', mentionedBot: true, mentionAll: true }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('mention_all_blocked');
  });

  it('allows @all when explicitly configured', () => {
    expect(
      auth({ allowMentionAll: true }).admits(
        message({ chatType: 'group', mentionedBot: true, mentionAll: true }),
      ),
    ).toEqual({ ok: true });
  });

  it('can disable direct messages', () => {
    const decision = auth({ allowDirectMessages: false }).admits(message());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('dm_disabled');
  });

  it('does not require a mention in a direct message', () => {
    expect(auth().admits(message({ chatType: 'p2p', mentionedBot: false }))).toEqual({ ok: true });
  });
});

describe('tiers', () => {
  it('requires talk before operate', () => {
    // An operate entry that is not also a talk entry would let someone mutate a
    // session they cannot read.
    const a = auth({ allowTalk: [OWNER], allowOperate: [OWNER, 'ou_sneaky'] });
    expect(a.canOperate(principal('ou_sneaky'))).toBe(false);
    expect(a.canTalk(principal('ou_sneaky'))).toBe(false);
  });

  it('separates talk from operate for an ordinary allowlisted user', () => {
    const a = auth({ allowTalk: [OWNER, 'ou_reader'], allowOperate: [OWNER] });
    expect(a.canTalk(principal('ou_reader'))).toBe(true);
    expect(a.canOperate(principal('ou_reader'))).toBe(false);
    const decision = a.admitsTier(principal('ou_reader'), 'operate');
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.detail).toContain('operator permission');
  });

  it('keys on open_id, the app-scoped handle the callback actually carries', () => {
    const a = auth({ allowTalk: ['ou_x'], allowOperate: ['ou_x'] });
    expect(a.canTalk({ openId: 'ou_x', unionId: 'on_other', displayName: null })).toBe(true);
    expect(a.canTalk({ openId: 'on_other', unionId: 'on_other', displayName: null })).toBe(false);
  });
});

describe('mergeResolved', () => {
  it('keeps the previous entry when resolution failed', () => {
    // An allowlist that empties itself on a transient contact-API failure locks the
    // owner out of the only tool they have for fixing it.
    expect(mergeResolved(['a', 'b'], new Map([['a', undefined]]))).toEqual(['a', 'b']);
  });

  it('substitutes a freshly resolved id and de-duplicates', () => {
    expect(
      mergeResolved(
        ['a', 'b'],
        new Map([
          ['a', 'z'],
          ['b', 'z'],
        ]),
      ),
    ).toEqual(['z']);
  });
});
