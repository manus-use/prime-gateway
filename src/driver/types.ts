import type { PermissionOption, TurnTerminal } from '../types.js';

/**
 * The seam between the gateway core and whatever actually runs the agent.
 *
 * Declared while ACP was the only implementation, which is why it exists at all:
 * if the core imported ACP types directly, every ACP concept would become
 * load-bearing gateway vocabulary and a second driver could not be added without
 * changing the core. That second driver (`./cli`) then arrived and needed no change
 * here -- which is the return on a file written before it was strictly necessary.
 *
 * The interface is deliberately *narrower* than ACP. Anything ACP-specific --
 * capability negotiation, `session/load` replay, terminal handles -- stays behind
 * it. What comes out is a stream of driver events the core already understands.
 */

// ---------------------------------------------------------------------------
// What a driver emits
// ---------------------------------------------------------------------------

/**
 * Normalized agent output.
 *
 * Note what is *not* here: no "final message", no "done" flag riding on a text
 * chunk. Completion is `turn-ended`, carrying an explicit terminal, because
 * inferring completion from output text is unreliable -- an agent can finish with
 * nothing to say, and can say plenty without finishing.
 */
export type DriverEvent =
  | { kind: 'message-chunk'; text: string }
  | { kind: 'thought-chunk'; text: string }
  | { kind: 'tool-call'; toolCallId: string; title: string; status: string; raw: unknown }
  | { kind: 'tool-call-update'; toolCallId: string; status: string; raw: unknown }
  | { kind: 'plan'; raw: unknown }
  | { kind: 'usage'; raw: unknown }
  /**
   * The agent is blocked, waiting for a decision. The driver has parked the
   * underlying RPC and will not proceed until `resolve` is called.
   */
  | {
      kind: 'permission-request';
      requestId: string;
      action: string;
      options: PermissionOption[];
      raw: unknown;
      /**
       * Must be called exactly once, with an `optionId` the agent offered.
       *
       * Every failure path in the core has to reach this. An exception that skips
       * it does not fail the turn -- it blocks the agent forever, which is far
       * worse and far harder to notice.
       */
      resolve: (outcome: PermissionOutcome) => void;
    }
  | { kind: 'turn-ended'; terminal: TurnTerminal; detail?: string }
  | { kind: 'error'; message: string; retryable: boolean; raw?: unknown };

export type PermissionOutcome =
  | { kind: 'selected'; optionId: string }
  /** The turn was cancelled while the request was outstanding. */
  | { kind: 'cancelled' };

// ---------------------------------------------------------------------------
// What a driver accepts
// ---------------------------------------------------------------------------

export interface PromptInput {
  text: string;
  /**
   * Local filesystem paths. Attachments are injected as paths, never inlined:
   * inlining a 10 MB upload into a prompt burns the context window on bytes the
   * agent can read on demand.
   */
  paths: string[];
}

export interface StartOptions {
  /** Absolute, realpath-resolved workspace root. */
  cwd: string;
  /**
   * The provider's own session id, if we have observed one before.
   *
   * Observed, never assumed. When present the driver may attempt resume; when
   * absent, or when the agent does not advertise the capability, it replays.
   */
  providerSessionId?: string | undefined;
  /**
   * Prior conversation to replay when resume is unavailable.
   *
   * Supplied by the core from the event log, because the log is the system of
   * record and the driver is not allowed its own idea of history.
   */
  replay?: readonly PromptInput[] | undefined;
}

/**
 * How a session was (re)established. Recorded, and surfaced to the user.
 *
 * `resume: native -> replay` is the **only** sanctioned automatic degrade in this
 * layer. Every other mismatch is an error rather than a quiet fallback, because a
 * silent degrade that loses state is indistinguishable from one that does not
 * until the user notices the agent forgot something.
 */
export type StartMode = 'fresh' | 'resumed' | 'replayed';

export interface StartResult {
  providerSessionId: string;
  mode: StartMode;
}

/**
 * A live agent runtime.
 *
 * One instance per session, owned by that session's actor. Nothing else calls
 * these methods -- serialization is the actor's job, and a second caller
 * interleaving prompts would corrupt turn accounting in ways the log cannot
 * reconstruct.
 */
export interface AgentRuntime {
  readonly providerSessionId: string;

  /**
   * Send a prompt and stream the results.
   *
   * The async iterator ends after `turn-ended` or a terminal `error`. Consuming
   * it fully is the caller's responsibility; abandoning it mid-turn leaks the
   * underlying RPC.
   */
  prompt(input: PromptInput): AsyncIterable<DriverEvent>;

  /** Best-effort cancel. Cancellation produces a terminal, not a deletion. */
  cancel(): Promise<void>;

  /**
   * Release the runtime.
   *
   * Must be idempotent and must not throw. The process can die without this ever
   * being called, so teardown is a courtesy and never a durability boundary --
   * nothing may treat a successful close as evidence that a turn completed.
   */
  close(): Promise<void>;
}

export interface Driver {
  readonly id: string;
  /**
   * Two-phase: `start` establishes the runtime and returns only once the session
   * is usable. A driver that returns a half-initialized runtime forces every
   * caller to guess whether it is ready.
   */
  start(opts: StartOptions): Promise<{ runtime: AgentRuntime; result: StartResult }>;
}
