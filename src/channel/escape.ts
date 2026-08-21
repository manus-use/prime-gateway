/**
 * Escaping for Feishu-rendered text. One escaper, used everywhere.
 *
 * This is a **security boundary**, not a formatting nicety. Agent output is
 * untrusted: it contains whatever the model produced, which includes whatever a
 * repository, a web page, or a tool result talked it into producing. Rendered
 * unescaped into a Feishu message, a crafted string injects a literal
 * `<at id=all></at>` and notifies everyone in the chat -- a mention the gateway
 * never authorized, attributed to the bot.
 *
 * Hence: `<` and `>` are escaped. Most markdown escapers do not bother, because
 * in most renderers angle brackets are inert. In Feishu they are a tag syntax.
 */

/**
 * Characters Feishu's `lark_md` treats as markup.
 *
 * The backslash is first, and the ordering is the part implementations get
 * wrong. Escape it last and you double-escape every backslash the other rules
 * just inserted, turning `*` into `\\*` -- a literal backslash followed by an
 * unescaped asterisk, which is exactly the injection you were preventing.
 */
const MD_SPECIALS = ['\\', '`', '*', '_', '[', ']', '(', ')', '~', '<', '>'] as const;

/** Escape text for `lark_md` rendering. */
export function escapeMd(text: string): string {
  let out = text;
  for (const ch of MD_SPECIALS) {
    out = out.split(ch).join(`\\${ch}`);
  }
  return out;
}

/**
 * Strip control characters that corrupt a card payload.
 *
 * Tab, newline and carriage return survive; everything else in C0/C1 goes. A raw
 * control byte inside a JSON string is rejected by the API with an error that
 * names the whole payload rather than the offending byte, which is far more
 * expensive to debug than it is to prevent here. U+FFFE and U+FFFF are
 * non-characters and are dropped for the same reason.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/gu;

export function stripControl(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/**
 * Prepare agent-authored text for display inside a card.
 *
 * Control-strip, then escape. The reverse order would let a stripped control
 * character split an escape sequence it had already inserted.
 */
export function forDisplay(text: string): string {
  return escapeMd(stripControl(text));
}

/**
 * Prepare text for a `plain_text` element.
 *
 * `plain_text` needs no markdown escaping by definition -- the element type is
 * the guarantee. Approval cards use this for agent text so that *displaying* a
 * request cannot itself become a notification: there is no tag syntax to inject
 * into, so the mention-spoofing vector does not exist rather than being
 * defended against.
 */
export function forPlainText(text: string): string {
  return stripControl(text);
}

/**
 * Truncate to a character budget, marking that it happened.
 *
 * Truncation is always announced. Silently cutting an agent's answer produces a
 * message that reads as complete and is not, and the user has no way to know the
 * difference.
 */
export function truncate(text: string, maxChars: number, marker = '\n… (truncated)'): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - marker.length);
  return text.slice(0, budget) + marker;
}

/**
 * Mask a secret for any chat-visible render.
 *
 * Applied to values, never trusted to be applied by callers on a case-by-case
 * basis. Secrets are not editable from chat and are masked in every render;
 * showing a prefix at all is a concession to debuggability, so it is capped hard
 * enough to be useless on its own.
 */
export function mask(value: string): string {
  if (value.length <= 4) return '****';
  return `${value.slice(0, 3)}${'*'.repeat(Math.min(8, value.length - 3))}`;
}
