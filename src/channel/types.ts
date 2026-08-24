import type { PermissionOption } from '../types.js';

/**
 * The outbound port. Lark is the only implementation; the seam exists so the core
 * never imports a vendor SDK type, and so tests can drive a fake that records
 * call order.
 *
 * Everything here is at-least-once and idempotent-by-`uuid`. There is no
 * "exactly once" send, and pretending otherwise is how a crash-replay posts the
 * same answer twice.
 */

export interface SendTarget {
  chatId: string;
  /** Feishu thread id, or '' for chat scope. */
  threadId: string;
}

export interface SendResult {
  messageId: string;
  /** True when the platform returned an existing message for a repeated uuid. */
  deduped: boolean;
}

/**
 * A card being written to, as a session rather than a handle.
 *
 * This shape is dictated by what the platform actually offers. Feishu's streaming
 * card API is a *producer*: you hand it a callback and it owns the card's
 * lifecycle for the duration, handling throttling and the 30,000-character
 * element rollover itself. A create/update/close triple would either reimplement
 * that or fight it.
 *
 * The consequence, stated plainly because it constrains recovery: a card session
 * cannot outlive the process that opened it. After a restart the old card can no
 * longer be written to, so a new one is opened and the content re-rendered from
 * `cursor_seq`. The log is what makes that lossless.
 */
export interface CardSession {
  /** The IM message carrying the card. Persisted so a stale card can be identified. */
  readonly messageId: string;
  /** Locally observed open time, for the 14-day expiry check. */
  readonly createdAt: number;

  /**
   * Replace the card's content.
   *
   * Full replacement, not append. Renders are computed from the log and are
   * idempotent, so a retry after an ambiguous failure re-sends the same state
   * rather than appending it twice.
   */
  set(text: string): Promise<void>;

  /**
   * Final content, then freeze. Idempotent; must not throw on a second call.
   *
   * One-way, and the card is dead afterwards: a Feishu streaming card is one
   * stream, and closing it is what stops the typing indicator. A `set` after this
   * is **inert** -- it neither updates the card nor reports a failure, because
   * there is nothing left to fail against. A caller that keeps a finished session
   * and keeps writing to it therefore loses every later write silently, which is
   * why the writer opens a new card per turn rather than reusing this one.
   */
  finish(text: string): Promise<void>;
}

export interface ApprovalCardSpec {
  approvalId: string;
  /** Agent-authored. Rendered as `plain_text`; see escape.ts. */
  action: string;
  options: readonly PermissionOption[];
  /** Opaque pointer round-tripped through the client. Never an identity claim. */
  nonce: string;
}

export interface Channel {
  readonly id: string;

  /** Plain text message. Used for rejections, errors, and command output. */
  sendText(target: SendTarget, text: string, uuid: string): Promise<SendResult>;

  /** Open a streaming card. */
  openCard(target: SendTarget, initialText: string, uuid: string): Promise<CardSession>;

  /** Post an approval card with one button per offered option. */
  sendApprovalCard(target: SendTarget, spec: ApprovalCardSpec, uuid: string): Promise<SendResult>;
}

/**
 * A send that failed in a way the caller must branch on.
 *
 * The distinction that matters is not HTTP status. Feishu reports rate limiting
 * three different ways -- HTTP 429, HTTP 400 with code 99991400, and a business
 * error inside a 2xx body -- so anything branching on status alone will treat a
 * throttle as a permanent failure and drop the message.
 */
export class ChannelError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryable: boolean,
    /** Milliseconds to wait, when the platform told us. */
    readonly retryAfterMs?: number,
  ) {
    super(`${message} (code ${code})`);
    this.name = 'ChannelError';
  }
}

/** Codes that mean the card we were writing to no longer exists. */
export const CARD_GONE_CODES: ReadonlySet<number> = new Set([
  230011, // message withdrawn
  200750, // card entity expired or not found
]);

/**
 * Codes worth retrying.
 *
 * `230049` is the interesting one: it means a send with the same uuid is already
 * in flight. The correct response is to retry with the **same** uuid so the two
 * converge on one message -- minting a fresh uuid would turn one message into two.
 */
export const RETRYABLE_CODES: ReadonlySet<number> = new Set([230049, 230020, 99991400]);
