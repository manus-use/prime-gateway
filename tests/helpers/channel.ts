import type {
  ApprovalCardSpec,
  CardSession,
  Channel,
  SendResult,
  SendTarget,
} from '../../src/channel/types.js';
import type { Clock } from '../../src/time.js';
import { systemClock } from '../../src/time.js';

/**
 * A recording `Channel`.
 *
 * Two capabilities the real adapter cannot give a test:
 *
 * 1. **Call order**, as a flat list. Most of the outbound invariants in this
 *    codebase are ordering claims -- open before set, card frozen before the
 *    runtime is torn down, approval row written before the card -- and an
 *    assertion on a flat log states them directly.
 * 2. **Controllable completion.** `hold()` parks every call mid-flight, which is
 *    the only way to observe single-flight and latest-wins behaviour: both are
 *    defined entirely by what happens *while* a write is outstanding.
 */

type Method = 'sendText' | 'openCard' | 'sendApprovalCard' | 'set' | 'finish';

export interface TextCall {
  target: SendTarget;
  text: string;
  uuid: string;
}

export interface ApprovalCall {
  target: SendTarget;
  spec: ApprovalCardSpec;
  uuid: string;
}

export class FakeCard implements CardSession {
  readonly messageId: string;
  readonly createdAt: number;
  readonly sets: string[] = [];
  readonly finishes: string[] = [];

  readonly #owner: FakeChannel;

  constructor(owner: FakeChannel, messageId: string, createdAt: number) {
    this.#owner = owner;
    this.messageId = messageId;
    this.createdAt = createdAt;
  }

  async set(text: string): Promise<void> {
    this.#owner.calls.push('set');
    await this.#owner.gate('set');
    this.sets.push(text);
  }

  async finish(text: string): Promise<void> {
    this.#owner.calls.push('finish');
    await this.#owner.gate('finish');
    this.finishes.push(text);
  }

  /** Last content the card was told to display, whether by set or finish. */
  get text(): string | undefined {
    return this.finishes.at(-1) ?? this.sets.at(-1);
  }
}

export class FakeChannel implements Channel {
  readonly id: string;
  readonly calls: Method[] = [];
  readonly texts: TextCall[] = [];
  readonly approvalCards: ApprovalCall[] = [];
  readonly cards: FakeCard[] = [];

  readonly #clock: Clock;
  readonly #failures = new Map<Method, unknown[]>();
  #held: Promise<void> | undefined;
  #release: (() => void) | undefined;
  #seq = 0;

  constructor(opts: { id?: string; clock?: Clock } = {}) {
    this.id = opts.id ?? 'fake';
    this.#clock = opts.clock ?? systemClock;
  }

  // -- test controls ---------------------------------------------------------

  /** Park every subsequent call until `release()`. */
  hold(): void {
    if (this.#held !== undefined) return;
    this.#held = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    const release = this.#release;
    this.#held = undefined;
    this.#release = undefined;
    release?.();
  }

  /** Make the next call to `method` reject with `err`. Queued, so N in a row work. */
  failNext(method: Method, err: unknown): void {
    const queue = this.#failures.get(method) ?? [];
    queue.push(err);
    this.#failures.set(method, queue);
  }

  /** Awaited by every call site, after it has been recorded and before it succeeds. */
  async gate(method: Method): Promise<void> {
    const held = this.#held;
    if (held !== undefined) await held;
    const queue = this.#failures.get(method);
    const err = queue?.shift();
    if (err !== undefined) throw err;
  }

  get lastCard(): FakeCard | undefined {
    return this.cards.at(-1);
  }

  // -- Channel ---------------------------------------------------------------

  async sendText(target: SendTarget, text: string, uuid: string): Promise<SendResult> {
    this.calls.push('sendText');
    await this.gate('sendText');
    this.texts.push({ target, text, uuid });
    return { messageId: `om_text_${++this.#seq}`, deduped: false };
  }

  async openCard(target: SendTarget, initialText: string, uuid: string): Promise<CardSession> {
    this.calls.push('openCard');
    await this.gate('openCard');
    const card = new FakeCard(this, `om_card_${++this.#seq}`, this.#clock.now());
    // The real adapter delivers the initial text as part of opening, so record it
    // the same way -- a test asserting on card content must not have to know
    // whether the first render arrived via open or via set.
    card.sets.push(initialText);
    this.cards.push(card);
    void target;
    void uuid;
    return card;
  }

  async sendApprovalCard(
    target: SendTarget,
    spec: ApprovalCardSpec,
    uuid: string,
  ): Promise<SendResult> {
    this.calls.push('sendApprovalCard');
    await this.gate('sendApprovalCard');
    this.approvalCards.push({ target, spec, uuid });
    return { messageId: `om_approval_${++this.#seq}`, deduped: false };
  }
}
