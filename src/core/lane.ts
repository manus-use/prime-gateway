import { BoundedMap } from './bounded-map.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

/**
 * Serial execution lanes, keyed by an arbitrary string, with a wait cap.
 *
 * Used twice, at two stages, for two reasons:
 *
 * 1. **Chat-wide ingress.** Held across async routing so two messages arriving in
 *    one chat are ingested in arrival order. It has to be chat-wide rather than
 *    per-thread: a topic's seed message carries no `thread_id` yet, so a
 *    per-thread lane cannot prove arrival order for the very message that creates
 *    the thread. You cannot key a lane on a session you have not yet identified.
 * 2. **Per-session FIFO**, once the binding has resolved and there *is* a session
 *    to key on.
 *
 * The wait cap is the load-bearing safety property. Without it, one handler stuck
 * on a slow network call makes the bot silently miss every later message in that
 * chat -- the lane grows, nothing throws, and the user sees a bot that stopped
 * answering. At the cap we deliberately **give up ordering and keep the
 * message**: running out of order is a visible oddity, dropping is invisible loss.
 */

export const INGRESS_MAX_WAIT_MS = 5000;

export interface LaneStats {
  /** Tasks that ran concurrently because they waited past the cap. */
  overflowed: number;
  /** Tasks shed because their lane was already at its depth cap. */
  shed: number;
}

export interface LaneOptions {
  maxWaitMs?: number;
  /** Depth cap per lane. Beyond this, `run` rejects instead of queueing. */
  maxDepth?: number;
  /** Idle-lane TTL. Only ever applied to lanes with no work in flight. */
  ttlMs?: number;
  maxLanes?: number;
}

/**
 * Thrown when a lane is over its depth cap.
 *
 * A distinct error type because the caller must *tell the user* -- shedding that
 * is caught and logged is the same silent loss the cap exists to prevent, just
 * moved one level up.
 */
export class LaneShed extends Error {
  constructor(
    readonly key: string,
    readonly depth: number,
  ) {
    super(`lane ${key} is at its depth cap (${depth}); shedding`);
    this.name = 'LaneShed';
  }
}

interface Lane {
  /** Resolves once everything queued so far has settled. */
  tail: Promise<void>;
  depth: number;
}

export class Lanes {
  readonly stats: LaneStats = { overflowed: 0, shed: 0 };
  readonly #lanes: BoundedMap<string, Lane>;
  readonly #maxWaitMs: number;
  readonly #maxDepth: number;

  constructor(opts: LaneOptions = {}, clock: Clock = systemClock) {
    this.#maxWaitMs = opts.maxWaitMs ?? INGRESS_MAX_WAIT_MS;
    this.#maxDepth = opts.maxDepth ?? 64;
    this.#lanes = new BoundedMap<string, Lane>(
      {
        ttlMs: opts.ttlMs ?? 10 * 60 * 1000,
        maxEntries: opts.maxLanes ?? 2000,
        // A lane with queued work owns ordering state, not a cached value.
        // Evicting one does not cost a cache miss -- it hands the next arrival a
        // fresh lane that will run concurrently with work already in flight.
        isPinned: (lane) => lane.depth > 0,
      },
      clock,
    );
  }

  /**
   * Run `fn` after everything already queued on `key`.
   *
   * Settles with `fn`'s own outcome. A rejecting `fn` does not poison the lane:
   * the next task still runs, because a dead lane would reproduce exactly the
   * stuck-handler failure this class exists to prevent.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let lane = this.#lanes.get(key);
    if (lane === undefined) {
      lane = { tail: Promise.resolve(), depth: 0 };
    }

    if (lane.depth >= this.#maxDepth) {
      this.stats.shed++;
      throw new LaneShed(key, lane.depth);
    }

    lane.depth++;
    // Re-set on every call so an active lane keeps refreshing its TTL position.
    this.#lanes.set(key, lane);

    const predecessor = lane.tail;
    let release!: () => void;
    // The new tail is installed before the first `await`, so a second caller
    // arriving in the same microtask still queues behind this one.
    lane.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const inOrder = await this.#waitBounded(predecessor);
      if (!inOrder) this.stats.overflowed++;
      return await fn();
    } finally {
      lane.depth--;
      release();
    }
  }

  /**
   * Wait for `p`, but not forever. Resolves false if we gave up waiting.
   *
   * The timer is cleared on both paths. A busy chat would otherwise hold one live
   * timer per queued message for the full cap duration.
   */
  async #waitBounded(p: Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const capped = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#maxWaitMs);
      timer.unref();
    });
    try {
      return await Promise.race([p.then(() => true as const), capped]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Drop idle lanes. Lanes with work in flight are pinned and survive. */
  sweep(): number {
    return this.#lanes.sweep();
  }

  get size(): number {
    return this.#lanes.size;
  }
}
