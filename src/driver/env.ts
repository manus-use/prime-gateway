/**
 * The environment an agent process is given.
 *
 * Built by **allowlist**, not by copying `process.env` and deleting things. Those
 * two are not equivalent: a denylist is only as good as its last update, and the
 * gateway's own environment will accumulate variables nobody auditing this file
 * knows about. An allowlist fails closed -- a variable the agent needs but nobody
 * listed produces a clear error, whereas a variable it should never have seen
 * produces a leak nobody notices.
 *
 * Shared by every driver. Which protocol the agent speaks has no bearing on what
 * it is allowed to read, and two copies of this list would diverge.
 */

/**
 * Variables passed through to the agent.
 *
 * Deliberately short. Anything the agent needs that is not here should be added
 * here explicitly, in a commit someone reviews -- or named in `agent.passEnv`,
 * which is the operator's route and does not require a code change.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  // Node/toolchain discovery the agent legitimately needs to run commands.
  'NODE_PATH',
  'NVM_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  // Proxy configuration, without which an agent behind a corporate proxy simply
  // cannot reach anything and reports it as an unexplained network failure.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/**
 * Variables scrubbed even if something puts them back.
 *
 * When the gateway itself is launched from inside Claude Code, these are present
 * in `process.env` and make the child believe it is a nested session. The symptom
 * is not a crash -- it is an agent that quietly behaves differently, which is the
 * hardest kind of thing to debug.
 *
 * This list is applied *after* the allowlist as a belt-and-braces measure: if
 * someone later adds a broad passthrough, this still holds.
 */
const ENV_SCRUB_PREFIXES = ['CLAUDE_CODE_'] as const;
const ENV_SCRUB_EXACT = ['CLAUDECODE', 'CLAUDE_PID'] as const;

export function buildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) out[key] = value;

  for (const key of Object.keys(out)) {
    if (ENV_SCRUB_EXACT.includes(key as (typeof ENV_SCRUB_EXACT)[number])) delete out[key];
    if (ENV_SCRUB_PREFIXES.some((p) => key.startsWith(p))) delete out[key];
  }
  return out;
}
