import type { ApprovalRow, RuntimePresence, SessionRow, TurnRow } from '../types.js';

/**
 * The one place session status is computed.
 *
 * Status is **derived, never assigned**. This is not stylistic. Status assigned
 * from several code paths is how a running session comes to report idle, and that
 * single wrong bit then produces duplicate approval requests, spurious restarts,
 * and a live session treated as a reclaimable idle worker. Each of those looks
 * like a separate bug. They are all this one.
 *
 * So: one pure function, no I/O, no clock of its own. Everything it needs is a
 * parameter, which is also what makes every interesting state reachable in a test
 * without a database or a running agent.
 */

/** What the user is shown. Deliberately coarser than `SessionState`. */
export type StatusLabel =
  | 'starting'
  | 'working'
  | 'waiting-for-you'
  | 'idle'
  | 'suspended'
  | 'quarantined'
  | 'ended'
  | 'unknown';

export interface StatusView {
  label: StatusLabel;
  /** One line, safe to render. Never contains agent-authored text. */
  detail: string;
  /** True when a mutating command must refuse rather than bypass. */
  busy: boolean;
  /** Open turns, for `/status` detail. */
  openTurns: number;
  pendingApprovals: number;
  generation: number;
}

export interface StatusInputs {
  session: SessionRow;
  openTurns: readonly TurnRow[];
  pending: readonly ApprovalRow[];
  /**
   * Whether a runtime exists, as three states rather than two. Collapsing `cold`
   * and `absent` is how session-exists-but-process-dead falls into the create
   * branch and produces two sessions on one thread.
   */
  presence: RuntimePresence;
  /** Locally observed time. Never the agent's clock -- see below. */
  now: number;
}

/**
 * Leases and staleness are timed off `now`, which the caller must source from the
 * local clock.
 *
 * Never off a timestamp the agent supplied. An agent with a skewed or malicious
 * clock could otherwise hold a lease indefinitely, or expire one instantly, and
 * the gateway would have handed it the means to do so.
 */
export function projectSessionStatus(inputs: StatusInputs): StatusView {
  const { session, openTurns, pending, presence } = inputs;

  const base = {
    openTurns: openTurns.length,
    pendingApprovals: pending.length,
    generation: session.generation,
  };

  // Order matters below. The first matching clause wins, and the sequence encodes
  // which fact dominates when several are true at once.

  // Terminal states dominate everything: an archived session with a turn row
  // still marked open is a crash artifact, not work in progress.
  if (session.state === 'terminated' || session.state === 'archived') {
    return { ...base, label: 'ended', detail: 'Session ended.', busy: false };
  }

  // Quarantine outranks liveness. A quarantined session may have a healthy
  // runtime and still must not be auto-resumed -- that is the entire point of
  // keeping it distinct from `cold`.
  if (session.state === 'quarantined') {
    return {
      ...base,
      label: 'quarantined',
      detail:
        'Delivery to the agent was ambiguous, so this session is held. ' +
        'Inspect the log, then /attach or /new.',
      busy: false,
    };
  }

  // A pending approval outranks "working": the agent is blocked on a human, and
  // reporting that as ordinary progress is how approvals get ignored for hours.
  if (pending.length > 0) {
    const parked = pending.some((a) => a.state === 'parked');
    return {
      ...base,
      label: 'waiting-for-you',
      detail: parked
        ? `Waiting on you (${pending.length} request(s), oldest has been parked). Still answerable.`
        : `Waiting on you: ${pending.length} request(s) to approve.`,
      // Busy: a mutating command mid-approval would resolve against a request the
      // user is still looking at.
      busy: true,
    };
  }

  // An open turn is what distinguishes a start that is actually happening from a
  // session that was created and never used -- `initializing` is also the state a
  // session is born in. Without the qualifier every brand-new session reports
  // busy, which makes it un-retirable by the registry and refuses the first
  // mutating command anyone types.
  if (session.state === 'initializing' && openTurns.length > 0) {
    return { ...base, label: 'starting', detail: 'Starting the agent.', busy: true };
  }

  if (openTurns.length > 0) {
    // `presence: 'absent'` with an open turn is precisely the crash case. It is
    // reported as unknown rather than working, because claiming progress that
    // nothing is making is worse than admitting we lost track.
    if (presence === 'absent') {
      return {
        ...base,
        label: 'unknown',
        detail: `${openTurns.length} turn(s) were in flight when the runtime disappeared.`,
        busy: false,
      };
    }
    return {
      ...base,
      label: 'working',
      detail: `Working on ${openTurns.length} turn(s).`,
      busy: true,
    };
  }

  if (presence === 'cold' || session.state === 'cold') {
    return {
      ...base,
      label: 'suspended',
      detail: 'Suspended. The next message resumes it; history is replayed from the log.',
      busy: false,
    };
  }

  if (presence === 'absent') {
    return {
      ...base,
      label: 'suspended',
      detail: 'No runtime. The next message starts one and replays history from the log.',
      busy: false,
    };
  }

  return { ...base, label: 'idle', detail: 'Idle and attached. Send a message.', busy: false };
}

/**
 * Whether a mutating command may proceed.
 *
 * Mutating verbs **refuse mid-turn rather than bypass**. Bypassing means racing
 * the actor for the same session, and the loser's write is the one the user
 * asked for.
 */
export function canMutate(view: StatusView): { ok: true } | { ok: false; reason: string } {
  if (!view.busy) return { ok: true };
  if (view.label === 'waiting-for-you') {
    return { ok: false, reason: 'There is a pending approval. Answer or /stop it first.' };
  }
  return { ok: false, reason: `Busy (${view.label}). Wait for it to finish, or /stop.` };
}
