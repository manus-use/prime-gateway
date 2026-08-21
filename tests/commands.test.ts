import { describe, expect, it } from 'vitest';
import { COMMANDS, parseCommand, renderHelp } from '../src/core/commands.js';

describe('parseCommand', () => {
  it('returns undefined for a plain prompt', () => {
    expect(parseCommand('what does this repo do?')).toBeUndefined();
    expect(parseCommand('the path is /usr/local')).toBeUndefined();
  });

  it('names an unrecognized verb instead of forwarding it to the agent', () => {
    // A typo'd command silently forwarded as a prompt makes the agent answer
    // `/statsu` as though it were a question.
    expect(parseCommand('/statsu')).toEqual({ unknown: 'statsu' });
  });

  it('is case-insensitive and tolerates leading whitespace', () => {
    const parsed = parseCommand('   /STATUS');
    expect(parsed).toBeDefined();
    expect(parsed && 'spec' in parsed && parsed.spec.name).toBe('status');
  });

  it('resolves an alias to the very same spec, so the tier cannot differ', () => {
    const stop = parseCommand('/stop');
    const cancel = parseCommand('/cancel');
    if (stop === undefined || !('spec' in stop)) throw new Error('/stop did not parse');
    if (cancel === undefined || !('spec' in cancel)) throw new Error('/cancel did not parse');
    expect(stop.spec).toBe(cancel.spec);
  });

  it('keeps only the first line for a single-line command', () => {
    // Passing an embedded newline into a session id produces an error naming the
    // whole blob rather than the mistake.
    const parsed = parseCommand('/attach s_abc\nrm -rf /');
    expect(parsed && 'spec' in parsed && parsed.arg).toBe('s_abc');
  });

  it('keeps the whole argument for a multiline command', () => {
    const parsed = parseCommand('/cd /tmp/one\n/tmp/two');
    expect(parsed && 'spec' in parsed && parsed.arg).toBe('/tmp/one\n/tmp/two');
  });

  it('accepts a bare verb with no argument', () => {
    const parsed = parseCommand('/new');
    expect(parsed && 'spec' in parsed && parsed.arg).toBe('');
  });
});

describe('the command table', () => {
  it('keeps tier next to the command it governs', () => {
    // Tier lives on the spec precisely so a router-side Set cannot drift away from
    // the command it was written to guard.
    for (const spec of COMMANDS) {
      expect(spec.tier === 'talk' || spec.tier === 'operate').toBe(true);
    }
  });

  it('marks every state-changing verb as mutating, except /stop', () => {
    const byName = new Map(COMMANDS.map((c) => [c.name, c]));
    expect(byName.get('new')?.mutating).toBe(true);
    expect(byName.get('attach')?.mutating).toBe(true);
    expect(byName.get('cd')?.mutating).toBe(true);
    // Not mutating in the refuse-mid-turn sense: stopping mid-turn is the point.
    expect(byName.get('stop')?.mutating).toBe(false);
  });

  it('requires operator tier for everything that changes state', () => {
    for (const spec of COMMANDS) {
      if (spec.mutating) expect(spec.tier).toBe('operate');
    }
  });

  it('has no /approve', () => {
    // The blocked permission RPC *is* the pending request. A chat verb would be a
    // second mutation path reachable only by users who can already click.
    expect(COMMANDS.some((c) => c.name === 'approve')).toBe(false);
  });
});

describe('renderHelp', () => {
  it('lists every command and says which need operator permission', () => {
    const help = renderHelp();
    for (const spec of COMMANDS) expect(help).toContain(spec.name);
    expect(help).toContain('operator');
  });

  it('says when a change only applies to the next session', () => {
    // Without it, a user changes a setting, sees nothing happen, and concludes the
    // command is broken.
    expect(renderHelp()).toContain('applies to the next session');
  });
});
