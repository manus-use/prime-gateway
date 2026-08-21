import { describe, expect, it } from 'vitest';
import {
  escapeMd,
  forDisplay,
  forPlainText,
  mask,
  stripControl,
  truncate,
} from '../src/channel/escape.js';

const NUL = '\u0000';
const BEL = '\u0007';
const C1 = '\u009f';
const NONCHAR = '\ufffe';

describe('escapeMd', () => {
  it('escapes angle brackets, which is the mention-injection vector', () => {
    // The whole reason this escaper exists: `<at id=all></at>` rendered raw is a
    // room-wide notification the gateway never authorized.
    const out = escapeMd('<at id=all></at>');
    // No unescaped `<` survives. Asserting on the absence of the substring `<at`
    // would fail on the correct output, since `\<at` still contains it.
    expect(out).not.toMatch(/(^|[^\\])</);
    expect(out).toBe('\\<at id=all\\>\\</at\\>');
  });

  it('escapes the backslash first, so other escapes are not doubled', () => {
    // If `\` were escaped last, `*` would become `\\*` -- a literal backslash and
    // an unescaped asterisk, i.e. the injection the escaper was meant to prevent.
    expect(escapeMd('*')).toBe('\\*');
    expect(escapeMd('\\*')).toBe('\\\\\\*');
  });

  it('never leaves raw markup behind, even applied twice', () => {
    const twice = escapeMd(escapeMd('**bold** <at id=all></at>'));
    expect(twice).not.toMatch(/(^|[^\\])\*/);
    expect(twice).not.toMatch(/(^|[^\\])</);
  });
});

describe('stripControl', () => {
  it('keeps tab, newline and carriage return', () => {
    expect(stripControl('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('drops C0, C1 and non-characters', () => {
    expect(stripControl(`a${NUL}b${BEL}c${C1}d${NONCHAR}e`)).toBe('abcde');
  });
});

describe('forDisplay', () => {
  it('strips before escaping, so a control byte cannot split an escape', () => {
    // Escaping first would insert `\*`, and stripping afterwards could remove a
    // character from inside the sequence it had just written.
    expect(forDisplay(`*${NUL}*`)).toBe('\\*\\*');
  });
});

describe('forPlainText', () => {
  it('strips control characters but adds no markdown escapes', () => {
    // plain_text has no markup to inject into, so escaping would only show the
    // user backslashes that are not in the agent's text.
    expect(forPlainText(`rm -rf * <at>${BEL}`)).toBe('rm -rf * <at>');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('always announces that it cut something', () => {
    const out = truncate('x'.repeat(200), 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith('… (truncated)')).toBe(true);
  });
});

describe('mask', () => {
  it('reveals nothing usable', () => {
    expect(mask('abc')).toBe('****');
    expect(mask('supersecrettoken')).toBe('sup********');
    expect(mask('supersecrettoken')).not.toContain('secret');
  });
});
