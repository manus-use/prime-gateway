import { createLarkChannel, type LarkChannel, type MarkdownStreamController } from '@larksuiteoapi/node-sdk';
import type {
  ApprovalCardSpec,
  CardSession,
  Channel,
  SendResult,
  SendTarget,
} from '../types.js';
import { forPlainText, truncate } from '../escape.js';
import { backoffMs, toChannelError } from './errors.js';
import type { Clock } from '../../time.js';
import { systemClock } from '../../time.js';

/**
 * The Lark implementation of the outbound `Channel` port.
 *
 * Built on the SDK's high-level `Channel` module rather than raw API calls. That
 * is a deliberate bet: the module already owns per-chat queueing, the streaming
 * card lifecycle, and the 30,000-character element rollover, and reimplementing
 * those on top of `im.v1.*` means owning three pieces of fiddly behaviour whose
 * failure modes are all silent. The cost of the bet is that the card lifecycle is
 * shaped by its producer callback, which is why `CardSession` exists.
 *
 * **Known gap.** The port's `uuid` parameter is accepted and not forwarded: the
 * SDK's high-level `send`/`stream` do not expose Feishu's `uuid` field, so
 * platform-side send dedup is unavailable here. Sends are therefore at-least-once
 * *without* the one-hour dedup window the design assumes, and a retry after an
 * ambiguous failure can post a second copy. The parameter stays in the port
 * rather than being deleted, because deleting it would erase the requirement
 * along with the gap -- and closing it is a one-line change once the SDK exposes
 * the field.
 */

export interface LarkChannelConfig {
  appId: string;
  appSecret: string;
  /**
   * Directories from which local files may be attached.
   *
   * Passed to the SDK's own path guard. Left unset, the SDK enforces only a
   * blocklist, which does not stop an agent from attaching an arbitrary readable
   * file outside its workspace.
   */
  allowedFileDirs?: readonly string[];
  domain?: string;
}

const MAX_SEND_ATTEMPTS = 4;
/** Feishu's text message ceiling, with headroom. */
const TEXT_BUDGET = 12_000;

export class LarkAdapter implements Channel {
  readonly id = 'lark';
  readonly #lark: LarkChannel;
  readonly #clock: Clock;
  #botOpenId: string | undefined;

  constructor(config: LarkChannelConfig, clock: Clock = systemClock) {
    this.#clock = clock;
    this.#lark = createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      transport: 'websocket',
      ...(config.domain === undefined ? {} : { domain: config.domain }),
      // The gateway does its own policy in `policy/auth.ts`, deliberately. Two
      // places deciding who may talk to the bot is two places to keep in sync,
      // and the SDK's policy cannot see our tiers.
      policy: { requireMention: false, dmMode: 'open', respondToMentionAll: true },
      outbound: {
        ssrfGuard: true,
        ...(config.allowedFileDirs === undefined
          ? {}
          : { allowedFileDirs: [...config.allowedFileDirs] }),
      },
      // Needed because the normalizer drops fields the gateway relies on --
      // notably the sender's union_id, which is the canonical human key.
      includeRawEvent: true,
      source: 'prime-gateway',
    });
  }

  /** The underlying channel, for the inbound side to attach listeners to. */
  get raw(): LarkChannel {
    return this.#lark;
  }

  async connect(): Promise<void> {
    await this.#lark.connect();
    this.#botOpenId = this.#lark.botIdentity?.openId;
  }

  async disconnect(): Promise<void> {
    await this.#lark.disconnect();
  }

  /**
   * The bot's own `open_id`.
   *
   * Needed by the inbound loop guard. Undefined before `connect()`, and the
   * caller must treat that as "cannot tell" rather than "not us" -- defaulting
   * the other way would let the bot process its own messages.
   */
  get botOpenId(): string | undefined {
    return this.#botOpenId;
  }

  async sendText(target: SendTarget, text: string, _uuid: string): Promise<SendResult> {
    return this.#withRetry(async () => {
      const result = await this.#lark.send(
        target.chatId,
        { markdown: truncate(text, TEXT_BUDGET) },
        this.#sendOptions(target),
      );
      return { messageId: result.messageId, deduped: false };
    });
  }

  /**
   * Open a streaming card.
   *
   * `stream()` does not return until its producer resolves, so it cannot be
   * awaited here -- the card has to stay writable for the length of a turn. What
   * this does instead is start `stream()`, wait for the producer to hand over its
   * controller, and return a session that drives it.
   *
   * The producer is held open by a promise that `finish()` resolves. That is the
   * whole trick, and it has one hard requirement: **`finish()` must be reached on
   * every path**, including failure, or `stream()` never settles and the card
   * shows a typing indicator forever.
   */
  async openCard(target: SendTarget, initialText: string, _uuid: string): Promise<CardSession> {
    const clock = this.#clock;

    let onController: (c: MarkdownStreamController) => void;
    let onFailed: (e: unknown) => void;
    const ready = new Promise<MarkdownStreamController>((resolve, reject) => {
      onController = resolve;
      onFailed = reject;
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const streaming = this.#lark
      .stream(
        target.chatId,
        {
          markdown: async (controller) => {
            await controller.setContent(initialText);
            onController(controller);
            await held;
          },
        },
        this.#sendOptions(target),
      )
      .catch((err: unknown) => {
        // Surfaced to whichever side is waiting. Before handover this rejects
        // `openCard`; after it, the failure is reported through `set`/`finish`.
        onFailed(err);
        // Unblock the producer so a failed stream cannot leave `finish()` hanging.
        release();
        throw toChannelError(err);
      });
    // The rejection is consumed by whoever awaits `streaming`; this keeps it from
    // surfacing as an unhandled rejection in the meantime.
    void streaming.catch(() => undefined);

    let controller: MarkdownStreamController;
    try {
      controller = await ready;
    } catch (err) {
      throw toChannelError(err);
    }

    const createdAt = clock.now();
    let finished = false;

    return {
      messageId: controller.messageId,
      createdAt,
      async set(text: string): Promise<void> {
        if (finished) return;
        try {
          await controller.setContent(text);
        } catch (err) {
          throw toChannelError(err);
        }
      },
      async finish(text: string): Promise<void> {
        // Idempotent: teardown reaches this from the writer's normal terminal
        // path and again from its shutdown path, and a second call must be inert
        // rather than an error.
        if (finished) return;
        finished = true;
        try {
          await controller.setContent(text);
        } catch {
          // The content update failed, but the producer still has to be released.
          // Leaving it held would hang `stream()` and, with it, the card.
        }
        release();
        await streaming.catch(() => undefined);
      },
    };
  }

  /**
   * Post an approval card.
   *
   * Two deliberate choices in the card body:
   *
   * - Agent-supplied text is a `plain_text` element. There is then no markup
   *   syntax to inject into, so *displaying* a request cannot itself become an
   *   @-mention-everyone notification. The escaping in `escape.ts` defends the
   *   markdown path; this removes the need for a defence at all.
   * - Buttons are generated from the agent's own option set. Hardcoding
   *   allow/deny would invent outcomes the agent never offered and silently drop
   *   ones it did.
   */
  async sendApprovalCard(
    target: SendTarget,
    spec: ApprovalCardSpec,
    _uuid: string,
  ): Promise<SendResult> {
    const card = {
      schema: '2.0',
      config: { update_multi: true },
      body: {
        elements: [
          {
            tag: 'div',
            text: { tag: 'plain_text', content: forPlainText(spec.action) },
          },
          {
            tag: 'action',
            actions: spec.options.map((option) => ({
              tag: 'button',
              text: { tag: 'plain_text', content: forPlainText(option.name) },
              type: buttonType(option.kind),
              // `action.value` round-trips through the client and Lark does not
              // verify it. It is a pointer, never a claim: identity comes from
              // `operator.openId` on the callback, and the nonce is re-checked
              // against the log by a generation CAS before anything happens.
              value: { approvalId: spec.approvalId, optionId: option.optionId, nonce: spec.nonce },
            })),
          },
        ],
      },
    };

    return this.#withRetry(async () => {
      const result = await this.#lark.send(target.chatId, { card }, this.#sendOptions(target));
      return { messageId: result.messageId, deduped: false };
    });
  }

  #sendOptions(target: SendTarget): { replyTo?: string; replyInThread?: boolean } {
    // Threading requires a message to reply to. When the target carries no anchor
    // the message goes to chat scope, which is the honest fallback: silently
    // dropping the thread association is better than replying under an unrelated
    // message.
    if (target.threadId === '') return {};
    return { replyTo: target.threadId, replyInThread: true };
  }

  /**
   * Retry a send.
   *
   * Retries are only ever attempted for errors classified retryable. Retrying a
   * permanent failure burns the per-chat rate limit that the next real message
   * needs, and produces the same error four times instead of once.
   *
   * See the class note on `uuid`: without it these retries are not deduplicated
   * platform-side.
   */
  async #withRetry(attempt: () => Promise<SendResult>): Promise<SendResult> {
    let lastError: unknown;
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      try {
        return await attempt();
      } catch (raw) {
        const err = toChannelError(raw);
        lastError = err;
        if (!err.retryable || i === MAX_SEND_ATTEMPTS - 1) throw err;
        // The platform's own reset hint beats a guess -- a fixed backoff either
        // gives up too early or waits far longer than the window actually is.
        const wait = err.retryAfterMs ?? backoffMs(i);
        await sleep(wait);
      }
    }
    throw toChannelError(lastError);
  }
}

function buttonType(kind: string | undefined): string {
  switch (kind) {
    case 'allow_once':
    case 'allow_always':
      return 'primary';
    case 'reject_once':
    case 'reject_always':
      return 'danger';
    default:
      return 'default';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
