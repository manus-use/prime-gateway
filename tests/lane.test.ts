import { describe, expect, it } from 'vitest';
import { BoundedMap } from '../src/core/bounded-map.js';
import { INGRESS_MAX_WAIT_MS, LaneShed, Lanes } from '../src/core/lane.js';
import { ManualClock } from './helpers/db.js';

/**
 * The two invariants worth testing here are both about what happens when
 * something goes wrong, not when it works:
 *
 * - A lane must **give up ordering rather than drop a message**. Running out of
 *   order is a visible oddity; dropping is invisible loss.
 * - A lane holding queued work must **survive eviction**. It is the owner of
 *   in-flight state, not a cached value, so evicting one does not cost a cache
 *   miss -- it hands the next arrival a fresh lane that runs concurrently with
 *   work already in flight.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Lanes', () => {
  it('runs tasks on one key in arrival order', async () => {
    const lanes = new Lanes();
    const order: string[] = [];
    const first = deferred();

    const a = lanes.run('chat', async () => {
      await first.promise;
      order.push('a');
    });
    const b = lanes.run('chat', async () => {
      order.push('b');
    });

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
    expect(lanes.stats.overflowed).toBe(0);
  });

  it('keeps a second caller in the same microtask behind the first', async () => {
    // The new tail is installed before the first `await`, which is the only reason
    // two events delivered in one tick cannot interleave.
    const lanes = new Lanes();
    const order: number[] = [];
    await Promise.all([
      lanes.run('chat', async () => {
        await sleep(5);
        order.push(1);
      }),
      lanes.run('chat', async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });

  it('does not serialize distinct keys against each other', async () => {
    const lanes = new Lanes();
    const held = deferred();
    const other: string[] = [];

    const slow = lanes.run('chat_a', () => held.promise);
    await lanes.run('chat_b', async () => {
      other.push('ran');
    });

    // One slow chat must not stall every other chat.
    expect(other).toEqual(['ran']);
    held.resolve();
    await slow;
  });

  it('settles with the task outcome and keeps the lane usable', async () => {
    const lanes = new Lanes();
    await expect(lanes.run('chat', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    // A dead lane reproduces exactly the stuck-handler failure this class exists
    // to prevent.
    await expect(lanes.run('chat', () => Promise.resolve('fine'))).resolves.toBe('fine');
  });

  it('gives up ordering rather than waiting forever', async () => {
    const lanes = new Lanes({ maxWaitMs: 5 });
    const done: string[] = [];

    const slow = lanes.run('chat', async () => {
      await sleep(60);
      done.push('slow');
    });
    const later = lanes.run('chat', async () => {
      done.push('later');
    });

    await later;
    // The message ran, out of order, and the fact was counted. Without the cap the
    // bot silently misses every later message in the chat.
    expect(done).toEqual(['later']);
    expect(lanes.stats.overflowed).toBe(1);
    await slow;
    expect(done).toEqual(['later', 'slow']);
  });

  it('sheds with a distinct error once the lane is at its depth cap', async () => {
    const lanes = new Lanes({ maxDepth: 2 });
    const held = deferred();
    const queued = [
      lanes.run('chat', () => held.promise),
      lanes.run('chat', () => Promise.resolve()),
    ];

    const shed = lanes.run('chat', () => Promise.resolve());
    await expect(shed).rejects.toBeInstanceOf(LaneShed);
    await shed.catch((err: unknown) => {
      // The caller has to tell the user. Shedding that is caught and logged is the
      // same silent loss the cap exists to prevent, one level up.
      expect(err).toMatchObject({ key: 'chat', depth: 2, name: 'LaneShed' });
    });
    expect(lanes.stats.shed).toBe(1);

    held.resolve();
    await Promise.all(queued);
  });

  it('accepts work again after the queue drains', async () => {
    const lanes = new Lanes({ maxDepth: 1 });
    const held = deferred();
    const first = lanes.run('chat', () => held.promise);
    await expect(lanes.run('chat', () => Promise.resolve())).rejects.toBeInstanceOf(LaneShed);
    held.resolve();
    await first;
    await expect(lanes.run('chat', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('keeps a lane with work in flight through a sweep', async () => {
    const clock = new ManualClock();
    const lanes = new Lanes({ ttlMs: 10 }, clock);
    const held = deferred();
    const running = lanes.run('chat', () => held.promise);

    clock.advance(1000);
    expect(lanes.sweep()).toBe(0);
    expect(lanes.size).toBe(1);

    held.resolve();
    await running;
    // Idle now, so it is an ordinary cache entry again.
    expect(lanes.sweep()).toBe(1);
    expect(lanes.size).toBe(0);
  });

  it('defaults the ingress wait to the documented cap', () => {
    expect(INGRESS_MAX_WAIT_MS).toBe(5000);
  });
});

describe('BoundedMap', () => {
  it('refuses a configuration that cannot bound anything', () => {
    expect(() => new BoundedMap({ ttlMs: 10, maxEntries: 0 })).toThrow('maxEntries');
    expect(() => new BoundedMap({ ttlMs: 0, maxEntries: 10 })).toThrow('ttlMs');
  });

  it('expires an entry on read and forgets it', () => {
    const clock = new ManualClock();
    const map = new BoundedMap<string, number>({ ttlMs: 10, maxEntries: 10 }, clock);
    map.set('k', 1);
    clock.advance(10);
    expect(map.get('k')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('drops the oldest key at the cap, counting a re-set as fresh', () => {
    const map = new BoundedMap<string, number>({ ttlMs: 1000, maxEntries: 2 });
    map.set('a', 1);
    map.set('b', 2);
    map.set('a', 3);
    map.set('c', 4);
    // 'a' was refreshed, so 'b' is the oldest and the one that goes.
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(true);
  });

  it('exceeds the cap rather than evicting pinned state', () => {
    const map = new BoundedMap<string, { busy: boolean }>(
      { ttlMs: 1000, maxEntries: 1, isPinned: (v) => v.busy },
      new ManualClock(),
    );
    map.set('a', { busy: true });
    map.set('b', { busy: true });
    // An over-cap map is a monitoring problem; an evicted live lane is a
    // correctness one.
    expect(map.size).toBe(2);
  });

  it('keeps pinned entries through TTL and reports what it dropped', () => {
    const clock = new ManualClock();
    const map = new BoundedMap<string, { busy: boolean }>(
      { ttlMs: 10, maxEntries: 10, isPinned: (v) => v.busy },
      clock,
    );
    map.set('idle', { busy: false });
    map.set('busy', { busy: true });
    clock.advance(11);

    expect(map.sweep()).toBe(1);
    expect(map.has('busy')).toBe(true);
    expect(map.get('idle')).toBeUndefined();
  });

  it('deletes and clears without waiting for a clock', () => {
    const map = new BoundedMap<string, number>({ ttlMs: 1000, maxEntries: 10 });
    map.set('a', 1);
    expect(map.delete('a')).toBe(true);
    expect(map.delete('a')).toBe(false);
    map.set('b', 2);
    map.clear();
    expect(map.size).toBe(0);
  });
});
