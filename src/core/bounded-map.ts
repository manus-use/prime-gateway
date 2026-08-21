import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

/**
 * A map bounded twice: TTL governs freshness, the cap governs count.
 *
 * One bound is not enough. TTL alone lets a burst of distinct keys grow the map
 * without limit until they age out; a cap alone keeps stale entries alive
 * forever in a quiet map. Unbounded, ~200k keys in a bare Map costs tens of MB
 * that is never reclaimed.
 *
 * Eviction is insertion-ordered (Map preserves it), so the cap drops the oldest
 * key. This is a cache, never a system of record -- anything that must survive
 * goes in SQLite.
 *
 * `isPinned` exempts an entry from both TTL and cap eviction. It exists because
 * some values are caches of a *decision* but owners of *in-flight state* -- an
 * execution lane with queued work, for instance. Evicting one of those does not
 * cost a cache miss, it silently breaks the invariant the value was holding. If a
 * value can be recomputed, leave `isPinned` unset.
 */
export class BoundedMap<K, V> {
  #entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly opts: {
      ttlMs: number;
      maxEntries: number;
      isPinned?: (value: V) => boolean;
    },
    private readonly clock: Clock = systemClock,
  ) {
    if (opts.maxEntries < 1) throw new Error('maxEntries must be >= 1');
    if (opts.ttlMs < 1) throw new Error('ttlMs must be >= 1');
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const hit = this.#entries.get(key);
    if (hit === undefined) return undefined;
    if (hit.expiresAt <= this.clock.now() && !this.#pinned(hit.value)) {
      this.#entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    // Re-insert so refreshed keys move to the back of the eviction order.
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.clock.now() + this.opts.ttlMs });
    this.#evict();
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Drop expired, unpinned entries. Cheap enough to call opportunistically. */
  sweep(): number {
    const now = this.clock.now();
    let dropped = 0;
    for (const [k, v] of this.#entries) {
      if (v.expiresAt <= now && !this.#pinned(v.value)) {
        this.#entries.delete(k);
        dropped++;
      }
    }
    return dropped;
  }

  #pinned(value: V): boolean {
    return this.opts.isPinned?.(value) === true;
  }

  /**
   * Enforce the cap: expired first, then oldest-first among the unpinned.
   *
   * If every entry is pinned the map is allowed to exceed `maxEntries` rather
   * than break an invariant to satisfy a memory bound. That is the right trade
   * -- an over-cap map is a monitoring problem, an evicted live lane is a
   * correctness one -- but it means a caller whose pins never clear has an
   * unbounded map, so `isPinned` must describe transient state only.
   */
  #evict(): void {
    if (this.#entries.size <= this.opts.maxEntries) return;
    this.sweep();
    for (const [k, v] of this.#entries) {
      if (this.#entries.size <= this.opts.maxEntries) return;
      if (!this.#pinned(v.value)) this.#entries.delete(k);
    }
  }
}
