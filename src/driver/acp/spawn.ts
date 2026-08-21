import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { Stream } from '@agentclientprotocol/sdk';
import { ndJsonStream } from '@agentclientprotocol/sdk';

/**
 * Spawning the agent process, and constructing its environment.
 *
 * The environment is built by **allowlist**, not by copying `process.env` and
 * deleting things. Those two are not equivalent: a denylist is only as good as
 * its last update, and the gateway's own environment will accumulate variables
 * nobody auditing this file knows about. An allowlist fails closed -- a variable
 * the agent needs but nobody listed produces a clear error, whereas a variable it
 * should never have seen produces a leak nobody notices.
 */

/**
 * Variables passed through to the agent.
 *
 * Deliberately short. Anything the agent needs that is not here should be added
 * here explicitly, in a commit someone reviews.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  // Node/toolchain discovery the agent legitimately needs to run commands.
  'NODE_PATH',
  'NVM_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  // Proxy configuration, without which an agent behind a corporate proxy simply
  // cannot reach anything and reports it as an unexplained network failure.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/**
 * Variables scrubbed even if something puts them back.
 *
 * When the gateway itself is launched from inside Claude Code, these are present
 * in `process.env` and make the child believe it is a nested session. The symptom
 * is not a crash -- it is an agent that quietly behaves differently, which is the
 * hardest kind of thing to debug.
 *
 * This list is applied *after* the allowlist as a belt-and-braces measure: if
 * someone later adds a broad passthrough, this still holds.
 */
const ENV_SCRUB_PREFIXES = ['CLAUDE_CODE_'] as const;
const ENV_SCRUB_EXACT = ['CLAUDECODE', 'CLAUDE_PID'] as const;

export interface SpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /**
   * Extra variables, injected at spawn time.
   *
   * This is where credentials belong -- in the child's environment, never in a
   * file inside the workspace. A file in the workspace is readable by every tool
   * the agent runs, survives the process, and lands in a `git status`.
   */
  env?: Readonly<Record<string, string>>;
}

export function buildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) out[key] = value;

  for (const key of Object.keys(out)) {
    if (ENV_SCRUB_EXACT.includes(key as (typeof ENV_SCRUB_EXACT)[number])) delete out[key];
    if (ENV_SCRUB_PREFIXES.some((p) => key.startsWith(p))) delete out[key];
  }
  return out;
}

export interface SpawnedAgent {
  stream: Stream;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  /** Most recent stderr, ring-buffered. The only diagnostic when spawn misfires. */
  stderrTail(): string;
  /** Idempotent. SIGTERM, then SIGKILL after a grace period. */
  kill(): Promise<void>;
}

const STDERR_TAIL_BYTES = 8192;
const KILL_GRACE_MS = 2000;

/**
 * Spawn an ACP agent over stdio.
 *
 * `stdio` is `['pipe','pipe','pipe']`: stderr is captured rather than inherited
 * because an agent that fails to start writes its only explanation there, and
 * inheriting sends it to a console nobody is reading in a service context.
 */
export function spawnAgent(opts: SpawnOptions): SpawnedAgent {
  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
    opts.command,
    [...opts.args],
    {
      cwd: opts.cwd,
      env: buildEnv(process.env, opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell. Arguments are passed as an array so a path containing a space
      // or a semicolon is an argument, not a command.
      shell: false,
    },
  ) as ChildProcessByStdio<Writable, Readable, Readable>;

  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  let killing: Promise<void> | undefined;
  const kill = (): Promise<void> => {
    // Idempotent by memoization. Teardown is reached from several paths --
    // explicit close, connection loss, boot reconciliation -- and each of them
    // must be safe to call after the others.
    killing ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      timer.unref();
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    })();
    return killing;
  };

  return { stream, exited, stderrTail: () => stderrTail, kill };
}
