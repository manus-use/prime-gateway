import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpDriver } from '../src/driver/acp/driver.js';
import type { AgentRuntime, DriverEvent, StartResult } from '../src/driver/types.js';

/**
 * The ACP driver against a real child process.
 *
 * These are the only tests in the suite that spawn anything, and they exist for
 * the failures that only a separate process produces: an agent that exits
 * mid-turn, one that refuses to initialize, one that advertises a capability it
 * does not have. In-process doubles cooperate; other people's processes do not.
 *
 * `tests/fakes/agent.mjs` speaks the wire format by hand and logs every method the
 * driver calls, which is how replay -- whose output the driver deliberately
 * discards -- becomes observable at all.
 */

const AGENT = fileURLToPath(new URL('./fakes/agent.mjs', import.meta.url));

interface Started {
  runtime: AgentRuntime;
  result: StartResult;
  /** Methods the agent was asked for, in order. */
  log(): Array<Record<string, unknown>>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function start(
  mode: string,
  opts: { providerSessionId?: string; replay?: Array<{ text: string; paths: string[] }> } = {},
): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'prime-acp-'));
  const logPath = join(dir, 'agent.log');
  const driver = createAcpDriver({
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_LOG: logPath },
  });

  const started = await driver.start({
    cwd: dir,
    providerSessionId: opts.providerSessionId,
    replay: opts.replay,
  });

  cleanups.push(async () => {
    await started.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    runtime: started.runtime,
    result: started.result,
    log: () => {
      let raw: string;
      try {
        raw = readFileSync(logPath, 'utf8');
      } catch {
        return [];
      }
      return raw
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
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

describe('ACP driver: establishing a session', () => {
  it('returns a usable runtime and the id the agent minted', async () => {
    const s = await start('basic');
    // Observed, never assumed: agents mint their own ids and can rotate them.
    expect(s.result).toEqual({ providerSessionId: 'sess_fake_1', mode: 'fresh' });
    expect(s.runtime.providerSessionId).toBe('sess_fake_1');
    expect(s.log().map((e) => e['method'])).toEqual(['initialize', 'session/new']);
  });

  it('resumes natively when the agent advertises it', async () => {
    const s = await start('resume', { providerSessionId: 'sess_prior' });
    expect(s.result).toEqual({ providerSessionId: 'sess_prior', mode: 'resumed' });
    const methods = s.log().map((e) => e['method']);
    expect(methods).toEqual(['initialize', 'session/resume']);
    // No fresh session: creating one would abandon the state we just resumed.
    expect(methods).not.toContain('session/new');
  });

  it('falls back to session/load when resume is unavailable', async () => {
    const s = await start('load', { providerSessionId: 'sess_prior' });
    expect(s.result.mode).toBe('resumed');
    expect(s.log().map((e) => e['method'])).toEqual(['initialize', 'session/load']);
  });

  it('does not forward the history session/load replays back at us', async () => {
    // The log is the system of record. Re-emitting the agent's history as if it
    // were new output would duplicate everything the user has already read.
    const s = await start('load', { providerSessionId: 'sess_prior' });
    const events = await collect(s.runtime.prompt({ text: 'live one', paths: [] }));
    expect(texts(events)).toBe('hello world (live one)');
  });

  it('replays into a fresh session when the agent can do neither', async () => {
    const s = await start('basic', {
      providerSessionId: 'sess_prior',
      replay: [
        { text: 'p1', paths: [] },
        { text: 'p2', paths: [] },
      ],
    });

    // The degrade is reported, not hidden: `replayed` is a worse outcome than
    // `resumed` and the difference is the user's to know about.
    expect(s.result).toEqual({ providerSessionId: 'sess_fake_1', mode: 'replayed' });
    const prompts = s.log().filter((e) => e['method'] === 'session/prompt');
    expect(prompts.map((e) => e['text'])).toEqual(['p1', 'p2']);
  });

  it('discards replayed output rather than re-rendering it', async () => {
    const s = await start('basic', {
      providerSessionId: 'sess_prior',
      replay: [{ text: 'old work', paths: [] }],
    });
    const events = await collect(s.runtime.prompt({ text: 'new work', paths: [] }));
    // What replay buys is the agent's internal state, not its output.
    expect(texts(events)).toBe('hello world (new work)');
  });

  it('reports a start failure with the agent stderr attached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-acp-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const driver = createAcpDriver({
      command: process.execPath,
      args: [AGENT],
      env: { FAKE_AGENT_MODE: 'bad-init' },
    });

    // A half-established runtime must never escape, and stderr is the only
    // explanation an agent that fails to start ever gives.
    await expect(driver.start({ cwd: dir })).rejects.toThrow(/ACP session failed to start/);
    await expect(driver.start({ cwd: dir })).rejects.toThrow(/no credentials/);
  });

  it('reports a command that does not exist rather than hanging', async () => {
    const driver = createAcpDriver({ command: '/nonexistent/agent-binary', args: [] });
    await expect(driver.start({ cwd: tmpdir() })).rejects.toThrow(/failed to start/);
  });
});

describe('ACP driver: a turn', () => {
  it('normalizes updates into driver events, ending with a terminal', async () => {
    const s = await start('basic');
    const events = await collect(s.runtime.prompt({ text: 'go', paths: ['/tmp/a.png'] }));

    expect(kinds(events)).toEqual([
      'thought-chunk',
      'message-chunk',
      'tool-call',
      'tool-call-update',
      'message-chunk',
      'turn-ended',
    ]);
    expect(texts(events)).toBe('hello world (go)');
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
  });

  it('sends attachments as links, never as bytes', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt({ text: 'look', paths: ['/tmp/a.png'] }));
    const prompt = s.log().find((e) => e['method'] === 'session/prompt');
    expect(prompt?.['links']).toEqual(['file:///tmp/a.png']);
  });

  it('treats a refusal as a completion, not a failure', async () => {
    const s = await start('refusal');
    const events = await collect(s.runtime.prompt({ text: 'do something bad', paths: [] }));
    // The agent ran and declined. Retrying a refusal produces the same refusal.
    expect(events).toEqual([{ kind: 'turn-ended', terminal: 'completed' }]);
  });

  it('hands over stderr when a turn reports success and produced nothing', async () => {
    const s = await start('silent');
    const events = await collect(s.runtime.prompt({ text: "what's your model?", paths: [] }));
    // A clean terminal with zero updates and a process that wrote to stderr is not
    // a turn with nothing to say. Without this the card reads "finished with no
    // output" while the explanation sits in a pipe nobody reads.
    expect(kinds(events)).toEqual(['error', 'turn-ended']);
    const error = events[0] as { kind: 'error'; message: string; retryable: boolean };
    expect(error.message).toContain('ProviderModelNotFoundError');
    // The agent claimed success, so the terminal stands: this adds evidence rather
    // than overruling it.
    expect(events[1]).toEqual({ kind: 'turn-ended', terminal: 'completed' });
    // Configuration is fixable, and the same prompt then works.
    expect(error.retryable).toBe(true);
  });

  it('stays quiet when a turn legitimately has nothing to say', async () => {
    // `refusal` produces no updates either, but writes no stderr. Reporting an
    // error there would make every empty turn look like a malfunction.
    const s = await start('refusal');
    const events = await collect(s.runtime.prompt({ text: 'do something bad', paths: [] }));
    expect(kinds(events)).toEqual(['turn-ended']);
  });

  it('drops updates it has no projection for and keeps the ones it has', async () => {
    const s = await start('noise');
    const events = await collect(s.runtime.prompt({ text: 'go', paths: [] }));
    // An exhaustive switch that threw would make every protocol addition a
    // breaking change.
    expect(kinds(events)).toEqual(['usage', 'turn-ended']);
  });

  it('refuses a second concurrent prompt instead of interleaving two turns', async () => {
    const s = await start('hang');
    const first = s.runtime.prompt({ text: 'one', paths: [] });
    expect(() => s.runtime.prompt({ text: 'two', paths: [] })).toThrow(/already in flight/);

    await s.runtime.cancel();
    await collect(first);
  });

  it('ends a cancelled turn as cancelled, not as an error', async () => {
    const s = await start('hang');
    const stream = s.runtime.prompt({ text: 'forever', paths: [] });
    await s.runtime.cancel();

    const events = await collect(stream);
    // Cancellation is a terminal, not a deletion.
    expect(events).toEqual([{ kind: 'turn-ended', terminal: 'cancelled' }]);
    expect(s.log().map((e) => e['method'])).toContain('session/cancel');
  });

  it('closes a turn that is still open when the runtime goes away', async () => {
    const s = await start('hang');
    const stream = s.runtime.prompt({ text: 'forever', paths: [] });
    await s.runtime.close();

    expect(await collect(stream)).toEqual([
      { kind: 'turn-ended', terminal: 'cancelled', detail: 'runtime closed' },
    ]);
  });

  it('is safe to close twice', async () => {
    const s = await start('basic');
    await s.runtime.close();
    await expect(s.runtime.close()).resolves.toBeUndefined();
  });
});

describe('ACP driver: permissions', () => {
  it('parks the agent until the request is answered', async () => {
    const s = await start('permission');
    const stream = s.runtime.prompt({ text: 'delete things', paths: [] });
    const events: DriverEvent[] = [];

    for await (const event of stream) {
      events.push(event);
      if (event.kind === 'permission-request') {
        expect(event.action).toBe('rm -rf /tmp/scratch');
        expect(event.options).toEqual([
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ]);
        event.resolve({ kind: 'selected', optionId: 'allow' });
        // Guarded on purpose: the core reaches this from a click, a cancel and
        // teardown, and a double-resolve must not silently keep the first answer
        // while the second path believes it succeeded.
        event.resolve({ kind: 'selected', optionId: 'deny' });
      }
    }

    expect(kinds(events)).toEqual(['permission-request', 'message-chunk', 'turn-ended']);
    expect(texts(events)).toBe('picked:allow');
    const outcome = s.log().find((e) => e['method'] === 'permission-outcome');
    expect(outcome).toMatchObject({ outcome: 'selected', optionId: 'allow' });
  });

  it('passes a cancellation through as a cancelled turn', async () => {
    const s = await start('permission');
    const events: DriverEvent[] = [];
    for await (const event of s.runtime.prompt({ text: 'delete things', paths: [] })) {
      events.push(event);
      if (event.kind === 'permission-request') event.resolve({ kind: 'cancelled' });
    }
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'cancelled' });
  });

  it('answers an outstanding request when the runtime is closed under it', async () => {
    const s = await start('permission');
    const stream = s.runtime.prompt({ text: 'delete things', paths: [] });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.kind).toBe('permission-request');

    // The agent is blocked on an RPC. Tearing down without answering hangs it,
    // and the process would sit there until something else killed it.
    await s.runtime.close();
    expect((await iterator.next()).value).toMatchObject({ terminal: 'cancelled' });
  });
});

describe('ACP driver: the process dying', () => {
  it('reports an exit mid-turn as ambiguous, with the stderr tail', async () => {
    const s = await start('crash');
    const events = await collect(s.runtime.prompt({ text: 'go', paths: [] }));

    expect(kinds(events)).toEqual(['error', 'turn-ended']);
    const error = events[0];
    expect(error).toMatchObject({ kind: 'error', retryable: true });
    if (error?.kind === 'error') {
      expect(error.message).toContain('exited');
      expect(error.message).toContain('going down mid-turn');
    }
    // Ambiguous, not failed: the process is gone, so whether it consumed the
    // prompt first is exactly what we cannot establish -- and that distinction is
    // what gates quarantine rather than a blind retry.
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
  });
});
