import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The migrations that ship with this build, found relative to this module rather
 * than to the working directory: a service manager picks the cwd, and migrations
 * belong to the code, not to wherever someone happened to launch it from.
 *
 * One level up holds for both layouts -- `src/config.ts` and `dist/config.js`.
 */
const BUNDLED_SCHEMA_DIR = fileURLToPath(new URL('../schema', import.meta.url));

/**
 * Configuration, from the environment.
 *
 * Two rules, both about failing safely:
 *
 * 1. **Every required value is validated here, at boot.** A missing app secret
 *    discovered on the first inbound message is a bot that connects, looks healthy,
 *    and then does nothing.
 * 2. **Empty means closed.** An unset allowlist reads naturally as "no restrictions
 *    configured", which is the opposite of what a missing allowlist should mean.
 *    Nothing in here defaults to permissive.
 *
 * Secrets are read from the environment and never written anywhere -- not into the
 * workspace, not into the event log, not into a config file the agent could read.
 */

export interface GatewayConfig {
  /** SQLite path. Its directory holds the WAL, so it must be writable. */
  dbPath: string;
  schemaDir: string;
  /** Where inbound attachments land. Outside the workspace, deliberately. */
  downloadDir: string;

  lark: {
    appId: string;
    appSecret: string;
    domain?: string;
  };

  auth: {
    ownerOpenId: string;
    allowTalk: readonly string[];
    allowOperate: readonly string[];
    allowChats: readonly string[];
    allowDirectMessages: boolean;
    allowMentionAll: boolean;
  };

  agent: {
    command: string;
    args: readonly string[];
    /** Extra environment for the agent process. Where credentials go. */
    env: Readonly<Record<string, string>>;
  };

  /** Absolute path the agent works in. */
  workspaceDir: string;

  maxLiveSessions: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): GatewayConfig {
  const home = required(env, 'PRIME_HOME', join(homedir(), '.prime-gateway'));
  const ownerOpenId = required(env, 'PRIME_OWNER_OPEN_ID');

  const allowTalk = list(env['PRIME_ALLOW_TALK']);
  const allowOperate = list(env['PRIME_ALLOW_OPERATE']);

  const workspaceDir = required(env, 'PRIME_WORKSPACE');
  if (!isAbsolute(workspaceDir)) {
    // Relative resolves against the gateway's cwd, which is whatever the service
    // manager set. The workspace would then depend on how the process was launched.
    throw new ConfigError('PRIME_WORKSPACE must be an absolute path');
  }

  const command = required(env, 'PRIME_AGENT_COMMAND');
  const args = shellWords(env['PRIME_AGENT_ARGS'] ?? '');

  return {
    dbPath: env['PRIME_DB'] ?? join(home, 'gateway.db'),
    schemaDir: env['PRIME_SCHEMA_DIR'] ?? BUNDLED_SCHEMA_DIR,
    downloadDir: env['PRIME_DOWNLOAD_DIR'] ?? join(home, 'downloads'),

    lark: {
      appId: required(env, 'LARK_APP_ID'),
      appSecret: required(env, 'LARK_APP_SECRET'),
      ...(env['LARK_DOMAIN'] === undefined ? {} : { domain: env['LARK_DOMAIN'] }),
    },

    auth: {
      ownerOpenId,
      // The owner is always included. An allowlist that excludes the owner locks
      // out the only person who can fix it, and it is not editable from chat.
      allowTalk: [...new Set([ownerOpenId, ...allowTalk])],
      allowOperate: [...new Set([ownerOpenId, ...allowOperate])],
      allowChats: list(env['PRIME_ALLOW_CHATS']),
      allowDirectMessages: flag(env['PRIME_ALLOW_DM'], true),
      // Default false. `@all` is a room-wide notification, not an instruction, and
      // treating it as one makes the bot answer announcements.
      allowMentionAll: flag(env['PRIME_ALLOW_MENTION_ALL'], false),
    },

    agent: {
      command,
      args,
      env: agentEnv(env),
    },

    workspaceDir,
    maxLiveSessions: integer(env['PRIME_MAX_LIVE_SESSIONS'], 8),
  };
}

/**
 * Variables forwarded to the agent process.
 *
 * Opt-in by prefix rather than by pass-through. `PRIME_AGENT_ENV_FOO=bar` becomes
 * `FOO=bar`. Forwarding the gateway's whole environment would hand the agent the
 * Feishu app secret, which is the one credential it must never hold: an agent with
 * it can post as the bot and answer its own approval requests.
 */
const AGENT_ENV_PREFIX = 'PRIME_AGENT_ENV_';

function agentEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(AGENT_ENV_PREFIX) || value === undefined) continue;
    const name = key.slice(AGENT_ENV_PREFIX.length);
    if (name === '') continue;
    out[name] = value;
  }
  return out;
}

function required(env: Env, key: string, fallback?: string): string {
  const value = env[key];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`${key} is required`);
}

function list(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== ''),
    ),
  ];
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  // Not defaulted. A typo'd flag silently taking its default is how a setting
  // someone deliberately changed turns out never to have applied.
  throw new ConfigError(`expected a boolean, got ${JSON.stringify(value)}`);
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Split an argument string on whitespace, honouring quotes.
 *
 * Not a shell. The agent is spawned with `shell: false`, so this must not pretend
 * to support expansion -- accepting `$(...)` here and dropping it there is the kind
 * of half-support that looks like it works until it silently does not.
 */
function shellWords(value: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return out;
}
