import { describe, expect, it } from 'vitest';
import { CARD_TEXT_BUDGET, renderCard } from '../src/channel/render.js';
import type { Event, EventType } from '../src/types.js';

let seq = 0;
function ev(type: EventType, payload: unknown): Event {
  seq += 1;
  return {
    sessionId: 's_test',
    seq,
    ts: 1_760_000_000_000 + seq,
    generation: 0,
    brokerSeq: null,
    turnId: 't_1',
    type,
    actor: 'agent',
    payload,
  };
}

describe('renderCard', () => {
  it('says something rather than nothing while a turn is open', () => {
    // An empty card is indistinguishable from a broken one.
    const view = renderCard([]);
    expect(view.text).toBe('_Working…_');
    expect(view.finished).toBe(false);
  });

  it('treats empty output as a legitimate terminal', () => {
    const view = renderCard([ev('turn_ended', { terminal: 'completed' })]);
    expect(view.text).toBe('_Finished with no output._');
    expect(view.finished).toBe(true);
  });

  it('concatenates message chunks in seq order', () => {
    const view = renderCard([
      ev('agent_message_chunk', { text: 'Hello' }),
      ev('agent_message_chunk', { text: ', world' }),
    ]);
    expect(view.text).toContain('Hello, world');
  });

  it('escapes agent text', () => {
    const view = renderCard([ev('agent_message_chunk', { text: '<at id=all></at>' })]);
    // Every `<` is preceded by a backslash; the substring `<at` still appears in
    // the escaped form, so the assertion has to be about the escape.
    expect(view.text).not.toMatch(/(^|[^\\])</);
  });

  it('keeps thoughts, plans and usage out of the card body', () => {
    const view = renderCard([
      ev('agent_thought_chunk', { text: 'thinking hard' }),
      ev('plan', { entries: [] }),
      ev('usage', { tokens: 10 }),
    ]);
    expect(view.text).not.toContain('thinking hard');
  });

  it('gives a tool-call update its own line even with no preceding tool_call', () => {
    // The pair can straddle a restart; dropping the orphan would hide work that
    // actually happened.
    const view = renderCard([ev('tool_call_update', { toolCallId: 'tc_9', status: 'completed' })]);
    // Escaped, because a tool call id is agent-supplied text like any other.
    expect(view.text).toContain('tc\\_9');
  });

  it('collapses a tool call and its updates into one line', () => {
    const view = renderCard([
      ev('tool_call', { toolCallId: 'tc_1', title: 'Read file', status: 'in_progress' }),
      ev('tool_call_update', { toolCallId: 'tc_1', status: 'completed' }),
    ]);
    const lines = view.text.split('\n').filter((l) => l.includes('Read file'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('✅');
  });

  it('reports a pending approval instead of claiming progress', () => {
    // A card reading "Working…" while the agent is blocked on a button is how
    // approvals sit unanswered for hours.
    const view = renderCard([ev('approval_requested', { approvalId: 'a_1', action: 'rm -rf' })]);
    expect(view.text).toContain('Waiting for your approval');
  });

  it('drops the approval notice once it is answered', () => {
    const view = renderCard([
      ev('approval_requested', { approvalId: 'a_1', action: 'rm -rf' }),
      ev('approval_resolved', { approvalId: 'a_1', optionId: 'allow' }),
    ]);
    expect(view.text).not.toContain('Waiting for your approval');
  });

  it('drops the approval notice after a terminal, even if never answered', () => {
    // After the turn ends the button does nothing; pointing at it sends the user
    // hunting for a control that is no longer live.
    const view = renderCard([
      ev('approval_requested', { approvalId: 'a_1', action: 'rm -rf' }),
      ev('turn_ended', { terminal: 'cancelled' }),
    ]);
    expect(view.text).not.toContain('Waiting for your approval');
    expect(view.text).toContain('cancelled');
  });

  it('names a non-completed terminal and stays quiet about a completed one', () => {
    expect(renderCard([ev('turn_ended', { terminal: 'ambiguous' })]).text).toContain('ambiguous');
    const done = renderCard([
      ev('agent_message_chunk', { text: 'done' }),
      ev('turn_ended', { terminal: 'completed' }),
    ]);
    expect(done.text).toBe('done');
  });

  it('surfaces the last error', () => {
    const view = renderCard([
      ev('agent_error', { message: 'first', retryable: true }),
      ev('agent_error', { message: 'second', retryable: false }),
    ]);
    expect(view.text).toContain('second');
    expect(view.text).not.toContain('first');
  });

  it('reports the highest seq it included', () => {
    const events = [ev('agent_message_chunk', { text: 'a' }), ev('agent_message_chunk', { text: 'b' })];
    expect(renderCard(events).throughSeq).toBe(events[1]?.seq);
  });

  it('is a pure function of its input', () => {
    const events = [
      ev('tool_call', { toolCallId: 'tc_1', title: 'Grep', status: 'in_progress' }),
      ev('agent_message_chunk', { text: 'hi' }),
    ];
    expect(renderCard(events)).toEqual(renderCard(events));
  });

  it('stays inside the card budget and says that it truncated', () => {
    const view = renderCard([ev('agent_message_chunk', { text: 'x'.repeat(CARD_TEXT_BUDGET * 2) })]);
    expect(view.text.length).toBeLessThanOrEqual(CARD_TEXT_BUDGET);
    expect(view.text).toContain('truncated');
  });
});
