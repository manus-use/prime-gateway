import type { Event } from '../types.js';
import { forDisplay, truncate } from './escape.js';

/**
 * Project a slice of the event log into card text.
 *
 * Pure. No I/O, no clock, no channel calls. Given the same events it returns the
 * same string, which is what lets the card writer treat a render as replaceable
 * and retry it freely.
 *
 * It reads the log rather than accumulating state as events arrive, because an
 * accumulator has to be correct across restarts and reorderings and the log
 * already is.
 */

/**
 * Card content budget.
 *
 * cardkit caps an individual element at 30,000 characters, and the whole message
 * has a separate, larger ceiling (observed around 109 KB, reported as error
 * 230025). This budget is deliberately well under the element cap: the overflow
 * behaviour at the real ceiling has not been measured yet, and a card that fails
 * to render loses the entire answer rather than the tail of it.
 */
export const CARD_TEXT_BUDGET = 20_000;

export interface RenderedCard {
  text: string;
  /** Highest event seq included. Becomes `cursor_seq`. */
  throughSeq: number;
  /** True when a turn terminal was seen, so the card can be frozen. */
  finished: boolean;
  /**
   * Seq of the `turn_submitted` this render belongs to; 0 before the first one.
   *
   * The writer's card identity. A render whose turn differs from the card's turn
   * belongs on a new card, and that comparison has to be exact rather than
   * inferred from `finished`: coalescing can put one turn's terminal and the next
   * turn's answer in the same render.
   */
  turnStartSeq: number;
}

interface ToolLine {
  title: string;
  status: string;
}

/**
 * Build the card body from events up to and including `throughSeq`.
 *
 * `events` must be in seq order and must all belong to one session.
 *
 * The range given is usually the whole session, but what comes out is **one
 * turn**: everything resets at `turn_submitted`. A card is the reply to one
 * prompt, the same way a chat message is, so carrying the previous turn's state
 * forward would show the user answers, tool checklists and error footers that
 * belong to a question they already had answered -- a turn that streamed
 * perfectly still rendering "Error: ..." underneath it, naming a driver the
 * session no longer even uses.
 *
 * The earlier history is not lost by this: it is on the earlier cards, which are
 * still in the chat, and in the log, which is the system of record.
 */
export function renderCard(events: readonly Event[]): RenderedCard {
  let message = '';
  const tools = new Map<string, ToolLine>();
  let error: string | undefined;
  let finished = false;
  let terminal: string | undefined;
  let throughSeq = 0;
  let turnStartSeq = 0;
  // Tracked so the placeholder can say *why* nothing is happening. A card reading
  // "Working…" while the agent is blocked on a button is how approvals sit
  // unanswered for hours: the user has no reason to look for one.
  const openApprovals = new Set<string>();

  for (const event of events) {
    throughSeq = Math.max(throughSeq, event.seq);
    const payload = event.payload as Record<string, unknown> | null;

    switch (event.type) {
      case 'agent_message_chunk': {
        const text = typeof payload?.['text'] === 'string' ? payload['text'] : '';
        message += text;
        break;
      }
      case 'tool_call': {
        const id = String(payload?.['toolCallId'] ?? '');
        tools.set(id, {
          title: String(payload?.['title'] ?? id),
          status: String(payload?.['status'] ?? 'pending'),
        });
        break;
      }
      case 'tool_call_update': {
        const id = String(payload?.['toolCallId'] ?? '');
        const existing = tools.get(id);
        // An update for a tool call we never saw still gets a line. Dropping it
        // would hide work the agent actually did, because `tool_call` and its
        // updates can straddle a restart.
        tools.set(id, {
          title: existing?.title ?? id,
          status: String(payload?.['status'] ?? existing?.status ?? 'pending'),
        });
        break;
      }
      case 'turn_submitted': {
        // A new prompt starts a new reply, so everything the previous one
        // accumulated goes -- see the note on this function.
        turnStartSeq = event.seq;
        message = '';
        error = undefined;
        tools.clear();
        finished = false;
        terminal = undefined;
        openApprovals.clear();
        break;
      }
      case 'agent_error': {
        error = String(payload?.['message'] ?? 'unknown agent error');
        break;
      }
      case 'approval_requested': {
        openApprovals.add(String(payload?.['approvalId'] ?? ''));
        break;
      }
      case 'approval_resolved': {
        openApprovals.delete(String(payload?.['approvalId'] ?? ''));
        break;
      }
      case 'turn_ended': {
        finished = true;
        terminal = String(payload?.['terminal'] ?? 'completed');
        break;
      }
      default:
        // Thoughts, plans and usage are deliberately not in the card body -- they
        // are noise at chat width. The approval's own text is not here either: it
        // gets a separate card, because it needs buttons.
        break;
    }
  }

  const parts: string[] = [];

  const toolLines = [...tools.values()].map((t) => `${statusIcon(t.status)} ${forDisplay(t.title)}`);
  if (toolLines.length > 0) parts.push(toolLines.join('\n'));

  const body = message.trim();
  if (body !== '') parts.push(forDisplay(body));

  if (error !== undefined) parts.push(`**Error:** ${forDisplay(error)}`);

  // Only while the turn is open. After a terminal the approval is moot, and a
  // stale "waiting on you" line sends the user hunting for a button that no
  // longer does anything.
  const blocked = !finished && openApprovals.size > 0;
  if (blocked) parts.push('_Waiting for your approval — see the card below._');

  if (finished && terminal !== undefined && terminal !== 'completed') {
    parts.push(`_Turn ${forDisplay(terminal)}._`);
  }

  // Empty output is a legitimate terminal, not a bug to paper over -- but an
  // empty card is indistinguishable from a broken one, so say so explicitly.
  if (parts.length === 0) {
    parts.push(finished ? '_Finished with no output._' : '_Working…_');
  }

  return {
    text: truncate(parts.join('\n\n'), CARD_TEXT_BUDGET),
    throughSeq,
    finished,
    turnStartSeq,
  };
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return '✅';
    case 'failed':
      return '❌';
    case 'in_progress':
      return '⏳';
    default:
      return '•';
  }
}
