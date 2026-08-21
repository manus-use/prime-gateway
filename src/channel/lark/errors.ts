import { ChannelError, RETRYABLE_CODES } from '../types.js';

/**
 * Turn whatever the Lark SDK threw into a `ChannelError`.
 *
 * The awkward part, and the reason this is a dedicated module: **Feishu reports
 * rate limiting three different ways.**
 *
 *   1. HTTP 429.
 *   2. HTTP 400 with body code `99991400`.
 *   3. A business error code inside an otherwise successful 2xx body.
 *
 * So the code has to be extracted before anything branches on status. Code that
 * checks `status === 429` sees case 2 as a permanent client error and case 3 as a
 * success, and in both cases the message is silently lost.
 */

interface MaybeLarkError {
  code?: unknown;
  msg?: unknown;
  message?: unknown;
  status?: unknown;
  response?: {
    status?: unknown;
    data?: { code?: unknown; msg?: unknown } | undefined;
    headers?: Record<string, unknown> | undefined;
  };
  headers?: Record<string, unknown> | undefined;
  cause?: unknown;
}

/** Retry-After, as Feishu spells it. Honoured in preference to a fixed backoff. */
const RESET_HEADER = 'x-ogw-ratelimit-reset';

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function headersOf(err: MaybeLarkError): Record<string, unknown> {
  return err.response?.headers ?? err.headers ?? {};
}

/**
 * Extract the business code, preferring the body over the status.
 *
 * Returns 0 when there is no code at all, which is treated as "some other
 * failure" rather than as success -- a thrown error with no code is still an
 * error.
 */
function codeOf(err: MaybeLarkError): number {
  return (
    num(err.response?.data?.code) ??
    num(err.code) ??
    num(err.response?.status) ??
    num(err.status) ??
    0
  );
}

function messageOf(err: MaybeLarkError): string {
  const candidates = [err.response?.data?.msg, err.msg, err.message];
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return c;
  }
  return 'lark request failed';
}

export function toChannelError(raw: unknown): ChannelError {
  if (raw instanceof ChannelError) return raw;

  const err = (raw ?? {}) as MaybeLarkError;
  const code = codeOf(err);
  const status = num(err.response?.status) ?? num(err.status);

  const retryable =
    RETRYABLE_CODES.has(code) ||
    status === 429 ||
    // 5xx is a server-side failure, so retrying is the correct default. It also
    // means the request may have been applied -- which is exactly what the
    // uuid-based idempotency is for.
    (status !== undefined && status >= 500);

  const resetSeconds = num(headersOf(err)[RESET_HEADER]);
  const retryAfterMs = resetSeconds === undefined ? undefined : Math.max(0, resetSeconds * 1000);

  return new ChannelError(
    code,
    messageOf(err),
    retryable,
    ...(retryAfterMs === undefined ? [] : ([retryAfterMs] as const)),
  );
}

/** Default backoff when the platform did not tell us how long to wait. */
export function backoffMs(attempt: number): number {
  const base = Math.min(8000, 250 * 2 ** attempt);
  // Jittered, because N sessions throttled by the same per-chat limit would
  // otherwise all retry in lockstep and re-trigger it.
  return base / 2 + Math.random() * (base / 2);
}
