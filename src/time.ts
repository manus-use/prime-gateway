/**
 * Centralized time. Every delay in the codebase goes through here so tests can
 * scale them; production with TIME_SCALE unset is byte-identical.
 *
 * Leases and timeouts are ALWAYS measured on locally observed time, never on a
 * timestamp reported by the agent -- an agent's clock can be wrong, skewed, or
 * simply stale by the time we read it.
 */

const scale = (() => {
  const raw = process.env['TIME_SCALE'];
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`TIME_SCALE must be a positive finite number, got ${JSON.stringify(raw)}`);
  }
  return n;
})();

export const timeScale = scale;

export interface Clock {
  now(): number;
  delay(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  delay: (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(0, Math.round(ms * scale)));
      // Never hold the event loop open for a pending delay.
      if (typeof t.unref === 'function') t.unref();
    }),
};

/**
 * Wait for `p`, but never longer than `ms`. Rejects with a message that names
 * the unmet condition -- a bare "timeout" tells whoever reads the log nothing.
 */
export async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  condition: string,
  clock: Clock = systemClock,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DeadlineExceeded(condition, ms)),
      Math.max(0, Math.round(ms * scale)),
    );
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  void clock;
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DeadlineExceeded extends Error {
  constructor(
    readonly condition: string,
    readonly ms: number,
  ) {
    super(`deadline exceeded after ${ms}ms waiting for: ${condition}`);
    this.name = 'DeadlineExceeded';
  }
}

/**
 * Race `p` against a deadline, returning a sentinel instead of throwing.
 * Used where missing the deadline is a normal outcome with its own handling --
 * the Feishu card callback being the motivating case.
 */
export async function raceDeadline<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  const miss = Symbol('miss');
  const timeout = new Promise<typeof miss>((resolve) => {
    const t = setTimeout(() => resolve(miss), Math.max(0, Math.round(ms * scale)));
    if (typeof t.unref === 'function') t.unref();
  });
  const r = await Promise.race([p, timeout]);
  return r === miss ? { settled: false } : { settled: true, value: r as T };
}
