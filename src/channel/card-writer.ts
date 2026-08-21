import type { Event } from '../types.js';
import type { CardSession, Channel, SendTarget } from './types.js';
import { CARD_GONE_CODES, ChannelError } from './types.js';
import { renderCard } from './render.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

/**
 * The single writer for one binding's card.
 *
 * Three properties, none optional:
 *
 * 1. **Single-flight.** One request in flight per card, ever. The platform's write
 *    ordering does not decide which render is *current*, and delivery order is
 *    unpredictable -- so without this a stale render lands after a fresh one and
 *    overwrites the result of a user's click.
 * 2. **Latest-wins, and the queued item is an integer.** What is queued is a
 *    target `seq`, not a rendered payload. "Newest wins" then reduces to an
 *    integer comparison and cannot regress. Queueing payloads instead means
 *    comparing blobs, and getting that wrong shows up as flickering text.
 * 3. **The pending target survives failure.** On error the target is retained, so
 *    the retry renders the newest state rather than replaying the state that
 *    failed.
 *
 * Intermediate renders are droppable by construction, which is what makes
 * coalescing safe rather than lossy.
 */

/** Coalescing interval. Roughly one card write per second per session. */
export const CARD_COALESCE_MS = 1000;

/**
 * Card entities expire after 14 days. We rotate before the edge rather than at
 * it, because the failure at the edge is an update that silently stops landing.
 */
export const CARD_MAX_AGE_MS = 13 * 24 * 60 * 60 * 1000;

export interface CardWriterDeps {
  channel: Channel;
  target: SendTarget;
  /** Read events `(afterSeq, throughSeq]`. Supplied by the core; the writer never touches the DB. */
  readEvents: (afterSeq: number, throughSeq: number) => readonly Event[];
  /** Persist the cursor once a render lands. Monotonic on the DB side too. */
  onRendered: (throughSeq: number) => void;
  /** Persist the active message id, or clear it. */
  onCardChanged: (messageId: string | null) => void;
  /** Derive the idempotency uuid for opening a card. */
  sendUuid: (eventSeq: number) => string;
  clock?: Clock;
}

export class CardWriter {
  readonly #deps: CardWriterDeps;
  readonly #clock: Clock;
  #session: CardSession | undefined;
  /** Highest seq we have been asked to render. The queue, as an integer. */
  #wanted = 0;
  /** Highest seq actually rendered. */
  #rendered = 0;
  #inFlight = false;
  #timer: NodeJS.Timeout | undefined;
  #lastWriteAt = 0;
  #closed = false;
  #finished = false;

  constructor(deps: CardWriterDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Resume after a restart.
   *
   * Only the cursor is adopted, never a card session -- the previous session died
   * with the process that owned it. The next render therefore opens a fresh card
   * and re-renders from the log. Nothing is lost, because the log is the system of
   * record and the render is a pure function of it.
   */
  resumeFrom(renderedThrough: number): void {
    this.#rendered = renderedThrough;
    this.#wanted = renderedThrough;
  }

  /**
   * Request that the card show state through `seq`.
   *
   * Returns immediately. Coalescing and retry are internal, because a caller that
   * has to await a card write has coupled the agent's progress to Feishu's
   * latency.
   */
  want(seq: number): void {
    if (this.#closed) return;
    if (seq <= this.#wanted) return;
    this.#wanted = seq;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#inFlight || this.#timer !== undefined || this.#closed) return;
    const elapsed = this.#clock.now() - this.#lastWriteAt;
    const delay = Math.max(0, CARD_COALESCE_MS - elapsed);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain();
    }, delay);
    this.#timer.unref();
  }

  async #drain(): Promise<void> {
    if (this.#inFlight) return;
    if (this.#wanted <= this.#rendered) return;

    this.#inFlight = true;
    // Snapshotted before the await. `#wanted` may advance while we are writing;
    // that advance schedules the next pass, and must not silently change what
    // this pass claims to have rendered.
    const target = this.#wanted;

    try {
      await this.#write(target);
      this.#rendered = target;
      this.#lastWriteAt = this.#clock.now();
      this.#deps.onRendered(target);
    } catch (err) {
      if (err instanceof ChannelError && CARD_GONE_CODES.has(err.code)) {
        // The card is gone. Drop the session and let the next pass open a fresh
        // one, continuing from the cursor -- the log still has everything.
        this.#session = undefined;
        this.#deps.onCardChanged(null);
      }
      // `#rendered` is deliberately not advanced, so `#wanted > #rendered` still
      // holds and the retry renders the newest state rather than this stale one.
    } finally {
      this.#inFlight = false;
      if (this.#wanted > this.#rendered && !this.#closed) this.#schedule();
    }
  }

  async #write(target: number): Promise<void> {
    // Always rendered from seq 0: a render is a full replacement of the card, not
    // an append to it.
    const events = this.#deps.readEvents(0, target);
    const view = renderCard(events);

    const existing = this.#session;
    const expired =
      existing !== undefined && this.#clock.now() - existing.createdAt > CARD_MAX_AGE_MS;

    let session = existing;
    if (session === undefined || expired) {
      session = await this.#deps.channel.openCard(
        this.#deps.target,
        view.text,
        this.#deps.sendUuid(target),
      );
      this.#session = session;
      this.#deps.onCardChanged(session.messageId);
      // The initial text was already delivered by `openCard`, so a `set` here
      // would be a redundant round-trip -- but a finished view still has to be
      // frozen.
      if (view.finished) {
        await session.finish(view.text);
        this.#finished = true;
      }
      return;
    }

    if (view.finished) {
      await session.finish(view.text);
      this.#finished = true;
    } else {
      await session.set(view.text);
    }
  }

  /**
   * Flush anything outstanding and stop.
   *
   * Awaits the final write, unlike `want`. This is the one place where blocking is
   * correct: teardown that returns before the last card write lands leaves the
   * user looking at a partial answer with no indication more was coming.
   */
  async close(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    // Drained before the closed flag is set, so a `want` that arrived during
    // shutdown is not silently dropped.
    await this.#drain();
    this.#closed = true;

    // A card left un-frozen keeps its typing indicator forever. If the render
    // never reported a terminal, freeze it anyway on the way out.
    const session = this.#session;
    if (session !== undefined && !this.#finished) {
      const view = renderCard(this.#deps.readEvents(0, this.#rendered));
      try {
        await session.finish(view.text);
        this.#finished = true;
      } catch {
        // Teardown is best-effort. A card that stays open is a cosmetic defect;
        // throwing here would abort the rest of the shutdown.
      }
    }
  }

  /** For tests: force an immediate pass without waiting out the coalesce window. */
  async flushNow(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#drain();
  }

  get messageId(): string | undefined {
    return this.#session?.messageId;
  }

  get renderedThrough(): number {
    return this.#rendered;
  }
}
