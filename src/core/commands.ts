import type { Tier } from '../types.js';

/**
 * The command registry.
 *
 * A table, deliberately not a `switch`. The failure mode a `switch` produces is
 * specific and nasty: aliases become fall-through labels, the metadata that
 * governs them (which tier, whether a session is needed) ends up in side `Set`s
 * that the *router* consults instead of the table, and the two drift. What you
 * get is a permission check that no longer guards the command it was written for,
 * and nothing about the code looks wrong.
 *
 * Here, a command's tier is a property of the command. There is nowhere else to
 * put it and nothing else to keep in sync.
 */

export interface CommandSpec {
  name: string;
  aliases?: readonly string[];
  tier: Tier;
  /** Whether the command needs a bound session to act on. */
  needsSession: boolean;
  /**
   * Whether the change takes effect now or at the next session.
   *
   * Surfaced in `/help`. Without it, a user changes a setting, sees nothing
   * happen, and concludes the command is broken.
   */
  effect: 'immediate' | 'next-session';
  /** Whether the argument may contain newlines (a pasted path, a long prompt). */
  multiline: boolean;
  /** Whether the command mutates session state, and so must refuse mid-turn. */
  mutating: boolean;
  summary: string;
  usage?: string;
}

/**
 * Note what is absent: there is no `/approve`.
 *
 * `session/request_permission` blocks the agent, and that blocked RPC *is* the
 * pending request. A chat verb would be a second way to mutate it, reachable only
 * by users who can already click the button -- so it adds a code path and no
 * capability.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'new',
    tier: 'operate',
    needsSession: false,
    effect: 'immediate',
    multiline: false,
    mutating: true,
    summary: 'Start a fresh session here, retiring the current one.',
  },
  {
    name: 'sessions',
    aliases: ['ls'],
    tier: 'talk',
    needsSession: false,
    effect: 'immediate',
    multiline: false,
    mutating: false,
    summary: 'List sessions bound in this chat.',
  },
  {
    name: 'attach',
    tier: 'operate',
    needsSession: false,
    effect: 'immediate',
    multiline: false,
    mutating: true,
    summary: 'Bind this thread to an existing session.',
    usage: '/attach <session-id>',
  },
  {
    name: 'cd',
    tier: 'operate',
    needsSession: true,
    effect: 'next-session',
    multiline: true,
    mutating: true,
    // Not typed at the agent. `/cd` is a gateway state operation -- suspend,
    // repin the realpath, cold-resume -- because typing `cd` at the agent changes
    // one shell's directory and leaves the gateway's idea of the workspace, which
    // is what governs every future spawn, untouched.
    summary: 'Repoint this session at a different directory.',
    usage: '/cd <absolute-path>',
  },
  {
    name: 'stop',
    aliases: ['cancel'],
    tier: 'operate',
    needsSession: true,
    effect: 'immediate',
    multiline: false,
    // Not mutating in the refuse-mid-turn sense: stopping mid-turn is the entire
    // purpose. Marking it mutating would make it refuse in precisely the
    // situation it exists for.
    mutating: false,
    summary: 'Cancel the current turn. Cancellation is a terminal, not a deletion.',
  },
  {
    name: 'status',
    tier: 'talk',
    needsSession: false,
    effect: 'immediate',
    multiline: false,
    mutating: false,
    summary: 'Show what this session is doing.',
  },
  {
    name: 'help',
    tier: 'talk',
    needsSession: false,
    effect: 'immediate',
    multiline: false,
    mutating: false,
    summary: 'List commands.',
  },
];

const BY_NAME = new Map<string, CommandSpec>();
for (const spec of COMMANDS) {
  BY_NAME.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) {
    if (BY_NAME.has(alias)) throw new Error(`command alias collision: ${alias}`);
    BY_NAME.set(alias, spec);
  }
}

export interface ParsedCommand {
  spec: CommandSpec;
  /** Everything after the verb, trimmed. */
  arg: string;
}

/**
 * Parse a leading slash command.
 *
 * Returns `{ unknown: name }` for a slash-prefixed word we do not recognize,
 * rather than falling through to the agent. A typo'd command silently forwarded
 * as a prompt is confusing: the user sees the agent respond to `/statsu` as
 * though it were a question.
 */
export function parseCommand(
  text: string,
): ParsedCommand | { unknown: string } | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return undefined;

  const match = /^\/([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(trimmed);
  if (match === null) return undefined;

  const name = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').trim();

  const spec = BY_NAME.get(name);
  if (spec === undefined) return { unknown: name };

  // A single-line command given a multi-line argument keeps only the first line.
  // The alternative -- passing embedded newlines into a path or an id -- produces
  // errors that name the whole blob rather than the mistake.
  const arg = spec.multiline ? rest : (rest.split('\n')[0] ?? '').trim();
  return { spec, arg };
}

export function renderHelp(): string {
  const lines = COMMANDS.map((c) => {
    const usage = c.usage ?? `/${c.name}`;
    const badges = [
      c.tier === 'operate' ? 'operator' : 'anyone allowed',
      c.effect === 'next-session' ? 'applies to the next session' : null,
    ].filter((b): b is string => b !== null);
    return `\`${usage}\` — ${c.summary} (${badges.join(', ')})`;
  });
  return lines.join('\n');
}
