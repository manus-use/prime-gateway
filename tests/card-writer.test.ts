import { describe, expect, it } from 'vitest';
import { CARD_MAX_AGE_MS, CardWriter } from '../src/channel/card-writer.js';
import { ChannelError } from '../src/channel/types.js';
import type { Event, EventType } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock } from './helpers/db.js';

const NOW = 1_760_000_000_000;

function ev(seq: number, type: EventType, payload: unknown): Event {
  return {
    sessionId: 's_1',
    seq,
    type,
    actor: type === 'turn_submitted' ? 'user' : 'agent',
    generation: 0,
    payload,
    ts: NOW,
    brokerSeq: null,
    turnId: 't_1',
  };
}

interface Harness {
  writer: CardWriter;
  channel: FakeChannel;
  clock: ManualClock;
  log: Event[];
  /** Append one chunk and return the seq it landed at. */
  chunk(text: string): number;
  end(terminal: string): number;
  /** Append a prompt, which is what starts a new card. */
  submit(text: string): number;
  rendered: number[];
  cardChanges: Array<string | null>;
}

function harness(): Harness {
  const clock = new ManualClock(NOW);
  const channel = new FakeChannel({ clock });
  const log: Event[] = [];
  const rendered: number[] = [];
  const cardChanges: Array<string | null> = [];

  const writer = new CardWriter({
    channel,
    target: { chatId: 'oc_chat', threadId: '' },
    readEvents: (afterSeq, throughSeq) =>
      log.filter((e) => e.seq > afterSeq && e.seq <= throughSeq),
    onRendered: (seq) => rendered.push(seq),
    onCardChanged: (id) => cardChanges.push(id),
    sendUuid: (seq) => `uuid_${seq}`,
    clock,
  });

  return {
    writer,
    channel,
    clock,
    log,
    rendered,
    cardChanges,
    chunk(text: string): number {
      const seq = log.length + 1;
      log.push(ev(seq, 'agent_message_chunk', { text }));
      return seq;
    },
    end(terminal: string): number {
      const seq = log.length + 1;
      log.push(ev(seq, 'turn_ended', { terminal }));
      return seq;
    },
    submit(text: string): number {
      const seq = log.length + 1;
      log.push(ev(seq, 'turn_submitted', { text }));
      return seq;
    },
  };
}

describe('CardWriter', () => {
  it('opens the card on the first render and reports the message id once', async () => {
    const h = harness();
    h.writer.want(h.chunk('hello'));
    await h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard']);
    expect(h.cardChanges).toEqual([h.channel.lastCard?.messageId]);
    expect(h.channel.lastCard?.text).toContain('hello');
    expect(h.writer.messageId).toBe(h.channel.lastCard?.messageId);
  });

  it('does not re-set content the open call already delivered', async () => {
    // The initial text goes out with `openCard`; a `set` right behind it is a
    // second round-trip for a card that already shows the right thing.
    const h = harness();
    h.writer.want(h.chunk('hello'));
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual(['openCard']);
  });

  it('reuses the open card for later renders', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard', 'set']);
    expect(h.channel.cards).toHaveLength(1);
    expect(h.channel.lastCard?.text).toContain('ab');
  });

  it('ignores a request for a seq it has already been asked for', async () => {
    const h = harness();
    h.chunk('a');
    h.chunk('b');
    h.writer.want(2);
    h.writer.want(1);
    await h.writer.flushNow();
    expect(h.rendered).toEqual([2]);
  });

  it('keeps exactly one write in flight', async () => {
    // Feishu's write ordering does not decide which render is current. Two
    // concurrent writes means the loser can land last.
    const h = harness();
    h.writer.want(h.chunk('a'));
    h.channel.hold();
    const first = h.writer.flushNow();
    h.writer.want(h.chunk('b'));
    const second = h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard']);
    h.channel.release();
    await Promise.all([first, second]);
    expect(h.channel.calls.filter((c) => c === 'openCard')).toHaveLength(1);
  });

  it('collapses everything queued during a write into one later render', async () => {
    // The queue is a single integer, so three chunks arriving mid-write cost one
    // extra write, not three.
    const h = harness();
    h.writer.want(h.chunk('a'));
    h.channel.hold();
    const inFlight = h.writer.flushNow();

    h.writer.want(h.chunk('b'));
    h.writer.want(h.chunk('c'));
    h.writer.want(h.chunk('d'));

    h.channel.release();
    await inFlight;
    await h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard', 'set']);
    expect(h.channel.lastCard?.text).toContain('abcd');
    expect(h.rendered).toEqual([1, 4]);
  });

  it('renders the newest state after a failure, not the state that failed', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();

    h.channel.failNext('set', new ChannelError(99991400, 'throttled', true));
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();
    expect(h.rendered).toEqual([1]);

    h.writer.want(h.chunk('c'));
    await h.writer.flushNow();
    expect(h.rendered).toEqual([1, 3]);
    expect(h.channel.lastCard?.text).toContain('abc');
  });

  it('does not advance the cursor for a write that failed', async () => {
    // Advancing it would make the next render start after content that was never
    // displayed, so the failure becomes a silent hole in the transcript.
    const h = harness();
    h.channel.failNext('openCard', new ChannelError(99991400, 'throttled', true));
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();

    expect(h.rendered).toEqual([]);
    expect(h.writer.renderedThrough).toBe(0);
  });

  it('opens a fresh card when the old one is gone, and clears the stored id', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    const firstId = h.channel.lastCard?.messageId;

    h.channel.failNext('set', new ChannelError(230011, 'message withdrawn', false));
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.cardChanges).toEqual([firstId, null]);

    await h.writer.flushNow();
    expect(h.channel.cards).toHaveLength(2);
    // Re-rendered from the log, so nothing that happened before the withdrawal is
    // lost.
    expect(h.channel.lastCard?.text).toContain('ab');
    expect(h.cardChanges.at(-1)).toBe(h.channel.lastCard?.messageId);
  });

  it('keeps the card on a failure that is not a gone-card code', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.channel.failNext('set', new ChannelError(99991400, 'throttled', true));
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    await h.writer.flushNow();
    expect(h.channel.cards).toHaveLength(1);
  });

  it('treats a non-ChannelError as a plain failure rather than a lost card', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.channel.failNext('set', new Error('socket hang up'));
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.cardChanges).toHaveLength(1);
  });

  it('rotates a card before the entity expires rather than at the edge', async () => {
    // An expired entity fails as an update that silently stops landing, which is
    // indistinguishable from an idle agent.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();

    h.clock.advance(CARD_MAX_AGE_MS + 1);
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(2);
    expect(h.channel.lastCard?.text).toContain('ab');
  });

  it('freezes the card when the render reports a terminal', async () => {
    const h = harness();
    h.chunk('done');
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    // Opened and frozen in the same pass: a card that is already final when first
    // written must not be left streaming.
    expect(h.channel.calls).toEqual(['openCard', 'finish']);
    expect(h.channel.lastCard?.finishes).toHaveLength(1);
  });

  it('freezes an already-open card on the terminal render', async () => {
    const h = harness();
    h.writer.want(h.chunk('working'));
    await h.writer.flushNow();
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard', 'finish']);
  });

  it('opens a new card for the next turn instead of writing to the frozen one', async () => {
    // The failure this exists for, observed in production: the first prompt was
    // answered and the next three looked unanswered. `set` on a frozen card is
    // accepted and discarded, so nothing failed, the cursor advanced, and three
    // real answers were gone with no error anywhere.
    const h = harness();
    h.chunk('first answer');
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();
    const firstCard = h.channel.lastCard;

    h.submit('second ask');
    h.writer.want(h.chunk('second answer'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(2);
    expect(h.channel.lastCard).not.toBe(firstCard);
    expect(h.channel.lastCard?.text).toContain('second answer');
    // The whole point: nothing was written into the closed stream.
    expect(firstCard?.droppedSets).toEqual([]);
    expect(firstCard?.text).toContain('first answer');
  });

  it('shows the new reply on its own card, not under the previous answer', async () => {
    const h = harness();
    h.submit('first ask');
    h.chunk('first answer');
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    h.submit('second ask');
    h.writer.want(h.chunk('second answer'));
    await h.writer.flushNow();

    expect(h.channel.lastCard?.text).not.toContain('first answer');
  });

  it('freezes the card it is leaving behind', async () => {
    // Coalescing can put the terminal and the next turn's first chunk in one
    // render. Nothing will ever write to the old card again, so a card left
    // streaming here keeps its typing indicator forever.
    const h = harness();
    h.writer.want(h.chunk('an answer'));
    await h.writer.flushNow();
    const first = h.channel.lastCard;

    h.end('completed');
    h.submit('next ask');
    h.writer.want(h.chunk('the next answer'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(2);
    expect(first?.finishes).toHaveLength(1);
    // Frozen showing its own turn, not a preview of the next one.
    expect(first?.text).toContain('an answer');
    expect(first?.text).not.toContain('the next answer');
  });

  it('still opens the next card when tidying the old one fails', async () => {
    // The old card is cosmetic; the new one carries the answer.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();

    h.channel.failNext('finish', new ChannelError(230011, 'withdrawn', false));
    h.submit('next');
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(2);
    expect(h.channel.lastCard?.text).toContain('b');
  });

  it('keeps one card for the whole of one turn', async () => {
    const h = harness();
    h.submit('ask');
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(1);
    expect(h.channel.calls).toEqual(['openCard', 'set', 'finish']);
  });

  it('flushes what is outstanding before closing', async () => {
    // A teardown that returns before the last write lands leaves the user looking
    // at a partial answer with no sign more was coming.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.close();
    expect(h.rendered).toEqual([1]);
  });

  it('freezes an un-frozen card on the way out', async () => {
    // Otherwise the typing indicator spins forever on a session nothing is running.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    await h.writer.close();

    expect(h.channel.lastCard?.finishes).toHaveLength(1);
    expect(h.channel.lastCard?.text).toContain('a');
  });

  it('does not freeze twice', async () => {
    const h = harness();
    h.chunk('a');
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();
    await h.writer.close();
    expect(h.channel.lastCard?.finishes).toHaveLength(1);
  });

  it('survives a failure while freezing during teardown', async () => {
    // Shutdown is best-effort; a cosmetic card defect must not abort the rest of it.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.channel.failNext('finish', new ChannelError(230011, 'withdrawn', false));
    await expect(h.writer.close()).resolves.toBeUndefined();
  });

  it('ignores requests after close', async () => {
    const h = harness();
    await h.writer.close();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual([]);
  });

  it('adopts only the cursor on resume, never a card', async () => {
    // The previous card session died with the process that owned it, so the next
    // render has to open a new card -- and re-render from the cursor, not from 0.
    const h = harness();
    h.chunk('before restart');
    h.writer.resumeFrom(1);
    expect(h.writer.renderedThrough).toBe(1);
    expect(h.writer.messageId).toBeUndefined();

    h.writer.want(1);
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual([]);

    h.writer.want(h.chunk('after'));
    await h.writer.flushNow();
    // Rendered from 0 regardless of the cursor: a render is a full replacement of
    // the card, so the new card shows the whole turn.
    expect(h.channel.lastCard?.text).toContain('before restart');
    expect(h.channel.lastCard?.text).toContain('after');
  });
});
