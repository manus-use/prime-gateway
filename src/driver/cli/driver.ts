import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { delimiter, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type {
  AgentRuntime,
  Driver,
  DriverEvent,
  PromptInput,
  StartOptions,
  StartResult,
} from '../types.js';
import type { TurnTerminal } from '../../types.js';
import { buildEnv } from '../env.js';

/**
 * The CLI driver: one process per *turn*, driven by argv, read back as NDJSON.
 *
 * This exists because an agent's ACP server can be broken while its command line
 * works perfectly. ACP is the primary driver and stays that way -- it is the only
 * one that can carry a permission request, and the only one that keeps a session
 * alive between turns. This is the fallback for when it is unavailable, and it is
 * a genuinely worse thing. Three properties are worth knowing before choosing it:
 *
 * 1. **No approvals.** The command line has no permission protocol: the agent
 *    never asks, it just acts. So this driver can never emit a
 *    `permission-request`, the `operate` tier stops gating tool use, and approval
 *    cards stop appearing. That is not a limitation to work around -- it is a
 *    security posture, which is why `agent.unsupervised` has to be written down
 *    in the config before this driver will load at all.
 * 2. **No resume.** Each turn is a fresh process with a fresh agent session, and
 *    the session ids it mints cannot be handed back to it. Continuity is therefore
 *    reconstructed: the conversation so far is composed into the prompt as a
 *    transcript. That costs input tokens on every turn, and it means the agent
 *    recovers what was *said* but not the tool state behind it.
 * 3. **No cooperative cancel.** Cancelling means killing the process, so work
 *    already done stands.
 *
 * The wire format below is ByteSec's `run --format json` stream, verified against
 * 0.7.2 rather than inferred. Everything specific to it -- the flag spellings, the
 * event names -- stops at this file, in the same way ACP stops at `../acp`.
 */

export interface CliDriverConfig {
  command: string;
  /**
   * Leading arguments, from `agent.args`: the subcommand and any model choice.
   * The driver appends the flags it depends on for parsing.
   */
  args: readonly string[];
  /** Injected at spawn. Where credentials go; never a file in the workspace. */
  env?: Readonly<Record<string, string>>;
  /** Test seam. See MAX_PROMPT_BYTES. */
  maxPromptBytes?: number;
}

/**
 * How large a composed prompt may get.
 *
 * The prompt travels in argv, and argv has a hard kernel limit (1 MiB on Darwin,
 * ~2 MiB on Linux) beyond which the spawn fails with `E2BIG` -- an error that
 * reads like a broken binary rather than a long conversation. Well under it, so
 * the transcript is trimmed on our terms and with an explanation.
 */
const MAX_PROMPT_BYTES = 96 * 1024;

/** SIGTERM, then SIGKILL. Matches the ACP driver's grace period. */
const KILL_GRACE_MS = 2000;

/** Enough stderr to explain a failure, bounded so a chatty agent cannot grow it. */
const STDERR_TAIL_BYTES = 8192;

/** How long a finished turn waits for the tail of stderr. See `drain`. */
const STDERR_DRAIN_MS = 100;

/** Resolve once the stream has ended, or once the wait stops being worth it. */
async function drain(stream: Readable): Promise<void> {
  if (stream.readableEnded) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STDERR_DRAIN_MS);
    timer.unref();
    stream.once('end', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function createCliDriver(config: CliDriverConfig): Driver {
  return {
    id: 'structured-cli',
    async start(opts: StartOptions) {
      // Resolved here rather than at the first prompt. A command that does not
      // exist is a configuration mistake, and reporting it at start leaves the
      // session cold; reporting it mid-turn looks like the agent failing, and
      // failing mid-turn is what quarantines a session.
      const command = resolveExecutable(config.command, process.env['PATH']);

      const runtime = new CliRuntime({ ...config, command }, opts);
      return { runtime, result: runtime.startResult() };
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** One prompt and what the agent said back, for the transcript. */
interface Exchange {
  prompt: string;
  /** Empty when this turn predates the runtime and only the prompt is known. */
  answer: string;
}

class CliRuntime implements AgentRuntime {
  readonly providerSessionId: string;
  /** The fence label for the transcript, unguessable so it cannot be forged. */
  readonly #nonce: string;

  #config: CliDriverConfig & { command: string };
  #cwd: string;
  #history: Exchange[];
  #maxPromptBytes: number;

  /** Set synchronously by `prompt`, so a second caller is refused, not queued. */
  #inflight = false;
  #child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  #cancelled = false;
  #closed = false;
  /** Distinguishes "the user cancelled" from "we tore the runtime down". */
  #closedDuringTurn = false;

  constructor(config: CliDriverConfig & { command: string }, opts: StartOptions) {
    this.#config = config;
    this.#cwd = opts.cwd;
    this.#maxPromptBytes = config.maxPromptBytes ?? MAX_PROMPT_BYTES;
    this.#nonce = randomUUID().slice(0, 8);
    // The provider mints a session id per process and will not take one back, so
    // there is nothing durable to observe. This id names *this runtime*, and says
    // so, rather than recording a provider id that looks resumable and is not.
    this.providerSessionId = `cli:${this.#nonce}`;

    // Prior prompts come from the event log, which is the system of record. Their
    // answers do not: the log has them, but the driver is not allowed its own idea
    // of history and `StartOptions.replay` carries prompts only. So an inherited
    // turn contributes what was asked, and this runtime fills in both halves for
    // every turn it runs itself.
    this.#history = (opts.replay ?? []).map((input) => ({
      prompt: renderInput(input),
      answer: '',
    }));
  }

  /**
   * `fresh` or `replayed`, never `resumed`.
   *
   * The provider cannot resume, so `resume: native -> replay` -- the one degrade
   * this layer sanctions -- is not a fallback here but the permanent state. When
   * there is history to carry, that is `replayed`, and the user is entitled to see
   * it every time rather than have it look like a resumed session.
   */
  startResult(): StartResult {
    return {
      providerSessionId: this.providerSessionId,
      mode: this.#history.length === 0 ? 'fresh' : 'replayed',
    };
  }

  prompt(input: PromptInput): AsyncIterable<DriverEvent> {
    if (this.#closed) throw new Error('runtime is closed');
    if (this.#inflight) {
      // Serialization is the session actor's job. If two prompts reach here the
      // actor is broken, and continuing would interleave two turns' output into
      // one stream with no way to tell them apart afterwards.
      throw new Error('a turn is already in flight on this runtime');
    }
    this.#inflight = true;
    this.#cancelled = false;
    this.#closedDuringTurn = false;
    return this.#run(input);
  }

  async *#run(input: PromptInput): AsyncGenerator<DriverEvent> {
    try {
      const composed = this.#compose(input);
      if (composed === undefined) {
        const size = Buffer.byteLength(renderInput(input), 'utf8');
        yield {
          kind: 'error',
          message:
            `this message is ${String(size)} bytes, and the agent is invoked with the ` +
            `prompt on its command line, which caps it at ${String(this.#maxPromptBytes)}. ` +
            'Attach it as a file instead.',
          // Nothing about retrying makes the message shorter.
          retryable: false,
        };
        // It never reached the agent, so nothing happened and nothing is unclear.
        yield { kind: 'turn-ended', terminal: 'failed' };
        return;
      }

      if (this.#cancelled) {
        // Cancelled between the synchronous `prompt` call and the first `next`.
        yield { kind: 'turn-ended', terminal: 'cancelled' };
        return;
      }

      yield* this.#runTurn(input, composed);
    } finally {
      this.#inflight = false;
      this.#child = undefined;
    }
  }

  async *#runTurn(input: PromptInput, composed: string): AsyncGenerator<DriverEvent> {
    const args = [
      ...this.#config.args,
      // The parsing contract. Passed by the driver rather than left to the
      // operator's `agent.args`, because the driver cannot read `text` output and
      // a missing flag here is a turn that produces nothing at all.
      '--format',
      'json',
      // Per session, so it cannot live in the configured args.
      '--dir',
      this.#cwd,
      // Unsupervised, explicitly. There is no channel on which a permission
      // request could be answered -- stdin is closed -- so an agent that stopped
      // to ask would hang the turn until something killed it. `agent.unsupervised`
      // is what the operator wrote down; this is that decision, carried out.
      '-y',
      // Without this a message beginning with `-` is parsed as flags, and the
      // agent prints its own help instead of answering.
      '--',
      composed,
    ];

    const child = spawn(this.#config.command, args, {
      cwd: this.#cwd,
      env: buildEnv(process.env, this.#config.env ?? {}),
      // stdin is /dev/null: the prompt travels in argv, and an agent that blocks
      // on input would otherwise block forever with nobody to notice.
      stdio: ['ignore', 'pipe', 'pipe'],
      // No shell. The prompt is user-authored text; a shell here would make every
      // backtick in a Lark message a command.
      shell: false,
    }) as ChildProcessByStdio<null, Readable, Readable>;
    this.#child = child;

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });

    const exited = new Promise<number | null>((resolve) => {
      // Settled on `exit` rather than `close`, then given a moment for the last
      // stderr chunk. `exit` can outrun the pipe, and stderr is the only
      // explanation a failed turn ever gives -- but waiting for `close` would hang
      // forever whenever a background task the agent started inherited the pipe.
      const settle = (code: number | null): void => {
        void drain(child.stderr).then(() => resolve(code));
      };
      child.once('exit', (code) => settle(code));
      child.once('error', (err) => {
        // Spawn itself failed -- the binary went away between start and now. The
        // message is the only evidence there will be.
        stderr = `${stderr}${err.message}\n`.slice(-STDERR_TAIL_BYTES);
        settle(null);
      });
    });

    let summary: TurnSummary | undefined;
    let said = false;

    const lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        const parsed = parseLine(line);
        if (parsed === undefined) continue;
        if (parsed === 'permission') {
          // Not expected -- `-y` exists precisely so this cannot happen -- but if a
          // future version asks anyway, there is no channel to answer on and the
          // process would wait for an answer that can never arrive. Stopping it is
          // strictly better than a turn that hangs until something else notices.
          yield {
            kind: 'error',
            message:
              'the agent stopped to ask for permission, which this driver has no way to ' +
              'answer. The turn was stopped rather than left waiting. Use the acp driver ' +
              'for work that needs approval.',
            retryable: false,
          };
          await this.#kill();
          // It had already started acting, and we killed it partway.
          yield { kind: 'turn-ended', terminal: 'ambiguous' };
          return;
        }
        if ('finish' in parsed) {
          // Keep the last. One invocation is one prompt and therefore one turn,
          // but a stream that somehow reports two should be judged on the later.
          summary = parsed;
          continue;
        }
        if (parsed.kind === 'message-chunk') said = true;
        yield parsed;
      }
    } finally {
      lines.close();
    }

    const code = await exited;

    // Streamed nothing, but reported an answer. Some builds do not stream at all,
    // and a card reading "finished with no output" next to a summary that holds
    // the whole reply is a gateway bug, not an agent one.
    if (!said && summary !== undefined && summary.content !== '') {
      yield { kind: 'message-chunk', text: summary.content };
      said = true;
    }

    if (summary !== undefined) {
      this.#remember(input, summary.content);
    }

    // Teardown beats cancellation beats what the agent said: closing is a decision
    // of ours, and reporting the killed process as `ambiguous` would quarantine a
    // session over a shutdown we chose.
    if (this.#closedDuringTurn) {
      yield { kind: 'turn-ended', terminal: 'cancelled', detail: 'runtime closed' };
      return;
    }
    if (this.#cancelled && summary === undefined) {
      yield { kind: 'turn-ended', terminal: 'cancelled' };
      return;
    }

    if (summary === undefined) {
      yield {
        kind: 'error',
        message:
          `agent process exited (code ${String(code)}) without finishing the turn` +
          errorSuffix(stderr),
        // Nothing about a dead process says the work itself was impossible.
        // Whether it is retried is the core's decision, not ours.
        retryable: true,
      };
      // Ambiguous, not failed: the process is gone, so whether it acted on the
      // prompt first is exactly what we cannot establish -- and that distinction
      // is what gates quarantine rather than a blind retry.
      yield { kind: 'turn-ended', terminal: 'ambiguous' };
      return;
    }

    const terminal = terminalFor(summary.finish);
    if (terminal === 'failed') {
      // The summary says it failed and carries no reason; the reason is on stderr,
      // where a card will never look for it.
      yield {
        kind: 'error',
        message: `the agent reported a failed turn${errorSuffix(stderr)}`,
        retryable: true,
      };
    }
    yield {
      kind: 'turn-ended',
      terminal,
      ...(terminal === 'ambiguous' ? { detail: `unrecognized finish "${summary.finish}"` } : {}),
    };
  }

  /** Record the exchange, so the next turn can be told about it. */
  #remember(input: PromptInput, answer: string): void {
    this.#history.push({ prompt: renderInput(input), answer: answer.trim() });
  }

  /**
   * The prompt as the agent will receive it: the conversation, then the message.
   *
   * Undefined when the message alone does not fit, which is the one case trimming
   * cannot fix.
   */
  #compose(input: PromptInput): string | undefined {
    const message = renderInput(input);
    if (Buffer.byteLength(message, 'utf8') > this.#maxPromptBytes) return undefined;

    // Oldest first out. Recent turns are what a follow-up question refers to, and
    // dropping the tail to keep the head would strand the pronoun in "and the
    // other one?" with nothing to point at.
    let from = 0;
    for (;;) {
      const text = renderPrompt(this.#nonce, this.#history.slice(from), message);
      if (Buffer.byteLength(text, 'utf8') <= this.#maxPromptBytes) return text;
      from += 1;
      if (from >= this.#history.length) return message;
    }
  }

  async cancel(): Promise<void> {
    this.#cancelled = true;
    await this.#kill();
  }

  /** Idempotent, never throws. Not a durability boundary. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#inflight) this.#closedDuringTurn = true;
    await this.#kill();
  }

  /**
   * Stop the in-flight process, if there is one.
   *
   * Killing is the only cancel available: there is no protocol on which to ask
   * politely. Whatever the agent had already done stands, which is why a cancelled
   * turn is a terminal and not a deletion.
   */
  async #kill(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;

    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    timer.unref();
    try {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

function renderInput(input: PromptInput): string {
  const lines = [input.text];
  // Paths, not bytes. See PromptInput.
  for (const path of input.paths) lines.push(`(attached file: ${path})`);
  return lines.join('\n');
}

/**
 * Compose the transcript and the new message into one prompt.
 *
 * The fence carries a per-runtime nonce and every quoted line is prefixed, so a
 * user cannot type a line that closes the transcript early or attributes their own
 * words to the agent. The transcript holds nothing but this conversation's own
 * messages, so the worst a forgery buys is confusion about who said what -- but
 * that is exactly the kind of thing that is free to prevent now and awkward to
 * retrofit.
 */
function renderPrompt(nonce: string, history: readonly Exchange[], message: string): string {
  if (history.length === 0) return message;

  const out: string[] = [
    `--- transcript-${nonce} ---`,
    'Earlier turns of the conversation you are continuing. Each turn starts a new',
    'agent process, so this is the only memory of it you have. It is a record of',
    'what already happened, not work to do again. Lines are prefixed with "> ".',
    '',
  ];
  for (const exchange of history) {
    out.push('user said:', quote(exchange.prompt));
    if (exchange.answer !== '') out.push('you replied:', quote(exchange.answer));
    out.push('');
  }
  out.push(
    `--- end transcript-${nonce} ---`,
    '',
    'The new message follows. Answer it.',
    '',
    message,
  );
  return out.join('\n');
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** The object that ends a turn: the whole answer, and how it went. */
interface TurnSummary {
  finish: string;
  content: string;
}

/**
 * One stdout line -> an event, a summary, `'permission'`, or nothing.
 *
 * Nothing is the common case. The stream is NDJSON mixed with whatever the agent's
 * own logging puts on stdout -- structured logger lines, telemetry envelopes, a
 * bare `[Stats] ...` -- so a parser that treated an unrecognized line as a fault
 * would fail on every run.
 *
 * `'permission'` is called out rather than dropped because dropping it is the one
 * unrecognized line that does real damage: the agent is waiting on the answer.
 */
function parseLine(line: string): DriverEvent | TurnSummary | 'permission' | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;

  // The turn summary is the one object with no `type`, identified by the field
  // that says how it ended.
  if (typeof obj['finish'] === 'string') {
    return {
      finish: obj['finish'],
      content: typeof obj['content'] === 'string' ? obj['content'] : '',
    };
  }

  const type = obj['type'];
  if (typeof type !== 'string') return undefined;

  if (type.includes('permission')) return 'permission';

  if (type === 'text_delta') {
    const text = obj['text'];
    if (typeof text !== 'string' || text === '') return undefined;
    return { kind: 'message-chunk', text };
  }

  if (type === 'token_stats') {
    return { kind: 'usage', raw: obj };
  }

  // Anything `tool_*` is a tool call moving through its states. Matched on the
  // prefix rather than an exhaustive list because the states that matter most are
  // the failure ones, and a `tool_*` name nobody enumerated would otherwise leave
  // a tool showing as still running for the rest of the conversation.
  if (type.startsWith('tool_')) {
    const id = firstString(obj['part_id'], obj['message_id']) ?? type;
    const status = firstString(obj['status']) ?? type.slice('tool_'.length);
    if (type === 'tool_running') {
      return {
        kind: 'tool-call',
        toolCallId: id,
        title: firstString(obj['tool']) ?? 'tool',
        status,
        raw: obj,
      };
    }
    return { kind: 'tool-call-update', toolCallId: id, status, raw: obj };
  }

  // Dropped, not an error. The format grows by adding types, and a switch that
  // threw would make every agent upgrade a breaking change.
  return undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * `finish` -> our terminal.
 *
 * An unrecognized value is `ambiguous` rather than assumed benign: the whole point
 * of the grade is that "we do not know how this ended" is a distinct state from
 * both success and failure, and it is the one that gates quarantine.
 */
function terminalFor(finish: string): TurnTerminal {
  switch (finish.toLowerCase()) {
    case 'completed':
    case 'stop':
    case 'refusal':
      return 'completed';
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'aborted':
      return 'cancelled';
    default:
      return 'ambiguous';
  }
}

// ---------------------------------------------------------------------------
// stderr
// ---------------------------------------------------------------------------

/** Colour codes, which an agent writes whether or not stderr is a terminal. */
const ANSI = /\u001B\[[0-9;]*m/g;

/**
 * The explanation, dug out of stderr.
 *
 * A failed turn arrives as `finish: "error"` and nothing else -- no message, no
 * code. The reason is on stderr, buried in start-up banners and structured logger
 * lines, and without this the user reads "the agent failed" and has nowhere to go.
 *
 * JSON lines are skipped: the agent's own logger writes there, and its `warn`
 * about an unrelated background sync is not the reason this turn failed.
 */
function errorSuffix(stderr: string): string {
  const candidates = stderr
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('{'));

  const explicit = candidates
    .map((line) => /terminated in error state:\s*(.+)$/.exec(line)?.[1])
    .findLast((match) => match !== undefined);
  const chosen =
    explicit ?? candidates.findLast((line) => /error|fail|refus/i.test(line)) ?? candidates.at(-1);

  if (chosen === undefined) return '';
  return `: ${chosen.slice(-500)}`;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Find the executable, or say so now.
 *
 * `spawn` resolves a bare name on PATH itself, but only when it runs -- which is
 * mid-turn, where the failure reads as the agent breaking rather than as a name
 * that was never going to resolve. Checked without spawning anything: probing with
 * `--version` would mean inventing a flag the configured binary may not have.
 */
export function resolveExecutable(command: string, path: string | undefined): string {
  const executable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (command.includes('/') || isAbsolute(command)) {
    if (executable(command)) return command;
    throw new Error(`the agent command ${JSON.stringify(command)} is not an executable file`);
  }

  const dirs = (path ?? '').split(delimiter).filter((dir) => dir !== '');
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (executable(candidate)) return candidate;
  }
  throw new Error(
    `the agent command ${JSON.stringify(command)} was not found on PATH ` +
      `(${String(dirs.length)} entries searched). Use an absolute path if it is not on PATH.`,
  );
}
