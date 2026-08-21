import { describe, expect, it } from 'vitest';
import { canMutate, projectSessionStatus } from '../src/core/status.js';
import type {
  ApprovalRow,
  ApprovalState,
  RuntimePresence,
  SessionRow,
  SessionState,
  TurnRow,
  TurnState,
} from '../src/types.js';

const NOW = 1_760_000_000_000;

function session(state: SessionState, generation = 3): SessionRow {
  return {
    id: 's_1',
    agentId: 'acp',
    workspaceId: 'plain-dir:abc',
    ownerPrincipal: 'on_owner',
    state,
    title: null,
    generation,
    providerSessionId: null,
    executionHandle: null,
    executionBackend: null,
    lastSeq: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    coldAt: null,
  };
}

function turn(state: TurnState = 'running'): TurnRow {
  return {
    sessionId: 's_1',
    turnId: 't_1',
    generation: 3,
    idempotencyKey: 'k',
    state,
    terminal: null,
    fence: null,
    submittedAt: NOW,
    endedAt: null,
  };
}

function approval(state: ApprovalState = 'pending'): ApprovalRow {
  return {
    approvalId: 'a_1',
    sessionId: 's_1',
    turnId: 't_1',
    generation: 3,
    action: 'rm -rf /',
    payload: null,
    options: [{ optionId: 'allow', name: 'Allow' }],
    state,
    optionId: null,
    resolvedBy: null,
    resolvedVia: null,
    cardMessageId: null,
    createdAt: NOW,
    parksAt: NOW + 1000,
    resolvedAt: null,
  };
}

function project(
  state: SessionState,
  opts: {
    openTurns?: readonly TurnRow[];
    pending?: readonly ApprovalRow[];
    presence?: RuntimePresence;
  } = {},
) {
  return projectSessionStatus({
    session: session(state),
    openTurns: opts.openTurns ?? [],
    pending: opts.pending ?? [],
    presence: opts.presence ?? 'live',
    now: NOW,
  });
}

describe('projectSessionStatus', () => {
  it('lets a terminal state dominate a turn row left open by a crash', () => {
    const view = project('archived', { openTurns: [turn()] });
    expect(view.label).toBe('ended');
    expect(view.busy).toBe(false);
  });

  it('lets quarantine outrank liveness', () => {
    // The entire reason `quarantined` is distinct from `cold`: a quarantined
    // session may have a healthy runtime and still must not be auto-resumed.
    const view = project('quarantined', { openTurns: [turn()], presence: 'live' });
    expect(view.label).toBe('quarantined');
  });

  it('lets a pending approval outrank working', () => {
    const view = project('live', { openTurns: [turn()], pending: [approval()] });
    expect(view.label).toBe('waiting-for-you');
    expect(view.busy).toBe(true);
  });

  it('says a parked approval is still answerable', () => {
    // Parking is a visibility change, not a decision. Saying otherwise invites the
    // user to give up on multi-day work.
    const view = project('live', { pending: [approval('parked')] });
    expect(view.detail).toContain('parked');
    expect(view.detail).toContain('answerable');
  });

  it('reports unknown, not working, when the runtime vanished mid-turn', () => {
    // Claiming progress that nothing is making is worse than admitting we lost
    // track.
    const view = project('live', { openTurns: [turn()], presence: 'absent' });
    expect(view.label).toBe('unknown');
    expect(view.busy).toBe(false);
  });

  it('reports working with a live runtime and an open turn', () => {
    const view = project('live', { openTurns: [turn()] });
    expect(view.label).toBe('working');
    expect(view.busy).toBe(true);
  });

  it('reports starting while a runtime is coming up for a turn', () => {
    expect(project('initializing', { openTurns: [turn('delivering')] }).label).toBe('starting');
  });

  it('does not call a never-used session busy just because it is initializing', () => {
    // `initializing` is also the state a session is born in. Reporting busy there
    // makes it un-retirable and refuses the first mutating command anyone types.
    const view = project('initializing', { presence: 'absent' });
    expect(view.busy).toBe(false);
    expect(view.label).toBe('suspended');
  });

  it('distinguishes cold from absent in the detail text', () => {
    // Collapsing the two is how session-exists-but-process-dead falls into the
    // create branch and produces two sessions on one thread.
    expect(project('cold', { presence: 'cold' }).detail).toContain('resumes it');
    expect(project('idle', { presence: 'absent' }).detail).toContain('No runtime');
  });

  it('reports idle only when attached with nothing outstanding', () => {
    const view = project('idle', { presence: 'live' });
    expect(view.label).toBe('idle');
    expect(view.busy).toBe(false);
  });

  it('carries the generation through unchanged', () => {
    expect(project('idle').generation).toBe(3);
  });
});

describe('canMutate', () => {
  it('allows a mutating verb when nothing is in flight', () => {
    expect(canMutate(project('idle'))).toEqual({ ok: true });
  });

  it('names the approval specifically, because that is what the user must do', () => {
    const decision = canMutate(project('live', { pending: [approval()] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('pending approval');
  });

  it('refuses mid-turn rather than racing the actor', () => {
    const decision = canMutate(project('live', { openTurns: [turn()] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('working');
  });
});
