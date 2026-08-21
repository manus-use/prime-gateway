import type { InboundMessage, Principal, RejectReason, Tier } from '../types.js';

/**
 * Authorization. Two tiers, one write path, closed by default.
 *
 * The three properties below are each stated explicitly because each one is easy
 * to get backwards, and getting any of them backwards fails *open*.
 */

export interface AuthConfig {
  /**
   * `open_id`s permitted to drive the agent.
   *
   * **Empty means closed, not unrestricted.** An empty list reads naturally as "no
   * restrictions configured", which is the opposite of what a missing allowlist
   * should mean. A gateway that starts wide open because its config was
   * incomplete is worse than one that answers nobody.
   */
  allowTalk: readonly string[];
  /** `open_id`s permitted to run mutating control verbs. Must also be in `allowTalk`. */
  allowOperate: readonly string[];
  /**
   * Raw `open_id` of the owner, stored unresolved.
   *
   * Never passed through the contact API, so it stays a usable DM target even when
   * identity resolution is broken -- which is exactly when someone needs to be
   * told the gateway is unhappy.
   */
  ownerOpenId: string;
  /** Chats the bot will act in. Empty means any chat. */
  allowChats: readonly string[];
  /** Bot senders permitted to drive the agent. Almost always empty. */
  allowBots: readonly string[];
  /** Whether a direct message may drive the agent without an explicit @-mention. */
  allowDirectMessages: boolean;
  /** Whether `@all` may trigger the bot. Default false. */
  allowMentionAll: boolean;
}

export function defaultAuthConfig(ownerOpenId: string): AuthConfig {
  return {
    allowTalk: [ownerOpenId],
    allowOperate: [ownerOpenId],
    ownerOpenId,
    allowChats: [],
    allowBots: [],
    allowDirectMessages: true,
    allowMentionAll: false,
  };
}

export type Decision = { ok: true } | { ok: false; reason: RejectReason; detail: string };

const OK: Decision = { ok: true };

/**
 * The single entry point for every inbound authorization question.
 *
 * One function, not a set of predicates called from various places. A second
 * entry point is how a boundary gets silently reopened: the first check is
 * tightened, the second is forgotten, and the forgotten one is the one the
 * request actually takes.
 */
export class Authorizer {
  #config: AuthConfig;

  constructor(config: AuthConfig) {
    this.#config = config;
  }

  /**
   * Replace the configuration.
   *
   * The only mutation path. Allowlist edits do not come from chat, so there is no
   * command that reaches this -- a chat-editable allowlist means whoever gets in
   * once can keep themselves in.
   */
  reconfigure(config: AuthConfig): void {
    this.#config = config;
  }

  get ownerOpenId(): string {
    return this.#config.ownerOpenId;
  }

  canTalk(principal: Principal): boolean {
    return this.#config.allowTalk.includes(principal.openId);
  }

  /**
   * Whether a principal may run a mutating verb.
   *
   * Requires `canTalk` as well. An operate entry that is not also a talk entry
   * would otherwise let someone `/clear` a session they cannot even read.
   */
  canOperate(principal: Principal): boolean {
    return this.canTalk(principal) && this.#config.allowOperate.includes(principal.openId);
  }

  hasTier(principal: Principal, tier: Tier): boolean {
    return tier === 'operate' ? this.canOperate(principal) : this.canTalk(principal);
  }

  /**
   * Should this message be acted on at all?
   *
   * Ordered cheapest-and-most-categorical first. The bot-sender check leads
   * because two bots @-ing each other loop forever, and a loop that is also
   * authorized is a loop that runs until someone notices the bill.
   */
  admits(message: InboundMessage): Decision {
    const cfg = this.#config;

    if (message.senderIsBot && !cfg.allowBots.includes(message.sender.openId)) {
      return {
        ok: false,
        reason: 'bot_sender',
        detail: 'Message came from a bot, which is not allowlisted.',
      };
    }

    if (cfg.allowChats.length > 0 && !cfg.allowChats.includes(message.chatId)) {
      return { ok: false, reason: 'chat_not_allowed', detail: 'This chat is not allowlisted.' };
    }

    if (message.chatType === 'p2p') {
      if (!cfg.allowDirectMessages) {
        return { ok: false, reason: 'dm_disabled', detail: 'Direct messages are disabled.' };
      }
    } else {
      // In a group, an unmentioned message is not addressed to us. Acting on it
      // would make the bot answer every message in the room.
      if (!message.mentionedBot) {
        return { ok: false, reason: 'no_mention', detail: 'Not mentioned.' };
      }
      if (message.mentionAll && !cfg.allowMentionAll) {
        return {
          ok: false,
          reason: 'mention_all_blocked',
          detail: '@all does not trigger the bot.',
        };
      }
    }

    if (!this.canTalk(message.sender)) {
      return {
        ok: false,
        reason: 'sender_not_allowed',
        detail: 'You are not on the allowlist.',
      };
    }

    return OK;
  }

  /** Tier check for a command, after `admits` has already passed. */
  admitsTier(principal: Principal, tier: Tier): Decision {
    if (this.hasTier(principal, tier)) return OK;
    return {
      ok: false,
      reason: 'insufficient_tier',
      detail:
        tier === 'operate'
          ? 'That command changes session state and needs operator permission.'
          : 'You are not on the allowlist.',
    };
  }
}

/**
 * Merge freshly resolved identities into an allowlist, keeping last-known-good
 * entries for anything that failed to resolve.
 *
 * The fallback is the point. Re-resolving an allowlist at boot means a transient
 * contact-API failure can return an empty set, and an allowlist that empties
 * itself locks the owner out of the only tool they have for fixing it. Per-entry
 * last-known-good means a blip degrades to stale data rather than to no data.
 */
export function mergeResolved(
  previous: readonly string[],
  resolved: ReadonlyMap<string, string | undefined>,
): string[] {
  const out: string[] = [];
  for (const entry of previous) {
    const fresh = resolved.get(entry);
    out.push(fresh ?? entry);
  }
  return [...new Set(out)];
}
