import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/open.js';
import { appendEvent, lastSeq, readEvents } from '../db/events.js';
import {
  bumpGeneration,
  getSession,
  observeProviderSessionId,
  setExecution,
  setState,
} from '../db/sessions.js';
import { createTurn, endTurn, openTurns, setTurnState } from '../db/turns.js';
import {
  createApproval,
  getApproval,
  pendingForSession,
  resolveApproval,
  setApprovalCard,
} from '../db/approvals.js';
import { advanceCursor, resolveBinding, setActiveCard } from '../db/bindings.js';
import { CardWriter } from '../channel/card-writer.js';
import type { Channel, SendTarget } from '../channel/types.js';
import type {
  AgentRuntime,
  Driver,
  DriverEvent,
  PermissionOutcome,
  PromptInput,
} from '../driver/types.js';
import type {
  BindingKey,
  Event,
  NewEvent,
  Principal,
  RuntimePresence,
  SessionRow,
  TurnTerminal,
} from '../types.js';
import { BOOT_ID, approvalNonce, newApprovalId, newTurnId, sendUuid, turnIdempotencyKey } from './ids.js';
import { projectSessionStatus, type StatusView } from './status.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

/**
 * The single writer for one session.
 *
 * Everything that mutates a session goes through one of these. That is what makes
 * `seq` allocation correct, serializes input arriving from several places at once,
 * and removes an entire class of interleaving bug rather than defending against it
 * case by case.
 *
 * Two things are deliberately **not** serialized, and the distinction is
 * load-bearing:
 *
 * - `submit` goes through the mailbox. Prompts must run in order.
 * - `cancel`, `resolveFromCard`, `status` and `close` **bypass** it. Each one
 *   exists to act on work that is currently in flight. A `/stop` queued behind the
 *   turn it cancels never runs; an approval queued behind the turn it would unblock
 *   deadlocks the session against itself.
 *
 * The bypassing methods are therefore written to be safe against concurrent turn
 * execution, which mostly means: re-read state after every `await`, and check the
 * generation before acting on anything decided before one.
 */

/** Prompts replayed when the agent cannot resume natively. See `#replayInputs`. */
export const REPLAY_MAX_TURNS = 50;

/** Queued prompts per session before submission is refused outright. */
export const MAX_MAILBOX_DEPTH = 32;

/**
 * Thrown when the mailbox is full.
 *
 * A distinct type because the caller must *tell the user*. A refusal that is
 * caught and logged is worse than no cap at all: the message is gone and the only
 * record is in a file nobody is reading.
 */
export class MailboxFull extends Error {
  constructor(
    readonly sessionId: string,
    readonly depth: number,
  ) {
    super(`session ${sessionId} has ${depth} prompts queued; refusing more`);
    this.name = 'MailboxFull';
  }
}

/** Thrown when a session may not be started automatically. */
export class SessionHeld extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} is quarantined and will not be resumed automatically`);
    this.name = 'SessionHeld';
  }
}

export interface SubmitRequest {
  /** The inbound message that caused this turn. Keys idempotency. */
  messageId: string;
  appId: string;
  input: PromptInput;
}

export interface CardResolution {
  approvalId: string;
  optionId: string;
  /** From `action.value`. Untrusted; proves only which card this was rendered on. */
  nonce: string;
  /** Resolved from `operator.openId`, never from the card payload. */
  principal: Principal;
  via: string;
}

export interface ApprovalReport {
  kind: 'resolved' | 'already' | 'stale' | 'unknown' | 'bad_option';
  /** One line, safe to post back to the chat. */
  message: string;
  /**
   * Whether a blocked agent was actually released.
   *
   * False after a restart: the answer is recorded, but the RPC that was waiting
   * for it died with the process that owned it. Saying "done" in that case is a
   * lie the user will discover when nothing happens.
   */
  unblocked: boolean;
}

export interface SessionActorDeps {
  db: Db;
  sessionId: string;
  driver: Driver;
  channel: Channel;
  /** Where this session's card and approvals are posted. */
  key: BindingKey;
  target: SendTarget;
  /** Absolute, realpath-resolved workspace root. */
  cwd: string;
  clock?: Clock;
  /** Metadata-only progress hook. Never given agent text or user content. */
  note?: (line: string) => void;
}

interface PendingPermission {
  approvalId: string;
  turnId: string;
  generation: number;
  settle: (outcome: PermissionOutcome) => void;
  settled: boolean;
}

export class SessionActor {
  readonly sessionId: string;
  readonly #db: Db;
  readonly #driver: Driver;
  readonly #channel: Channel;
  readonly #key: BindingKey;
  readonly #cwd: string;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  readonly #cardWriter: CardWriter;

  #tail: Promise<void> = Promise.resolve();
  #depth = 0;
  #runtime: AgentRuntime | undefined;
  /** Keyed by approvalId. The gateway's half of a blocked agent RPC. */
  readonly #pending = new Map<string, PendingPermission>();
  #closed = false;

  constructor(deps: SessionActorDeps) {
    this.sessionId = deps.sessionId;
    this.#db = deps.db;
    this.#driver = deps.driver;
    this.#channel = deps.channel;
    this.#key = deps.key;
    this.#cwd = deps.cwd;
    this.#clock = deps.clock ?? systemClock;
    this.#note = deps.note ?? (() => undefined);

    const db = this.#db;
    const sessionId = this.sessionId;
    const key = this.#key;
    const clock = this.#clock;

    this.#cardWriter = new CardWriter({
      channel: deps.channel,
      target: deps.target,
      readEvents: (after, through) => readEvents(db, sessionId, after, through),
      onRendered: (through) => advanceCursor(db, key, sessionId, through),
      onCardChanged: (messageId) =>
        setActiveCard(db, key, sessionId, {
          cardId: null,
          messageId,
          createdAt: messageId === null ? null : clock.now(),
        }),
      sendUuid: (seq) => sendUuid(key.appId, sessionId, seq),
      clock,
    });

    // Adopt the persisted render cursor, so a restart re-renders from where the
    // last card got to rather than from the top of the log.
    const binding = resolveBinding(db, key);
    if (binding !== undefined) this.#cardWriter.resumeFrom(binding.cursorSeq);
  }

  // -------------------------------------------------------------------------
  // Serialized: prompts
  // -------------------------------------------------------------------------

  /**
   * Queue a prompt. Resolves with the turn's terminal.
   *
   * Rejects only for refusals the user has to be told about -- a full mailbox, a
   * quarantined session. Everything else that goes wrong becomes a terminal, and
   * `ambiguous` is a terminal too.
   */
  submit(req: SubmitRequest): Promise<TurnTerminal> {
    return this.#enqueue(() => this.#runTurn(req));
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`session ${this.sessionId} is closed`));
    if (this.#depth >= MAX_MAILBOX_DEPTH) {
      return Promise.reject(new MailboxFull(this.sessionId, this.#depth));
    }
    this.#depth += 1;
    const result = this.#tail.then(fn);
    // A rejecting task must not poison the mailbox: the next prompt still runs.
    // A dead mailbox reproduces exactly the stuck-session failure the cap exists
    // to prevent, one level down.
    this.#tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#depth -= 1;
      });
    return result;
  }

  async #runTurn(req: SubmitRequest): Promise<TurnTerminal> {
    const session = this.#requireSession();
    const idempotencyKey = turnIdempotencyKey(req.appId, req.messageId);

    const { turn, created } = createTurn(
      this.#db,
      {
        sessionId: this.sessionId,
        turnId: newTurnId(),
        generation: session.generation,
        idempotencyKey,
      },
      this.#clock.now(),
    );

    // A redelivery that got past `seen_messages` lands here. The turn already
    // exists, so re-prompting would run the same instruction twice -- which for an
    // agent with write access is not a cosmetic duplicate.
    if (!created) {
      this.#note(`duplicate submit for turn ${turn.turnId}`);
      return turn.terminal ?? 'ambiguous';
    }

    const turnId = turn.turnId;
    const generation = turn.generation;
    this.#append({
      type: 'turn_submitted',
      actor: 'user',
      turnId,
      generation,
      payload: { text: req.input.text, paths: req.input.paths, messageId: req.messageId },
    });

    let promptSent = false;
    let sawEvent = false;

    try {
      setTurnState(this.#db, this.sessionId, turnId, 'delivering');
      // The current turn is excluded from its own replay: it is appended to the log
      // before the runtime starts, and it is about to be sent as the prompt.
      const runtime = await this.#ensureRuntime(turnId);

      // Re-read after the await. `close` and `cancel` bypass the mailbox, so the
      // generation can have moved while the runtime was starting. Prompting a
      // runtime that a newer generation owns is how a retired session comes back
      // to life and writes to a workspace it no longer holds.
      const fresh = this.#requireSession();
      if (fresh.generation !== generation) {
        endTurn(this.#db, this.sessionId, turnId, 'cancelled', this.#clock.now());
        this.#append({
          type: 'turn_ended',
          actor: 'gateway',
          turnId,
          generation,
          payload: { terminal: 'cancelled', detail: 'superseded before delivery' },
        });
        return 'cancelled';
      }

      setTurnState(this.#db, this.sessionId, turnId, 'running');
      promptSent = true;

      let terminal: TurnTerminal | undefined;
      for await (const event of runtime.prompt(req.input)) {
        sawEvent = true;
        const seen = await this.#onDriverEvent(event, turnId, generation);
        if (seen !== undefined) terminal = seen;
      }

      // A stream that ends without a terminal is not a completion. The driver is
      // contracted to emit one, so its absence means the iterator was torn down
      // under us and we do not know whether the work happened.
      const outcome = terminal ?? 'ambiguous';
      await this.#finishTurn(turnId, generation, outcome, terminal === undefined);
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#append({
        type: 'agent_error',
        actor: 'gateway',
        turnId,
        generation,
        payload: { message, retryable: false },
      });

      // The distinction that decides whether this session is usable afterwards:
      // a failure before the prompt reached the runtime cannot have been acted on,
      // so it is a plain failure. A failure after it, with nothing coming back,
      // means we cannot tell whether the agent consumed the instruction -- and
      // guessing either way is worse than admitting it.
      const outcome: TurnTerminal = promptSent && !sawEvent ? 'ambiguous' : 'failed';
      await this.#finishTurn(turnId, generation, outcome, outcome === 'ambiguous');

      if (err instanceof SessionHeld || err instanceof MailboxFull) throw err;
      return outcome;
    }
  }

  /**
   * Record a turn terminal and clean up after it.
   *
   * `quarantine` is passed rather than derived from `terminal` so the caller keeps
   * the decision: not every ambiguous terminal has the same cause, and holding a
   * session is a heavy enough consequence to be explicit at the call site.
   */
  async #finishTurn(
    turnId: string,
    generation: number,
    terminal: TurnTerminal,
    quarantine: boolean,
  ): Promise<void> {
    // Anything still blocked belongs to a turn that is over. Left unresolved, the
    // agent waits forever on a decision nobody will now be asked for.
    this.#releasePending(turnId, 'turn ended');

    const now = this.#clock.now();
    endTurn(this.#db, this.sessionId, turnId, terminal, now, `${BOOT_ID}:${generation}`);
    this.#append({
      type: 'turn_ended',
      actor: 'gateway',
      turnId,
      generation,
      payload: { terminal },
    });

    if (quarantine) {
      setState(this.#db, this.sessionId, 'quarantined', now);
      this.#append({
        type: 'session_state_changed',
        actor: 'gateway',
        generation,
        payload: { state: 'quarantined', reason: 'delivery to the agent was ambiguous' },
      });
      // A quarantined session must not keep a runtime it may not use: the whole
      // point of the state is that resuming needs a human decision.
      await this.#teardownRuntime();
      return;
    }

    if (openTurns(this.#db, this.sessionId).length === 0) {
      // Only from a state idle can legitimately replace. A turn that failed
      // *because* the runtime would not start has already set `cold`, and
      // overwriting that with `idle` would leave the database claiming an attached
      // session with nothing attached -- which is the next boot's problem, since
      // that is the state reconciliation reads.
      const state = this.#requireSession().state;
      if (state === 'live' || state === 'initializing') {
        setState(this.#db, this.sessionId, 'idle', now);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Driver events
  // -------------------------------------------------------------------------

  /** Returns a terminal when the event was one. */
  async #onDriverEvent(
    event: DriverEvent,
    turnId: string,
    generation: number,
  ): Promise<TurnTerminal | undefined> {
    switch (event.kind) {
      case 'message-chunk':
        this.#append({
          type: 'agent_message_chunk',
          actor: 'agent',
          turnId,
          generation,
          payload: { text: event.text },
        });
        return undefined;

      case 'thought-chunk':
        this.#append({
          type: 'agent_thought_chunk',
          actor: 'agent',
          turnId,
          generation,
          payload: { text: event.text },
        });
        return undefined;

      case 'tool-call':
        this.#append({
          type: 'tool_call',
          actor: 'agent',
          turnId,
          generation,
          payload: {
            toolCallId: event.toolCallId,
            title: event.title,
            status: event.status,
            raw: event.raw,
          },
        });
        return undefined;

      case 'tool-call-update':
        this.#append({
          type: 'tool_call_update',
          actor: 'agent',
          turnId,
          generation,
          payload: { toolCallId: event.toolCallId, status: event.status, raw: event.raw },
        });
        return undefined;

      case 'plan':
        this.#append({ type: 'plan', actor: 'agent', turnId, generation, payload: event.raw });
        return undefined;

      case 'usage':
        this.#append({ type: 'usage', actor: 'agent', turnId, generation, payload: event.raw });
        return undefined;

      case 'error':
        this.#append({
          type: 'agent_error',
          actor: 'agent',
          turnId,
          generation,
          payload: { message: event.message, retryable: event.retryable },
        });
        return undefined;

      case 'permission-request':
        await this.#onPermissionRequest(event, turnId, generation);
        return undefined;

      case 'turn-ended':
        return event.terminal;
    }
  }

  /**
   * Ask the human, and park the agent until they answer.
   *
   * The approval is written to the log *before* the card is sent. That ordering is
   * what makes a crash between the two recoverable: an approval with no card is a
   * question we can re-ask, while a card with no approval is a button that resolves
   * nothing and cannot be told apart from a forged one.
   */
  async #onPermissionRequest(
    event: Extract<DriverEvent, { kind: 'permission-request' }>,
    turnId: string,
    generation: number,
  ): Promise<void> {
    const approvalId = newApprovalId();
    const now = this.#clock.now();

    createApproval(
      this.#db,
      {
        approvalId,
        sessionId: this.sessionId,
        turnId,
        generation,
        action: event.action,
        payload: event.raw,
        options: event.options,
      },
      now,
    );

    const pending: PendingPermission = {
      approvalId,
      turnId,
      generation,
      settle: event.resolve,
      settled: false,
    };
    this.#pending.set(approvalId, pending);

    this.#append({
      type: 'approval_requested',
      actor: 'agent',
      turnId,
      generation,
      payload: { approvalId, action: event.action, options: event.options },
    });
    setTurnState(this.#db, this.sessionId, turnId, 'awaiting_approval');

    try {
      const sent = await this.#channel.sendApprovalCard(
        { chatId: this.#key.conversationId, threadId: this.#key.threadId },
        {
          approvalId,
          action: event.action,
          options: event.options,
          nonce: approvalNonce(this.sessionId, approvalId, generation),
        },
        sendUuid(this.#key.appId, this.sessionId, now),
      );
      setApprovalCard(this.#db, approvalId, sent.messageId);
    } catch (err) {
      // We could not ask. Releasing the agent as cancelled is the honest outcome:
      // it will report that it was not permitted to proceed, which is true.
      // Leaving the request pending would hang the turn on a question that was
      // never visible to anyone.
      const message = err instanceof Error ? err.message : String(err);
      this.#append({
        type: 'agent_error',
        actor: 'gateway',
        turnId,
        generation,
        payload: { message: `could not post approval card: ${message}`, retryable: true },
      });
      this.#settle(pending, { kind: 'cancelled' });
    }
  }

  // -------------------------------------------------------------------------
  // Bypassing the mailbox: approvals, cancel, status, close
  // -------------------------------------------------------------------------

  /**
   * Apply a card-button click.
   *
   * Bypasses the mailbox on purpose: the turn this unblocks is the one holding the
   * mailbox. Queueing here is a deadlock with a ten-minute park timer on top of it.
   *
   * Three checks, in order, none redundant:
   *
   * 1. The nonce must match. It binds the boot id and the generation, so a button
   *    rendered before a restart fails here even when session state is otherwise
   *    unchanged.
   * 2. `resolveApproval` re-checks the generation against the log under a
   *    transaction. The nonce proves the card was not altered; only the log can say
   *    whether what it points at is still current.
   * 3. The option must be one the agent offered. Buttons are generated from its
   *    option set, but `action.value` is client-supplied and not verified by Lark.
   */
  resolveFromCard(res: CardResolution): ApprovalReport {
    const row = getApproval(this.#db, res.approvalId);
    if (row === undefined || row.sessionId !== this.sessionId) {
      // The session check matters: `approvalId` arrives from the client, so
      // without it a button from one chat could address another chat's approval.
      return { kind: 'unknown', message: 'That request no longer exists.', unblocked: false };
    }

    const expected = approvalNonce(this.sessionId, row.approvalId, row.generation);
    if (!constantTimeEqual(expected, res.nonce)) {
      return {
        kind: 'stale',
        message:
          'That button belongs to an earlier run of this session. Ask again and I will re-post it.',
        unblocked: false,
      };
    }

    const outcome = resolveApproval(
      this.#db,
      {
        approvalId: res.approvalId,
        optionId: res.optionId,
        // The **session's** current generation, not the approval's. The approval's
        // never changes, so passing it would make the CAS compare the row against
        // itself and always succeed. What has to be established is that the
        // session has not moved on since the card was rendered -- which is a fact
        // about the session, and one that `resolveApproval` re-checks inside its
        // own transaction.
        expectedGeneration: this.#requireSession().generation,
        resolvedBy: res.principal.unionId ?? res.principal.openId,
        resolvedVia: res.via,
      },
      this.#clock.now(),
    );

    switch (outcome.kind) {
      case 'unknown':
        return { kind: 'unknown', message: 'That request no longer exists.', unblocked: false };
      case 'already':
        return {
          kind: 'already',
          message: `Already answered (${outcome.approval.optionId ?? 'unknown'}). The first answer stands.`,
          unblocked: false,
        };
      case 'stale':
        return {
          kind: 'stale',
          message:
            'That button belongs to an earlier run of this session. Ask again and I will re-post it.',
          unblocked: false,
        };
      case 'bad_option':
        return {
          kind: 'bad_option',
          message: 'That is not one of the offered options.',
          unblocked: false,
        };
      case 'resolved':
        break;
    }

    this.#append({
      type: 'approval_resolved',
      actor: 'user',
      turnId: outcome.approval.turnId,
      generation: outcome.approval.generation,
      payload: {
        approvalId: res.approvalId,
        optionId: res.optionId,
        // Audit-relevant: who, and through which channel. Both, always.
        resolvedBy: outcome.approval.resolvedBy,
        resolvedVia: outcome.approval.resolvedVia,
      },
    });

    const waiting = this.#pending.get(res.approvalId);
    if (waiting === undefined) {
      // Recorded but nothing to release. Happens after a restart: the answer is
      // durable, the RPC that wanted it is not.
      return {
        kind: 'resolved',
        message: 'Recorded. The agent that asked is no longer running, so start a new turn.',
        unblocked: false,
      };
    }

    this.#settle(waiting, { kind: 'selected', optionId: res.optionId });
    setTurnState(this.#db, this.sessionId, waiting.turnId, 'running');
    return { kind: 'resolved', message: `Sent: ${res.optionId}.`, unblocked: true };
  }

  /**
   * Cancel the current turn.
   *
   * Cancellation is a terminal, not a deletion: the log keeps everything that
   * happened, and the turn ends `cancelled`. Pending approvals are released first,
   * because an agent blocked on a permission RPC cannot observe a cancel.
   */
  async cancel(): Promise<void> {
    this.#releaseAllPending('cancelled');
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    try {
      await runtime.cancel();
    } catch (err) {
      this.#note(`cancel failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  status(): StatusView {
    const session = this.#requireSession();
    return projectSessionStatus({
      session,
      openTurns: openTurns(this.#db, this.sessionId),
      pending: pendingForSession(this.#db, this.sessionId),
      presence: this.presence,
      now: this.#clock.now(),
    });
  }

  get presence(): RuntimePresence {
    if (this.#runtime !== undefined) return 'live';
    return this.#requireSession().state === 'cold' ? 'cold' : 'absent';
  }

  /**
   * Release the session.
   *
   * Idempotent, and never throws. The process can die without this running at all,
   * so nothing here may be treated as a durability boundary -- it is a courtesy
   * that makes the visible state honest, not part of the recovery contract.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    this.#releaseAllPending('gateway shutting down');
    // Card first. Its close awaits the final write and freezes the typing
    // indicator; doing it after the runtime teardown would leave a card claiming
    // work is in progress for however long shutdown takes.
    await this.#cardWriter.close().catch(() => undefined);
    await this.#teardownRuntime();

    // No broker sidecar in this slice: the runtime dies with the gateway. Saying
    // 'live' in the database after that is a lie the next boot would act on.
    const session = getSession(this.#db, this.sessionId);
    if (session !== undefined && session.state !== 'quarantined' && session.state !== 'terminated') {
      setState(this.#db, this.sessionId, 'cold', this.#clock.now());
    }
  }

  // -------------------------------------------------------------------------
  // Runtime lifecycle
  // -------------------------------------------------------------------------

  /**
   * The attached runtime, starting one if there is none.
   *
   * `excludeTurnId` is the turn being delivered right now. Its `turn_submitted` is
   * already in the log, so without excluding it the prompt would be replayed as
   * history and *then* sent -- running one instruction twice against a workspace
   * the agent can write to.
   */
  async #ensureRuntime(excludeTurnId?: string): Promise<AgentRuntime> {
    const existing = this.#runtime;
    if (existing !== undefined) return existing;

    const session = this.#requireSession();
    // Quarantine outranks liveness. Auto-resuming here is precisely what the state
    // exists to prevent, and it is reachable from the ordinary "user sent a
    // message" path -- so the refusal has to live at the bottom, not in the router.
    if (session.state === 'quarantined') throw new SessionHeld(this.sessionId);

    setState(this.#db, this.sessionId, 'initializing', this.#clock.now());

    const replay = this.#replayInputs(excludeTurnId);
    try {
      const { runtime, result } = await this.#driver.start({
        cwd: this.#cwd,
        providerSessionId: session.providerSessionId ?? undefined,
        replay: replay.length === 0 ? undefined : replay,
      });
      this.#runtime = runtime;

      // Observed, never assumed. Agents mint their own id and can rotate it, so
      // what gets stored is what the agent just reported -- not what we sent.
      observeProviderSessionId(this.#db, this.sessionId, result.providerSessionId);
      setExecution(this.#db, this.sessionId, `${BOOT_ID}:${session.generation}`, this.#driver.id);
      setState(this.#db, this.sessionId, 'live', this.#clock.now());
      this.#append({
        type: 'session_state_changed',
        actor: 'gateway',
        generation: session.generation,
        payload: { state: 'live', mode: result.mode, driver: this.#driver.id },
      });
      this.#note(`runtime ${result.mode} (${this.#driver.id})`);
      return runtime;
    } catch (err) {
      // Failing to *start* is unambiguous: nothing was delivered, so this is cold
      // rather than quarantined. Conflating the two turns a bad binary path into a
      // session that needs manual rescue.
      setState(this.#db, this.sessionId, 'cold', this.#clock.now());
      throw err;
    }
  }

  /**
   * Tear down the runtime, bumping the generation first.
   *
   * The bump happens *before* teardown, deliberately. It is a fencing token: any
   * callback or timer still holding a reference revalidates its generation after
   * its next await, finds it stale, and declines to act. Bumping afterwards leaves
   * a window in which stale work still looks current.
   */
  async #teardownRuntime(): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    this.#runtime = undefined;

    const generation = bumpGeneration(this.#db, this.sessionId);
    this.#append({
      type: 'generation_bumped',
      actor: 'gateway',
      generation,
      payload: { generation, reason: 'runtime teardown' },
    });

    try {
      await runtime.close();
    } catch (err) {
      this.#note(`runtime close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Prior prompts, for a driver that cannot resume natively.
   *
   * Read from the log, because the log is the system of record and the driver is
   * not allowed its own idea of history.
   *
   * Capped, and the cap is lossy. An unbounded replay of a long session either
   * exceeds the agent's context or costs more than the turn it is preparing for.
   * The cap is reported through `note` rather than applied silently: truncated
   * history that nobody was told about looks exactly like an agent that forgot.
   */
  #replayInputs(excludeTurnId?: string): PromptInput[] {
    const events = readEvents(this.#db, this.sessionId, 0, lastSeq(this.#db, this.sessionId));
    const inputs: PromptInput[] = [];
    for (const event of events) {
      if (event.type !== 'turn_submitted') continue;
      if (excludeTurnId !== undefined && event.turnId === excludeTurnId) continue;
      const payload = event.payload as { text?: unknown; paths?: unknown } | null;
      const text = typeof payload?.text === 'string' ? payload.text : '';
      const paths = Array.isArray(payload?.paths)
        ? payload.paths.filter((p): p is string => typeof p === 'string')
        : [];
      inputs.push({ text, paths });
    }
    if (inputs.length > REPLAY_MAX_TURNS) {
      const dropped = inputs.length - REPLAY_MAX_TURNS;
      this.#note(`replay truncated: dropped the oldest ${dropped} of ${inputs.length} prompts`);
      return inputs.slice(-REPLAY_MAX_TURNS);
    }
    return inputs;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #append(event: NewEvent): Event {
    const appended = appendEvent(this.#db, this.sessionId, event, this.#clock.now());
    // Every append nudges the card. Coalescing makes that cheap, and it means the
    // card appears as soon as there is anything to say rather than after the first
    // token -- which is the difference between a bot that looks slow and one that
    // looks broken.
    this.#cardWriter.want(appended.seq);
    return appended;
  }

  /** Release one parked request. Idempotent per request. */
  #settle(pending: PendingPermission, outcome: PermissionOutcome): void {
    if (pending.settled) return;
    pending.settled = true;
    this.#pending.delete(pending.approvalId);
    try {
      pending.settle(outcome);
    } catch (err) {
      this.#note(`settling ${pending.approvalId} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #releasePending(turnId: string, reason: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.turnId !== turnId) continue;
      this.#note(`releasing ${pending.approvalId} as cancelled: ${reason}`);
      this.#settle(pending, { kind: 'cancelled' });
    }
  }

  #releaseAllPending(reason: string): void {
    for (const pending of [...this.#pending.values()]) {
      this.#note(`releasing ${pending.approvalId} as cancelled: ${reason}`);
      this.#settle(pending, { kind: 'cancelled' });
    }
  }

  #requireSession(): SessionRow {
    const session = getSession(this.#db, this.sessionId);
    if (session === undefined) throw new Error(`unknown session ${this.sessionId}`);
    return session;
  }

  /** For tests: force a card write without waiting out the coalesce window. */
  async flushCard(): Promise<void> {
    await this.#cardWriter.flushNow();
  }
}

/**
 * Compare two hex strings without leaking where they diverge.
 *
 * The length check is outside the constant-time compare because `timingSafeEqual`
 * throws on a length mismatch, and a length difference is not secret -- the nonce
 * length is fixed and public.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
