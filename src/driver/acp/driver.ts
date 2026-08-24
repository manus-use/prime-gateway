import {
  client,
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type ClientConnection,
  type ContentBlock,
  type NewSessionResponse,
  type PermissionOption as AcpPermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk';
import type {
  AgentRuntime,
  Driver,
  DriverEvent,
  PermissionOutcome,
  PromptInput,
  StartMode,
  StartOptions,
  StartResult,
} from '../types.js';
import type { PermissionOption, TurnTerminal } from '../../types.js';
import { spawnAgent, type SpawnedAgent } from './spawn.js';

/**
 * The ACP driver.
 *
 * The gateway is the ACP **client**, which means it does not merely call the
 * agent -- it must also *serve* client methods, because the agent calls back into
 * us for permissions. Forgetting that inverts the mental model and makes the
 * permission flow look like an outbound call it is not.
 *
 * Everything ACP-specific stops at this file. What leaves is `DriverEvent`.
 */

export interface AcpDriverConfig {
  command: string;
  args: readonly string[];
  /** Injected at spawn. Where credentials go; never a file in the workspace. */
  env?: Readonly<Record<string, string>>;
  clientName?: string;
}

/**
 * Capabilities we actually advertise.
 *
 * All false, deliberately. Advertising a capability we do not serve is not a
 * harmless overstatement -- the agent will call the method, and get an error in
 * the middle of a turn instead of taking the fallback path it would have taken
 * had we been honest at initialize time.
 */
const CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

export function createAcpDriver(config: AcpDriverConfig): Driver {
  return {
    id: 'acp',
    async start(opts: StartOptions) {
      return startAcpSession(config, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Session establishment
// ---------------------------------------------------------------------------

async function startAcpSession(
  config: AcpDriverConfig,
  opts: StartOptions,
): Promise<{ runtime: AgentRuntime; result: StartResult }> {
  const proc = spawnAgent({
    command: config.command,
    args: config.args,
    cwd: opts.cwd,
    ...(config.env === undefined ? {} : { env: config.env }),
  });

  const runtime = new AcpRuntime(proc);

  try {
    const result = await runtime.establish(config, opts);
    return { runtime, result };
  } catch (err) {
    // A half-established runtime must never escape. Two-phase start means the
    // caller gets a usable runtime or an error, never something it has to probe.
    await runtime.close();
    const tail = proc.stderrTail().trim();
    throw new Error(
      `ACP session failed to start: ${err instanceof Error ? err.message : String(err)}` +
        (tail === '' ? '' : `\nagent stderr:\n${tail}`),
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * A queue that lets a push-model callback feed a pull-model async iterator.
 *
 * The ACP SDK delivers `session/update` as notification callbacks; the core wants
 * `for await`. Something has to bridge them, and it has to buffer, because the
 * agent does not wait for us to be ready to read.
 */
class EventQueue {
  #buffer: DriverEvent[] = [];
  #waiting: ((v: IteratorResult<DriverEvent>) => void) | undefined;
  #done = false;

  push(event: DriverEvent): void {
    if (this.#done) return;
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ value: event, done: false });
      return;
    }
    this.#buffer.push(event);
  }

  /** Ends the iterator once the buffer drains. Buffered events are not discarded. */
  end(): void {
    this.#done = true;
    const waiting = this.#waiting;
    if (waiting !== undefined && this.#buffer.length === 0) {
      this.#waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<DriverEvent>> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) return { value: buffered, done: false };
    if (this.#done) return { value: undefined, done: true };
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }
}

/**
 * How long a failed prompt waits to find out whether the process died.
 *
 * The transport notices a dead child by its stdout closing, and rejects the
 * in-flight request with a generic "connection closed" before the `exit` event is
 * delivered. Reporting that verbatim throws away the stderr tail, which is the
 * only explanation an agent that dies mid-turn ever gives -- so a failing prompt
 * waits briefly for the exit before composing its message. Only ever reached on a
 * path that has already failed.
 */
const EXIT_GRACE_MS = 250;

class AcpRuntime implements AgentRuntime {
  #proc: SpawnedAgent;
  #conn: ClientConnection | undefined;
  #sessionId: string | undefined;
  /** The queue for the turn currently in flight. Only one exists at a time. */
  #turn: EventQueue | undefined;
  #closed = false;
  /** Set once the child is gone, so a failing prompt can tell why. */
  #exit: { code: number | null } | undefined;
  /** Updates delivered during the current turn. Zero of them is a signal. */
  #emitted = 0;
  /** stderr byte count when the current turn started, to scope the tail to it. */
  #stderrMark = 0;

  constructor(proc: SpawnedAgent) {
    this.#proc = proc;
  }

  get providerSessionId(): string {
    if (this.#sessionId === undefined) throw new Error('runtime not established');
    return this.#sessionId;
  }

  /**
   * initialize -> (resume | load | new), then prompt-ready.
   *
   * `resume: native -> replay` is the only automatic degrade permitted here. Both
   * `session/resume` and `session/load` are optional agent methods, so both are
   * capability-gated; an agent that advertises neither gets a fresh session plus
   * replay from the log, which is a *worse* outcome and therefore has to be
   * reported rather than hidden.
   */
  async establish(config: AcpDriverConfig, opts: StartOptions): Promise<StartResult> {
    const app = client({ name: config.clientName ?? 'prime-gateway' })
      .onNotification('session/update', ({ params }) => {
        this.#onUpdate(params);
      })
      .onRequest('session/request_permission', async ({ params }) =>
        this.#onPermission(params),
      );

    const conn = app.connect(this.#proc.stream);
    this.#conn = conn;

    // A dead process is otherwise indistinguishable from a slow one: the request
    // simply never resolves. Surface the exit instead of hanging.
    void this.#proc.exited.then((code) => {
      this.#exit = { code };
      const queue = this.#turn;
      if (queue !== undefined) {
        queue.push(this.#exitError(code));
        // Ambiguous, not failed. The process is gone, so we cannot establish
        // whether the prompt was consumed before it died -- and that distinction
        // is exactly what gates quarantine rather than a blind retry.
        queue.push({ kind: 'turn-ended', terminal: 'ambiguous' });
        queue.end();
      }
      conn.close();
    });

    const init = await conn.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
    });

    const caps = init.agentCapabilities ?? {};
    const canResume = caps.sessionCapabilities?.resume != null;
    const canLoad = caps.loadSession === true;

    if (opts.providerSessionId !== undefined) {
      if (canResume) {
        await conn.agent.request('session/resume', {
          sessionId: opts.providerSessionId,
          cwd: opts.cwd,
        });
        this.#sessionId = opts.providerSessionId;
        return { providerSessionId: opts.providerSessionId, mode: 'resumed' };
      }
      if (canLoad) {
        // `session/load` replays the agent's own history back at us as
        // notifications. We deliberately do not forward them: the log is the
        // system of record, and re-emitting history as if it were new output
        // would duplicate everything the user has already read.
        await conn.agent.request('session/load', {
          sessionId: opts.providerSessionId,
          cwd: opts.cwd,
          mcpServers: [],
        });
        this.#sessionId = opts.providerSessionId;
        return { providerSessionId: opts.providerSessionId, mode: 'resumed' };
      }
    }

    const created: NewSessionResponse = await conn.agent.request('session/new', {
      cwd: opts.cwd,
      mcpServers: [],
    });
    this.#sessionId = created.sessionId;

    const mode: StartMode = await this.#maybeReplay(opts) ? 'replayed' : 'fresh';
    return { providerSessionId: created.sessionId, mode };
  }

  /**
   * Replay prior prompts into a fresh session.
   *
   * Replayed prompts are driven to completion and their output is discarded: the
   * user has already seen it, and re-rendering it would look like the agent
   * repeating itself. What we are buying is the agent's *internal* state, not its
   * output.
   */
  async #maybeReplay(opts: StartOptions): Promise<boolean> {
    const replay = opts.replay ?? [];
    if (replay.length === 0) return false;
    for (const input of replay) {
      for await (const _ of this.prompt(input)) {
        // Intentionally drained without forwarding.
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Prompting
  // -------------------------------------------------------------------------

  prompt(input: PromptInput): AsyncIterable<DriverEvent> {
    const conn = this.#conn;
    const sessionId = this.#sessionId;
    if (conn === undefined || sessionId === undefined) {
      throw new Error('runtime not established');
    }
    if (this.#turn !== undefined) {
      // Serialization is the session actor's job. If two prompts reach here the
      // actor is broken, and continuing would interleave two turns' output into
      // one stream with no way to tell them apart afterwards.
      throw new Error('a turn is already in flight on this runtime');
    }

    const queue = new EventQueue();
    this.#turn = queue;
    this.#emitted = 0;
    this.#stderrMark = this.#proc.stderrBytes();

    const blocks: ContentBlock[] = [{ type: 'text', text: input.text }];
    for (const path of input.paths) {
      // Paths, not bytes. See PromptInput.
      blocks.push({ type: 'resource_link', uri: `file://${path}`, name: path });
    }

    void (async () => {
      try {
        const response = await conn.agent.request('session/prompt', {
          sessionId,
          prompt: blocks,
        });
        const silent = this.#silentTurnError();
        if (silent !== undefined) queue.push(silent);
        queue.push({ kind: 'turn-ended', terminal: terminalFor(response.stopReason) });
      } catch (err) {
        // Whether this was the agent failing a request or the process dying under
        // it decides what the user is told, and the two arrive in either order.
        const exit = await this.#awaitExit();
        queue.push(
          exit === undefined
            ? {
                kind: 'error',
                message: err instanceof Error ? err.message : String(err),
                retryable: false,
                raw: err,
              }
            : { ...this.#exitError(exit.code), raw: err },
        );
        // The request threw, so we know it did not complete -- but not whether
        // the agent acted on it first. Ambiguous is the honest terminal.
        queue.push({ kind: 'turn-ended', terminal: 'ambiguous' });
      } finally {
        queue.end();
        if (this.#turn === queue) this.#turn = undefined;
      }
    })();

    return {
      [Symbol.asyncIterator]: () => ({ next: () => queue.next() }),
    };
  }

  /** The exit, if the process is already gone or goes within the grace period. */
  async #awaitExit(): Promise<{ code: number | null } | undefined> {
    if (this.#exit !== undefined) return this.#exit;
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), EXIT_GRACE_MS);
      timer.unref();
    });
    try {
      await Promise.race([this.#proc.exited, grace]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return this.#exit;
  }

  /**
   * The diagnostic for a turn that reported success and produced nothing.
   *
   * An agent can fail internally and still answer `session/prompt` with
   * `end_turn`: a bad model id, an expired credential, a tool that threw. The
   * protocol says the turn ended, the card says "finished with no output", and
   * the explanation is sitting in stderr where nobody sees it. That combination
   * -- a clean terminal, zero updates, and stderr written *during the turn* --
   * is not a turn with nothing to say, so hand over what the agent said.
   *
   * Only what the turn itself wrote. The tail is a ring buffer that outlives the
   * turn, so a start-up banner ("Authenticated as ...") is still in it long
   * afterwards, and quoting that as the reason for a later empty turn sends
   * someone off debugging their credentials. Nothing written during the turn
   * means no evidence, and saying nothing beats inventing a cause.
   *
   * Not an error terminal either: the agent claimed success and we have no
   * standing to overrule it. This only adds the evidence.
   */
  #silentTurnError(): Extract<DriverEvent, { kind: 'error' }> | undefined {
    if (this.#emitted > 0) return undefined;
    const added = this.#proc.stderrBytes() - this.#stderrMark;
    if (added <= 0) return undefined;
    const tail = this.#proc.stderrTail();
    const during = tail.slice(Math.max(0, tail.length - added)).trim();
    if (during === '') return undefined;
    return {
      kind: 'error',
      message:
        'the agent reported success but produced no output, and wrote: ' + during.slice(-500),
      // Nothing here says the work was impossible -- a bad model id is fixed by
      // configuration, and the same prompt then succeeds.
      retryable: true,
    };
  }

  #exitError(code: number | null): Extract<DriverEvent, { kind: 'error' }> {
    const tail = this.#proc.stderrTail().trim();
    return {
      kind: 'error',
      message:
        `agent process exited (code ${String(code)}) mid-turn` +
        (tail === '' ? '' : `: ${tail.slice(-500)}`),
      // Retryable: nothing about a dead process says the work itself was
      // impossible. Whether it is retried is the core's decision, not ours.
      retryable: true,
    };
  }

  #onUpdate(params: SessionNotification): void {
    const queue = this.#turn;
    // Updates outside a turn are dropped rather than buffered. They arrive during
    // `session/load` replay, and buffering them would deliver the agent's entire
    // history as the first thing the next turn emits.
    if (queue === undefined) return;
    const event = toDriverEvent(params.update);
    if (event !== undefined) {
      this.#emitted += 1;
      queue.push(event);
    }
  }

  /**
   * Serve `session/request_permission`.
   *
   * This blocks the agent until it resolves. That is the mechanism, not a
   * side-effect, and it is why every path out of here must eventually answer:
   * an exception that escapes without answering does not fail the turn, it hangs
   * the agent indefinitely.
   */
  #onPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>((resolve) => {
      const answer = (outcome: PermissionOutcome): void => {
        resolve({
          outcome:
            outcome.kind === 'cancelled'
              ? { outcome: 'cancelled' }
              : { outcome: 'selected', optionId: outcome.optionId },
        });
      };

      const queue = this.#turn;
      if (queue === undefined) {
        // No turn to attribute this to and therefore nobody to ask. Cancel rather
        // than leave the agent blocked on a question that will never be shown.
        answer({ kind: 'cancelled' });
        return;
      }

      let answered = false;
      queue.push({
        kind: 'permission-request',
        requestId: String(params.toolCall.toolCallId),
        action: params.toolCall.title ?? String(params.toolCall.toolCallId),
        options: params.options.map(toPermissionOption),
        raw: params,
        resolve: (outcome) => {
          // Guarded because the core reaches this from several places -- a click, a
          // text reply, cancellation, teardown -- and a double-resolve would
          // otherwise silently keep the first answer while the second path
          // believes it succeeded.
          if (answered) return;
          answered = true;
          answer(outcome);
        },
      });
    });
  }

  async cancel(): Promise<void> {
    const conn = this.#conn;
    const sessionId = this.#sessionId;
    if (conn === undefined || sessionId === undefined) return;
    try {
      await conn.agent.notify('session/cancel', { sessionId });
    } catch {
      // Best-effort. The turn's terminal comes from the prompt response, which
      // reports `cancelled` on its own; a failed notify does not change that.
    }
  }

  /**
   * Idempotent, never throws.
   *
   * `session/close` is attempted as a courtesy and its result is ignored. It is
   * not a durability boundary: the process can die without it, so nothing may
   * treat a successful close as evidence a turn completed.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    // Settle an open turn *before* any teardown. Killing the process first lets
    // the transport's own "connection closed" rejection reach the queue, and that
    // path reports `ambiguous` -- which would quarantine a session over a shutdown
    // we chose ourselves. Closing is a decision, so the terminal is `cancelled`.
    const open = this.#turn;
    if (open !== undefined) {
      this.#turn = undefined;
      open.push({ kind: 'turn-ended', terminal: 'cancelled', detail: 'runtime closed' });
      open.end();
    }

    const conn = this.#conn;
    const sessionId = this.#sessionId;
    if (conn !== undefined && sessionId !== undefined) {
      try {
        await conn.agent.request('session/close', { sessionId });
      } catch {
        // Optional method, possibly unimplemented, possibly a dead connection.
      }
    }
    try {
      conn?.close();
    } catch {
      // Already closed.
    }
    await this.#proc.kill();
  }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function toPermissionOption(o: AcpPermissionOption): PermissionOption {
  return { optionId: o.optionId, name: o.name, kind: o.kind };
}

/**
 * ACP `stopReason` -> our terminal.
 *
 * `refusal` maps to `completed`, not `failed`: the agent ran and declined, which
 * is a legitimate outcome to show the user, not an error to retry. Retrying a
 * refusal just produces the same refusal.
 */
function terminalFor(stop: StopReason): TurnTerminal {
  switch (stop) {
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'ambiguous';
  }
}

/** Returns undefined for updates the gateway has no projection for. */
function toDriverEvent(update: SessionUpdate): DriverEvent | undefined {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textOf(update.content);
      return text === undefined ? undefined : { kind: 'message-chunk', text };
    }
    case 'agent_thought_chunk': {
      const text = textOf(update.content);
      return text === undefined ? undefined : { kind: 'thought-chunk', text };
    }
    case 'tool_call':
      return {
        kind: 'tool-call',
        toolCallId: String(update.toolCallId),
        title: update.title,
        status: update.status ?? 'pending',
        raw: update,
      };
    case 'tool_call_update':
      return {
        kind: 'tool-call-update',
        toolCallId: String(update.toolCallId),
        status: update.status ?? 'pending',
        raw: update,
      };
    case 'plan':
    case 'plan_update':
      return { kind: 'plan', raw: update };
    case 'usage_update':
      return { kind: 'usage', raw: update };
    default:
      // Unknown update types are dropped, not errors. The protocol grows by
      // adding them, and an exhaustive switch that throws would make every SDK
      // upgrade a breaking change.
      return undefined;
  }
}

function textOf(content: ContentBlock): string | undefined {
  return content.type === 'text' ? content.text : undefined;
}
