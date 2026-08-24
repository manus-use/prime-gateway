import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { Stream } from '@agentclientprotocol/sdk';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { buildEnv } from '../env.js';

/**
 * Spawning an ACP agent over stdio.
 *
 * The child's environment comes from `../env.ts`, which is shared with the CLI
 * driver: what an agent is allowed to read has nothing to do with which protocol
 * it speaks.
 */

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

export interface SpawnedAgent {
  stream: Stream;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  /** Most recent stderr, ring-buffered. The only diagnostic when spawn misfires. */
  stderrTail(): string;
  /**
   * Total bytes ever written to stderr.
   *
   * Lets a caller tell what arrived during some window from what was already
   * there. Without it, a startup banner still sitting in the ring buffer looks
   * like the explanation for a failure that happened minutes later.
   */
  stderrBytes(): number;
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
  let stderrBytes = 0;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBytes += chunk.length;
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

  return {
    stream,
    exited,
    stderrTail: () => stderrTail,
    stderrBytes: () => stderrBytes,
    kill,
  };
}
