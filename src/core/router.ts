import type { Db } from '../db/open.js';
import { appendEvent } from '../db/events.js';
import { claimMessage, recordOutcome } from '../db/dedup.js';
import { getApproval } from '../db/approvals.js';
import { bindingsInConversation, resolveBinding } from '../db/bindings.js';
import type { Channel, SendTarget } from '../channel/types.js';
import { forDisplay, truncate } from '../channel/escape.js';
import type { BindingKey, InboundMessage, Principal, RejectReason } from '../types.js';
import type { Authorizer } from '../policy/auth.js';
import { parseCommand, renderHelp, type CommandSpec } from './commands.js';
import { replyUuid } from './ids.js';
import { LaneShed, Lanes } from './lane.js';
import { MailboxFull, SessionHeld, type SessionActor } from './session-actor.js';
import { canMutate } from './status.js';
import type { SessionRegistry } from './registry.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

/**
 * Inbound routing: dedup, policy, commands, prompts.
 *
 * ### Ordering, in two lanes
 *
 * 1. A **chat-wide** lane, held across routing. It has to be chat-wide rather than
 *    per-thread because a topic's seed message carries no `thread_id` yet -- you
 *    cannot key a lane on a session you have not identified. Held only until the
 *    prompt is *queued*, never for the length of the turn, or one slow turn would
 *    stall every other thread in the chat.
 * 2. A **per-session** lane, which is the actor's own mailbox. There is no second
 *    `Lanes` instance for it, deliberately: the actor is already the single writer,
 *    and a lane in front of it would be a second queue with its own ordering to get
 *    wrong.
 *
 * ### Store first
 *
 * `claimMessage` runs before any policy check and before any reply. Feishu re-pushes
 * an unacknowledged event at 15s, 5min, 1h and 6h, so the durable claim is what
 * turns four deliveries into one turn. Checking policy first would work too, right
 * up until the policy check itself throws.
 */

export interface InboundCardAction {
  chatId: string;
  messageId: string;
  /** From `operator.openId`. Never from the card payload. */
  operator: Principal;
  /**
   * `action.value`, as it came back.
   *
   * Round-tripped through the client and **not verified by Lark**. Every field here
   * is untrusted: a pointer at most, never a claim about who clicked.
   */
  value: Record<string, unknown>;
}

export interface RouterDeps {
  db: Db;
  registry: SessionRegistry;
  authorizer: Authorizer;
  channel: Channel;
  channelId: string;
  appId: string;
  clock?: Clock;
  note?: (line: string) => void;
}

/** Reasons we stay silent rather than explain ourselves. See `#shouldExplain`. */
const SILENT_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  'sender_not_allowed',
  'chat_not_allowed',
  'bot_sender',
  'no_mention',
]);

export class Router {
  readonly #deps: RouterDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  readonly #ingress = new Lanes();

  constructor(deps: RouterDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#note = deps.note ?? (() => undefined);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async onMessage(message: InboundMessage): Promise<void> {
    try {
      await this.#ingress.run(message.chatId, () => this.#route(message));
    } catch (err) {
      if (err instanceof LaneShed) {
        // Shedding must be visible. A refusal the user never sees is the same
        // silent loss the depth cap exists to prevent, moved one level up.
        this.#note(`shed message ${message.messageId}: ${err.message}`);
        await this.#reply(
          this.#targetFor(message),
          message,
          'too-busy',
          'Too many messages queued in this chat. Send that again in a moment.',
        );
        return;
      }
      this.#note(
        `routing ${message.messageId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async #route(message: InboundMessage): Promise<void> {
    const now = this.#clock.now();

    // Durable, before anything else. A redelivery loses the race here and is
    // dropped without a second reply.
    if (!claimMessage(this.#deps.db, message.messageId, message.chatId, now)) {
      this.#note(`duplicate delivery of ${message.messageId}`);
      return;
    }

    const key = this.#keyFor(message);
    const target = this.#targetFor(message);

    const admitted = this.#deps.authorizer.admits(message);
    if (!admitted.ok) {
      recordOutcome(this.#deps.db, message.messageId, 'rejected');
      this.#recordRejection(key, message, admitted.reason, admitted.detail);
      if (this.#shouldExplain(admitted.reason)) {
        await this.#reply(target, message, 'rejected', admitted.detail);
      }
      return;
    }

    const parsed = parseCommand(message.text);
    if (parsed !== undefined && 'unknown' in parsed) {
      await this.#reply(
        target,
        message,
        'unknown-command',
        `Unknown command \`/${forDisplay(parsed.unknown)}\`. Try \`/help\`.`,
      );
      return;
    }

    if (parsed !== undefined) {
      await this.#runCommand(parsed.spec, parsed.arg, message, key, target);
      return;
    }

    // Not a command: a prompt. Empty text with no attachments is nothing to send --
    // an empty prompt burns a turn and confuses the agent.
    if (message.text.trim() === '' && message.attachments.length === 0) {
      await this.#reply(target, message, 'empty', 'That message had nothing in it.');
      return;
    }

    await this.#submit(message, key, target);
  }

  async #submit(message: InboundMessage, key: BindingKey, target: SendTarget): Promise<void> {
    const { session, created } = this.#deps.registry.bindOrCreate(key, message.sender);
    if (created) this.#note(`created session ${session.id} for ${key.conversationId}/${key.threadId}`);

    const actor = await this.#deps.registry.actorFor(session.id, key);
    const paths = message.attachments
      .map((a) => a.localPath)
      .filter((p): p is string => typeof p === 'string' && p !== '');

    let queued: Promise<unknown>;
    try {
      queued = actor.submit({
        messageId: message.messageId,
        appId: message.appId,
        input: { text: message.text, paths },
      });
    } catch (err) {
      await this.#reportSubmitFailure(err, message, target);
      return;
    }

    // Deliberately not awaited. The chat-wide ingress lane is still held; holding
    // it for the length of a turn would stall every other thread in this chat
    // behind one long-running agent.
    queued.catch((err: unknown) => {
      void this.#reportSubmitFailure(err, message, target);
    });
  }

  async #reportSubmitFailure(
    err: unknown,
    message: InboundMessage,
    target: SendTarget,
  ): Promise<void> {
    if (err instanceof MailboxFull) {
      await this.#reply(
        target,
        message,
        'mailbox-full',
        'This session already has a queue of prompts waiting. Let it catch up, or /stop.',
      );
      return;
    }
    if (err instanceof SessionHeld) {
      await this.#reply(
        target,
        message,
        'held',
        'This session is held: a prompt was in flight when the gateway restarted and may or may not have been delivered. ' +
          'Check what changed, then `/new` to start fresh or `/attach` to take it back.',
      );
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    this.#note(`submit failed for ${message.messageId}: ${detail}`);
    await this.#reply(target, message, 'submit-failed', `Could not run that: ${forDisplay(detail)}`);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async #runCommand(
    spec: CommandSpec,
    arg: string,
    message: InboundMessage,
    key: BindingKey,
    target: SendTarget,
  ): Promise<void> {
    const tier = this.#deps.authorizer.admitsTier(message.sender, spec.tier);
    if (!tier.ok) {
      this.#recordRejection(key, message, tier.reason, `${spec.name}: ${tier.detail}`);
      await this.#reply(target, message, `tier-${spec.name}`, tier.detail);
      return;
    }

    const binding = resolveBinding(this.#deps.db, key);
    if (spec.needsSession && binding === undefined) {
      await this.#reply(
        target,
        message,
        `no-session-${spec.name}`,
        'Nothing is bound here yet. Send a message first.',
      );
      return;
    }

    // Mutating verbs refuse mid-turn rather than bypass. Bypassing means racing the
    // actor for the same session, and the loser's write is the one the user asked
    // for.
    if (spec.mutating && binding !== undefined) {
      const actor = this.#deps.registry.liveActor(binding.sessionId);
      if (actor !== undefined) {
        const allowed = canMutate(actor.status());
        if (!allowed.ok) {
          await this.#reply(target, message, `busy-${spec.name}`, allowed.reason);
          return;
        }
      }
    }

    const actorFor = async (sessionId: string): Promise<SessionActor> =>
      this.#deps.registry.actorFor(sessionId, key);

    switch (spec.name) {
      case 'help':
        await this.#reply(target, message, 'help', renderHelp());
        return;

      case 'status': {
        if (binding === undefined) {
          await this.#reply(target, message, 'status', 'No session here yet.');
          return;
        }
        const actor = await actorFor(binding.sessionId);
        const view = actor.status();
        await this.#reply(
          target,
          message,
          'status',
          `**${view.label}** — ${forDisplay(view.detail)}\n` +
            `session \`${binding.sessionId}\` · generation ${view.generation} · ` +
            `${view.openTurns} open turn(s) · ${view.pendingApprovals} pending approval(s)`,
        );
        return;
      }

      case 'sessions': {
        const rows = bindingsInConversation(
          this.#deps.db,
          this.#deps.channelId,
          this.#deps.appId,
          message.chatId,
        );
        if (rows.length === 0) {
          await this.#reply(target, message, 'sessions', 'No sessions bound in this chat.');
          return;
        }
        const lines = rows.map(
          (b) =>
            `\`${b.sessionId}\` — ${b.threadId === '' ? 'chat scope' : `thread \`${b.threadId}\``}` +
            `${b.sessionId === binding?.sessionId ? ' (here)' : ''}`,
        );
        await this.#reply(target, message, 'sessions', lines.join('\n'));
        return;
      }

      case 'new': {
        const session = await this.#deps.registry.rotate(key, message.sender);
        await this.#reply(
          target,
          message,
          'new',
          `Fresh session \`${session.id}\`. The previous one is archived, not deleted — ` +
            '`/sessions` lists it and `/attach` brings it back.',
        );
        return;
      }

      case 'attach': {
        if (arg === '') {
          await this.#reply(target, message, 'attach', 'Usage: `/attach <session-id>`');
          return;
        }
        const result = await this.#deps.registry.attach(key, arg);
        await this.#reply(
          target,
          message,
          `attach-${arg}`,
          result.ok
            ? `Attached \`${result.session.id}\`. History replays into this thread on the next message.`
            : result.reason,
        );
        return;
      }

      case 'stop': {
        if (binding === undefined) return;
        const actor = this.#deps.registry.liveActor(binding.sessionId);
        if (actor === undefined) {
          await this.#reply(target, message, 'stop', 'Nothing is running.');
          return;
        }
        await actor.cancel();
        await this.#reply(
          target,
          message,
          'stop',
          'Cancelling. Cancellation is a terminal, not a deletion — the log keeps everything up to here.',
        );
        return;
      }

      case 'cd': {
        // Declared in the registry but not wired in this build: every session shares
        // one configured directory, so there is no per-session path to repoint.
        // Saying so is the point -- a `/cd` that silently succeeded and changed
        // nothing is worse than one that is honestly unavailable.
        await this.#reply(
          target,
          message,
          'cd',
          'Not available in this build: all sessions run in the single configured workspace directory.',
        );
        return;
      }

      default:
        await this.#reply(
          target,
          message,
          `todo-${spec.name}`,
          `\`/${spec.name}\` is declared but not implemented.`,
        );
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Card actions
  // -------------------------------------------------------------------------

  /**
   * Handle a button click. Returns the toast text.
   *
   * Not deduplicated by message id, deliberately. `seen_messages` claims a
   * *delivery*; two clicks of the same button are two intents that legitimately
   * repeat. Idempotency comes from `resolveApproval`, which returns `already`
   * instead of overwriting the first answer.
   */
  async onCardAction(action: InboundCardAction): Promise<string> {
    const approvalId = stringField(action.value, 'approvalId');
    const optionId = stringField(action.value, 'optionId');
    const nonce = stringField(action.value, 'nonce');
    if (approvalId === undefined || optionId === undefined || nonce === undefined) {
      return 'That button is missing its payload.';
    }

    // Answering an approval authorizes an action, so it needs operator tier -- the
    // same tier the equivalent command would need. A card is a different input
    // surface, not a different permission model.
    const tier = this.#deps.authorizer.admitsTier(action.operator, 'operate');
    if (!tier.ok) return tier.detail;

    const approval = getApproval(this.#deps.db, approvalId);
    if (approval === undefined) return 'That request no longer exists.';

    const actor = await this.#deps.registry.actorForBoundSession(approval.sessionId);
    if (actor === undefined) {
      return 'That session is no longer bound to a chat. Start a new one with /new.';
    }

    const report = actor.resolveFromCard({
      approvalId,
      optionId,
      nonce,
      principal: action.operator,
      via: this.#deps.channelId,
    });
    return report.message;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #keyFor(message: InboundMessage): BindingKey {
    return {
      channel: this.#deps.channelId,
      appId: message.appId,
      conversationId: message.chatId,
      // Never `root_id`. A reply to any message in the chat carries a root_id, so
      // keying on it would fork a session per reply chain.
      threadId: message.threadId,
    };
  }

  #targetFor(message: InboundMessage): SendTarget {
    return { chatId: message.chatId, threadId: message.threadId };
  }

  /**
   * Whether a refusal is explained or met with silence.
   *
   * Silence for anything about *who* the sender is or *where* they are: replying
   * confirms the bot is present and listening to an audience that was not supposed
   * to have its attention. Explanations for refusals about *what* was asked --
   * those go to someone already allowed to talk, who needs to know why nothing
   * happened.
   */
  #shouldExplain(reason: RejectReason): boolean {
    return !SILENT_REASONS.has(reason);
  }

  /**
   * Record a refusal in the log when there is a log to record it in.
   *
   * Bounded to sessions that already exist: creating one so a rejection has
   * somewhere to live would let an unauthorized sender allocate sessions, which is
   * a denial-of-service with extra steps.
   */
  #recordRejection(
    key: BindingKey,
    message: InboundMessage,
    reason: RejectReason,
    detail: string,
  ): void {
    const binding = resolveBinding(this.#deps.db, key);
    if (binding === undefined) {
      // The sender's open_id, because without it this line cannot be acted on: the
      // first-run failure is an owner id that does not match, and the id needed to
      // fix it is the one being refused. It is the same field the event payload
      // below records, and metadata rather than content either way.
      this.#note(
        `rejected ${message.messageId} from ${message.sender.openId} ` +
          `in ${key.conversationId} (${reason}) with no bound session`,
      );
      return;
    }
    appendEvent(
      this.#deps.db,
      binding.sessionId,
      {
        type: 'policy_rejected',
        actor: 'policy',
        payload: {
          reason,
          detail,
          messageId: message.messageId,
          // open_id only. The message body is not recorded: a rejected message was
          // never accepted, and storing its contents would keep exactly the data we
          // just declined to act on.
          sender: message.sender.openId,
        },
      },
      this.#clock.now(),
    );
  }

  async #reply(
    target: SendTarget,
    message: InboundMessage,
    purpose: string,
    text: string,
  ): Promise<void> {
    try {
      await this.#deps.channel.sendText(
        target,
        truncate(text, 4000),
        replyUuid(this.#deps.appId, message.messageId, purpose),
      );
    } catch (err) {
      // A failed reply is not worth failing the message over: the interesting
      // outcome already happened, or already didn't.
      this.#note(`reply (${purpose}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}
