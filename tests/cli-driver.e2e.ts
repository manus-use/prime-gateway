import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliDriver, resolveExecutable } from '../src/driver/cli/driver.js';
import type { AgentRuntime, DriverEvent, PromptInput, StartResult } from '../src/driver/types.js';

/**
 * The CLI driver against real child processes -- one per turn, which is the whole
 * point of it.
 *
 * `tests/fakes/cli-agent.mjs` writes its argv to a log on every invocation. That
 * log is the only way to see the composed prompt, and the composed prompt *is* this
 * driver's session handling: with no resume available, continuity exists only as
 * text the driver puts on the command line.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

interface Started {
  runtime: AgentRuntime;
  result: StartResult;
  cwd: string;
  /** One entry per process the driver started, in order. */
  invocations(): Array<{ argv: string[]; prompt: string }>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function start(
  mode: string,
  opts: { replay?: PromptInput[]; maxPromptBytes?: number } = {},
): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'prime-cli-'));
  const logPath = join(dir, 'invocations.log');
  const driver = createCliDriver({
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: logPath },
    ...(opts.maxPromptBytes === undefined ? {} : { maxPromptBytes: opts.maxPromptBytes }),
  });

  const started = await driver.start({ cwd: dir, replay: opts.replay });

  cleanups.push(async () => {
    await started.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    runtime: started.runtime,
    result: started.result,
    cwd: dir,
    invocations: () => {
      let raw: string;
      try {
        raw = readFileSync(logPath, 'utf8');
      } catch {
        return [];
      }
      return raw
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { argv: string[]; prompt: string });
    },
  };
}

async function collect(stream: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
  const events: DriverEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function texts(events: readonly DriverEvent[]): string {
  return events
    .filter((e): e is Extract<DriverEvent, { kind: 'message-chunk' }> => e.kind === 'message-chunk')
    .map((e) => e.text)
    .join('');
}

function kinds(events: readonly DriverEvent[]): string[] {
  return events.map((e) => e.kind);
}

function said(text: string): PromptInput {
  return { text, paths: [] };
}

describe('CLI driver: establishing a session', () => {
  it('starts without a process, and says the id is not the provider’s', async () => {
    const s = await start('basic');
    // No process yet: there is nothing for one to hold open between turns.
    expect(s.invocations()).toEqual([]);
    // A `cli:` id rather than one the agent minted. The agent mints a new session
    // per process and will not take one back, so recording its id would put
    // something in the log that reads as resumable and is not.
    expect(s.result.providerSessionId).toMatch(/^cli:/);
    expect(s.runtime.providerSessionId).toBe(s.result.providerSessionId);
    expect(s.result.mode).toBe('fresh');
  });

  it('reports replayed whenever there is history to carry', async () => {
    // Not `resumed`, ever. The degrade is permanent here rather than a fallback,
    // and reporting it every time is the point: the user is entitled to know the
    // agent is working from a transcript.
    const s = await start('basic', { replay: [said('earlier')] });
    expect(s.result.mode).toBe('replayed');
  });

  it('reports a command that does not exist at start, not mid-turn', async () => {
    const driver = createCliDriver({ command: '/nonexistent/agent-binary', args: [] });
    // Failing to start leaves the session cold. The same failure discovered on the
    // first prompt looks like the agent breaking, and breaking mid-turn is what
    // quarantines a session.
    await expect(driver.start({ cwd: tmpdir() })).rejects.toThrow(/not an executable file/);
  });

  it('finds a bare command on PATH, and says so when it cannot', () => {
    expect(resolveExecutable('node', process.env['PATH'])).toMatch(/node/);
    expect(() => resolveExecutable('definitely-not-a-real-binary', '/usr/bin:/bin')).toThrow(
      /not found on PATH/,
    );
  });
});

describe('CLI driver: a turn', () => {
  it('normalizes the stream into driver events, ending with a terminal', async () => {
    const s = await start('basic');
    const events = await collect(s.runtime.prompt(said('go')));

    expect(kinds(events)).toEqual(['message-chunk', 'message-chunk', 'usage', 'turn-ended']);
    expect(texts(events)).toBe('hello world (go)');
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
  });

  it('passes the flags the parser and the workspace depend on', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt(said('go')));

    const argv = s.invocations()[0]?.argv ?? [];
    // `--format json` is the parsing contract; text output would produce a turn
    // with no events at all.
    expect(argv.join(' ')).toContain('--format json');
    // The workspace is per session, so it cannot come from the configured args.
    expect(argv.join(' ')).toContain(`--dir ${s.cwd}`);
    // Unsupervised, explicitly: there is nowhere to answer a permission request.
    expect(argv).toContain('-y');
    // `--` before the prompt, or a message beginning with `-` is parsed as flags
    // and the agent prints its own help instead of answering.
    expect(argv.indexOf('--')).toBe(argv.length - 2);
  });

  it('maps a tool call through its states under one id', async () => {
    const s = await start('tool');
    const events = await collect(s.runtime.prompt(said('list files')));

    expect(kinds(events)).toEqual([
      'tool-call',
      'tool-call-update',
      'message-chunk',
      'turn-ended',
    ]);
    const call = events[0] as Extract<DriverEvent, { kind: 'tool-call' }>;
    const update = events[1] as Extract<DriverEvent, { kind: 'tool-call-update' }>;
    // Same id across both, or the card shows a second tool that never finishes.
    expect(call.toolCallId).toBe(update.toolCallId);
    expect(call.title).toBe('Glob');
    expect(update.status).toBe('completed');
  });

  it('drops lines it has no projection for and keeps the ones it has', async () => {
    const s = await start('noise');
    const events = await collect(s.runtime.prompt(said('go')));
    // Logger output, telemetry envelopes and a bare `[Stats]` line all share this
    // stdout. A parser that treated an unrecognized line as a fault would fail on
    // every single run.
    expect(kinds(events)).toEqual(['usage', 'turn-ended']);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
  });

  it('shows an answer that was only ever summarized', async () => {
    const s = await start('unstreamed');
    const events = await collect(s.runtime.prompt(said('go')));
    // The answer exists; it just never arrived as deltas. Rendering "finished with
    // no output" next to a summary holding the whole reply would be our bug.
    expect(texts(events)).toBe('the whole answer, unstreamed');
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
  });

  it('sends attachments as paths, never as bytes', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt({ text: 'look', paths: ['/tmp/a.png'] }));
    expect(s.invocations()[0]?.prompt).toContain('/tmp/a.png');
  });

  it('refuses a second concurrent prompt instead of interleaving two turns', async () => {
    const s = await start('hang');
    const first = s.runtime.prompt(said('one'));
    expect(() => s.runtime.prompt(said('two'))).toThrow(/already in flight/);

    await s.runtime.cancel();
    await collect(first);
  });
});

describe('CLI driver: continuity', () => {
  it('carries the previous turn into the next one, fenced', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt(said('remember pickle')));
    await collect(s.runtime.prompt(said('what did I say?')));

    const second = s.invocations()[1]?.prompt ?? '';
    // There is no resume, so continuity is text or it is nothing.
    expect(second).toContain('remember pickle');
    expect(second).toContain('hello world (remember pickle)');
    expect(second).toContain('what did I say?');
    // Fenced with a per-runtime nonce, and every quoted line prefixed, so a user
    // cannot type a line that closes the transcript or attributes their own words
    // to the agent.
    expect(second).toMatch(/--- transcript-[0-9a-f]{8} ---/);
    expect(second).toContain('> remember pickle');
  });

  it('says nothing about a conversation that has not happened yet', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt(said('first thing')));
    // A first turn with no history is the prompt and nothing else. A transcript
    // header over an empty transcript is context the agent has to read past.
    expect(s.invocations()[0]?.prompt).toBe('first thing');
  });

  it('carries replayed prompts, and does not invent answers for them', async () => {
    const s = await start('basic', { replay: [said('asked before')] });
    await collect(s.runtime.prompt(said('asking now')));

    const prompt = s.invocations()[0]?.prompt ?? '';
    expect(prompt).toContain('> asked before');
    // The log has the answers, but `StartOptions.replay` carries prompts only, and
    // the driver is not allowed its own idea of history.
    expect(prompt).not.toContain('you replied');
  });

  it('drops the oldest turns rather than the message being answered', async () => {
    // Sized so the third turn can carry one exchange and not two.
    const s = await start('basic', { maxPromptBytes: 440 });
    await collect(s.runtime.prompt(said('first turn here')));
    await collect(s.runtime.prompt(said('second turn here')));
    await collect(s.runtime.prompt(said('third')));

    const third = s.invocations()[2]?.prompt ?? '';
    expect(third).toContain('third');
    // The recent turn is what "and the other one?" points at; keeping the head and
    // dropping the tail would strand the pronoun.
    expect(third).toContain('second turn here');
    expect(third).not.toContain('first turn here');
  });

  it('refuses a message too large for a command line before starting anything', async () => {
    const s = await start('basic', { maxPromptBytes: 500 });
    const events = await collect(s.runtime.prompt(said('z'.repeat(600))));

    expect(kinds(events)).toEqual(['error', 'turn-ended']);
    const error = events[0] as Extract<DriverEvent, { kind: 'error' }>;
    expect(error.message).toContain('command line');
    // Nothing about retrying makes the message shorter.
    expect(error.retryable).toBe(false);
    // Failed, not ambiguous: it never reached the agent, so nothing is unclear.
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'failed' });
    expect(s.invocations()).toEqual([]);
  });
});

describe('CLI driver: things going wrong', () => {
  it('hands over the reason a turn failed, from stderr', async () => {
    const s = await start('error');
    const events = await collect(s.runtime.prompt(said('go')));

    expect(kinds(events)).toEqual(['error', 'turn-ended']);
    const error = events[0] as Extract<DriverEvent, { kind: 'error' }>;
    // `finish: "error"` carries no message. Without this the user reads "the agent
    // failed" and has nowhere to go.
    expect(error.message).toContain('no such model');
    // The agent's own logger writes to the same stream; its unrelated shutdown
    // notice is not the reason this turn failed.
    expect(error.message).not.toContain('tce-shutdown');
    expect(error.retryable).toBe(true);
    // It ran and failed. That is a different thing from not knowing what happened.
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'failed' });
  });

  it('reports an exit with no terminal as ambiguous, with the stderr tail', async () => {
    const s = await start('crash');
    const events = await collect(s.runtime.prompt(said('go')));

    expect(kinds(events)).toEqual(['message-chunk', 'error', 'turn-ended']);
    const error = events[1] as Extract<DriverEvent, { kind: 'error' }>;
    expect(error.message).toContain('going down mid-turn');
    expect(error.message).toContain('code 7');
    // Ambiguous, not failed: the process is gone, so whether it acted on the prompt
    // first is exactly what cannot be established.
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
  });

  it('does not guess at a terminal it does not recognize', async () => {
    const s = await start('weird');
    const events = await collect(s.runtime.prompt(said('go')));
    // "We do not know how this ended" is a distinct state from success and from
    // failure, and it is the one that gates quarantine.
    expect(events.at(-1)).toEqual({
      kind: 'turn-ended',
      terminal: 'ambiguous',
      detail: 'unrecognized finish "interrupted_by_something_new"',
    });
  });

  it('stops an agent that asks for permission rather than leaving it waiting', async () => {
    const s = await start('permission');
    const events = await collect(s.runtime.prompt(said('delete things')));

    // `-y` exists so this cannot happen, but if a version asks anyway there is no
    // channel to answer on, and the process would wait for an answer that can never
    // arrive. Stopping it beats a turn that hangs until something else notices.
    expect(kinds(events)).toEqual(['message-chunk', 'error', 'turn-ended']);
    const error = events[1] as Extract<DriverEvent, { kind: 'error' }>;
    expect(error.message).toContain('no way to answer');
    expect(error.retryable).toBe(false);
    // It had started acting, and we killed it partway.
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
  });
});

describe('CLI driver: stopping', () => {
  it('ends a cancelled turn as cancelled, not as an error', async () => {
    const s = await start('hang');
    const stream = s.runtime.prompt(said('forever'));
    const iterator = stream[Symbol.asyncIterator]();
    // Wait until the process is actually streaming, so the cancel has something to
    // interrupt rather than racing the spawn.
    expect((await iterator.next()).value).toMatchObject({ kind: 'message-chunk' });

    await s.runtime.cancel();

    const rest: DriverEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest.push(next.value);
    }
    // Killing is the only cancel available, so whatever the agent had already done
    // stands. Cancellation is a terminal, not a deletion.
    expect(rest).toEqual([{ kind: 'turn-ended', terminal: 'cancelled' }]);
  });

  it('closes a turn that is still open when the runtime goes away', async () => {
    const s = await start('hang');
    const stream = s.runtime.prompt(said('forever'));
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    await s.runtime.close();

    const rest: DriverEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest.push(next.value);
    }
    // Closing is a decision of ours. Reporting the process we killed as ambiguous
    // would quarantine a session over our own shutdown.
    expect(rest).toEqual([
      { kind: 'turn-ended', terminal: 'cancelled', detail: 'runtime closed' },
    ]);
  });

  it('is safe to close twice', async () => {
    const s = await start('basic');
    await s.runtime.close();
    await expect(s.runtime.close()).resolves.toBeUndefined();
  });

  it('refuses a prompt after close instead of spawning one more process', async () => {
    const s = await start('basic');
    await s.runtime.close();
    expect(() => s.runtime.prompt(said('go'))).toThrow(/closed/);
    expect(s.invocations()).toEqual([]);
  });
});
