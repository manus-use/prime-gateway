import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { migrate, openDb, type Db } from '../../src/db/open.js';
import type { Clock } from '../../src/time.js';

/**
 * A real SQLite file per test, not `:memory:`.
 *
 * WAL is a no-op on an in-memory database, and WAL is load-bearing here: the
 * `BEGIN IMMEDIATE` retry path and the checkpointing both only exist because of
 * it. Testing against a mode production never runs in would exercise different
 * code.
 */
export const SCHEMA_DIR = fileURLToPath(new URL('../../schema', import.meta.url));

export interface TestDb {
  db: Db;
  dir: string;
  close(): void;
}

export function testDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'prime-gw-test-'));
  const db = openDb(join(dir, 'gateway.db'));
  migrate(db, SCHEMA_DIR);
  return {
    db,
    dir,
    close(): void {
      try {
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * A clock the test moves by hand.
 *
 * `delay` resolves on the next microtask *and* advances the clock, so code under
 * test that waits then reads `now()` observes time having passed -- without the
 * test taking that long.
 */
export class ManualClock implements Clock {
  #t: number;

  constructor(start = 1_760_000_000_000) {
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  async delay(ms: number): Promise<void> {
    this.#t += ms;
    await Promise.resolve();
  }

  advance(ms: number): void {
    this.#t += ms;
  }
}

/** Let queued microtasks and immediates run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
