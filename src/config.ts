import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * The migrations that ship with this build, found relative to this module rather
 * than to the working directory: a service manager picks the cwd, and migrations
 * belong to the code, not to wherever someone happened to launch it from.
 *
 * One level up holds for both layouts -- `src/config.ts` and `dist/config.js`.
 */
const BUNDLED_SCHEMA_DIR = fileURLToPath(new URL('../schema', import.meta.url));

/**
 * Configuration: a YAML file for settings, the environment for secrets.
 *
 * The split is a trust boundary, not a style preference. In this build the agent
 * runs as the same user as the gateway and is not sandboxed, so **anything on disk
 * it can read**. The environment is not airtight either -- a same-uid process can
 * read `/proc/<pid>/environ` on Linux -- but it does not persist, is not backed up,
 * cannot be copied into a worktree, and cannot be committed by accident. So the
 * file names credentials and never holds them, and a file that does hold one is
 * refused at boot rather than quietly accepted.
 *
 * Four rules, all about failing safely:
 *
 * 1. **Everything is validated here, at boot.** A missing app secret discovered on
 *    the first inbound message is a bot that connects, looks healthy, does nothing.
 * 2. **Empty means closed.** An unset allowlist reads naturally as "no restrictions
 *    configured", which is the opposite of what a missing allowlist should mean.
 *    Nothing in here defaults to permissive.
 * 3. **An unrecognized key is an error.** A typo'd setting that silently takes its
 *    default is how a value someone deliberately changed turns out never to have
 *    applied -- and for the auth keys, that failure is silent *and* permissive.
 * 4. **The environment wins.** Every setting in the file is also settable by
 *    environment variable, so a container deploy needs no file and an emergency
 *    lockdown needs no edit. Lists are replaced, never merged: merging leaves no
 *    way to revoke.
 */

export interface GatewayConfig {
  /** SQLite path. Its directory holds the WAL, so it must be writable. */
  dbPath: string;
  schemaDir: string;
  /** Where inbound attachments land. Outside the workspace, deliberately. */
  downloadDir: string;
  /** The file the settings came from, or undefined if the environment alone. */
  configPath: string | undefined;

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

/**
 * Reads a config file, or reports that there isn't one.
 *
 * Injectable so the merge rules can be tested without a filesystem, and so a test
 * can assert *which* path was read -- the default location is derived, and a loader
 * that silently reads the wrong file is indistinguishable from one whose settings
 * are being ignored.
 */
export type FileReader = (path: string) => string | undefined;

const readIfPresent: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
};

export function loadConfig(
  env: Env = process.env,
  readFile: FileReader = readIfPresent,
): GatewayConfig {
  const home = envString(env, 'PGW_HOME') ?? join(homedir(), '.prime-gateway');
  const explicit = envString(env, 'PGW_CONFIG');
  const path = explicit ?? join(home, 'config.yaml');

  const text = readFile(path);
  if (text === undefined && explicit !== undefined) {
    // A named file that is not there is a mistake; the default location being
    // absent is an ordinary environment-only deployment.
    throw new ConfigError(`PGW_CONFIG points at ${path}, which does not exist`);
  }
  const file = text === undefined ? emptyFile() : parseFile(path, text);

  const ownerOpenId =
    envString(env, 'PGW_OWNER_OPEN_ID') ??
    file.auth.owner ??
    fail('an owner is required: set auth.owner in the config file, or PGW_OWNER_OPEN_ID');

  const workspaceDir =
    envString(env, 'PGW_WORKSPACE') ??
    file.workspace ??
    fail('a workspace is required: set workspace in the config file, or PGW_WORKSPACE');
  if (!isAbsolute(workspaceDir)) {
    // Relative resolves against the gateway's cwd, which is whatever the service
    // manager set. The workspace would then depend on how the process was launched.
    throw new ConfigError(`the workspace must be an absolute path, got ${JSON.stringify(workspaceDir)}`);
  }

  const command =
    envString(env, 'PGW_AGENT_COMMAND') ??
    file.agent.command ??
    fail('an agent command is required: set agent.command in the config file, or PGW_AGENT_COMMAND');

  const argsFromEnv = envString(env, 'PGW_AGENT_ARGS');
  const args = argsFromEnv === undefined ? file.agent.args : shellWords(argsFromEnv);

  const allowTalk = envList(env, 'PGW_ALLOW_TALK') ?? file.auth.talk;
  const allowOperate = envList(env, 'PGW_ALLOW_OPERATE') ?? file.auth.operate;

  return {
    dbPath: envString(env, 'PGW_DB') ?? file.db ?? join(home, 'gateway.db'),
    // Not settable from the file: it locates the migrations that belong to this
    // build, which is a packaging concern rather than an operational one.
    schemaDir: envString(env, 'PGW_SCHEMA_DIR') ?? BUNDLED_SCHEMA_DIR,
    downloadDir: envString(env, 'PGW_DOWNLOAD_DIR') ?? file.downloads ?? join(home, 'downloads'),
    configPath: text === undefined ? undefined : path,

    lark: {
      appId:
        envString(env, 'LARK_APP_ID') ??
        file.lark.appId ??
        fail('an app id is required: set lark.appId in the config file, or LARK_APP_ID'),
      // Environment only, and refused in the file. See the note at the top.
      appSecret: envString(env, 'LARK_APP_SECRET') ?? fail('LARK_APP_SECRET is required'),
      ...domainOf(envString(env, 'LARK_DOMAIN') ?? file.lark.domain),
    },

    auth: {
      ownerOpenId,
      // The owner is always included. An allowlist that excludes the owner locks
      // out the only person who can fix it, and it is not editable from chat.
      allowTalk: unique([ownerOpenId, ...allowTalk]),
      allowOperate: unique([ownerOpenId, ...allowOperate]),
      allowChats: envList(env, 'PGW_ALLOW_CHATS') ?? file.auth.chats,
      allowDirectMessages: envFlag(env, 'PGW_ALLOW_DM') ?? file.auth.directMessages ?? true,
      // Default false. `@all` is a room-wide notification, not an instruction, and
      // treating it as one makes the bot answer announcements.
      allowMentionAll: envFlag(env, 'PGW_ALLOW_MENTION_ALL') ?? file.auth.mentionAll ?? false,
    },

    agent: {
      command,
      args,
      env: agentEnv(env, file.agent.passEnv),
    },

    workspaceDir,
    maxLiveSessions: envInteger(env, 'PGW_MAX_LIVE_SESSIONS') ?? file.maxLiveSessions ?? 8,
  };
}

// ---------------------------------------------------------------------------
// The agent's environment
// ---------------------------------------------------------------------------

/**
 * `PGW_AGENT_ENV_FOO=bar` becomes `FOO=bar` for the agent.
 *
 * Opt-in by prefix rather than by pass-through, because forwarding the gateway's
 * whole environment would hand the agent the Feishu app secret -- the one
 * credential it must never hold, since an agent with it can post as the bot and
 * answer its own approval requests.
 */
const AGENT_ENV_PREFIX = 'PGW_AGENT_ENV_';

/**
 * Names the gateway may forward verbatim, listed in the file as `agent.passEnv`.
 *
 * The file names the variable; the value still comes from the environment. This
 * exists because the prefixed spelling has to be typed twice -- once where the
 * credential already lives, once with the prefix -- and a typo in the second copy
 * forwards nothing at all, which surfaces much later as the agent failing to
 * authenticate. A declared name that is not set is therefore an error here.
 */
function agentEnv(env: Env, passEnv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};

  for (const name of passEnv) {
    if (name.startsWith('PGW_') || name.startsWith('LARK_')) {
      // The gateway's own configuration, and in the Lark case its identity. An
      // agent holding those can reconfigure or impersonate the gateway.
      throw new ConfigError(`agent.passEnv must not forward ${name}: it belongs to the gateway`);
    }
    const value = env[name];
    if (value === undefined || value === '') {
      throw new ConfigError(`agent.passEnv names ${name}, which is not set in the environment`);
    }
    out[name] = value;
  }

  // Prefixed values are applied second, so a variable set explicitly for the agent
  // overrides the one the gateway happens to be running with.
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(AGENT_ENV_PREFIX) || value === undefined) continue;
    const name = key.slice(AGENT_ENV_PREFIX.length);
    if (name === '') continue;
    out[name] = value;
  }

  return out;
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

interface FileConfig {
  workspace: string | undefined;
  db: string | undefined;
  downloads: string | undefined;
  maxLiveSessions: number | undefined;
  lark: { appId: string | undefined; domain: string | undefined };
  auth: {
    owner: string | undefined;
    talk: readonly string[];
    operate: readonly string[];
    chats: readonly string[];
    directMessages: boolean | undefined;
    mentionAll: boolean | undefined;
  };
  agent: { command: string | undefined; args: readonly string[]; passEnv: readonly string[] };
}

function emptyFile(): FileConfig {
  return {
    workspace: undefined,
    db: undefined,
    downloads: undefined,
    maxLiveSessions: undefined,
    lark: { appId: undefined, domain: undefined },
    auth: {
      owner: undefined,
      talk: [],
      operate: [],
      chats: [],
      directMessages: undefined,
      mentionAll: undefined,
    },
    agent: { command: undefined, args: [], passEnv: [] },
  };
}

/**
 * Keys that would mean a credential is sitting in the file.
 *
 * Matched on the name with separators removed, so `app_secret`, `appSecret` and
 * `APP-SECRET` are all caught. Refusing is the point: accepting the value would
 * work, which is exactly why nobody would notice the file had become a secret
 * store until it was in a backup or a commit.
 */
const SECRET_KEY = /secret|password|passwd|token|credential|apikey|privatekey/i;

function parseFile(path: string, text: string): FileConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${path} is not valid YAML: ${(err as Error).message}`);
  }
  // An empty file is a legitimate starting point, and YAML parses it as null.
  if (parsed === null || parsed === undefined) return emptyFile();
  const root = section(path, '', parsed);

  const out = emptyFile();
  const larkRaw = subsection(path, root, 'lark');
  const authRaw = subsection(path, root, 'auth');
  const agentRaw = subsection(path, root, 'agent');

  reject(path, '', root, ['workspace', 'db', 'downloads', 'maxLiveSessions', 'lark', 'auth', 'agent']);
  reject(path, 'lark', larkRaw, ['appId', 'domain']);
  reject(path, 'auth', authRaw, [
    'owner',
    'talk',
    'operate',
    'chats',
    'directMessages',
    'mentionAll',
  ]);
  reject(path, 'agent', agentRaw, ['command', 'args', 'passEnv']);

  out.workspace = str(path, 'workspace', root['workspace']);
  out.db = str(path, 'db', root['db']);
  out.downloads = str(path, 'downloads', root['downloads']);
  out.maxLiveSessions = positiveInt(path, 'maxLiveSessions', root['maxLiveSessions']);

  out.lark = {
    appId: str(path, 'lark.appId', larkRaw['appId']),
    domain: str(path, 'lark.domain', larkRaw['domain']),
  };

  out.auth = {
    owner: str(path, 'auth.owner', authRaw['owner']),
    talk: strings(path, 'auth.talk', authRaw['talk']),
    operate: strings(path, 'auth.operate', authRaw['operate']),
    chats: strings(path, 'auth.chats', authRaw['chats']),
    directMessages: bool(path, 'auth.directMessages', authRaw['directMessages']),
    mentionAll: bool(path, 'auth.mentionAll', authRaw['mentionAll']),
  };

  out.agent = {
    command: str(path, 'agent.command', agentRaw['command']),
    // A list or one string, because `args: --acp --debug` is what people write.
    args: Array.isArray(agentRaw['args'])
      ? strings(path, 'agent.args', agentRaw['args'])
      : shellWords(str(path, 'agent.args', agentRaw['args']) ?? ''),
    passEnv: strings(path, 'agent.passEnv', agentRaw['passEnv']),
  };

  return out;
}

/** Reject unknown keys, and any key that means a credential is in the file. */
function reject(
  path: string,
  prefix: string,
  values: Record<string, unknown>,
  known: readonly string[],
): void {
  const flat = (key: string): string => (prefix === '' ? key : `${prefix}.${key}`);
  for (const key of Object.keys(values)) {
    if (SECRET_KEY.test(key.replace(/[-_]/g, ''))) {
      throw new ConfigError(
        `${path}: ${flat(key)} looks like a credential, and the config file must not hold one. ` +
          'Set it in the environment instead (LARK_APP_SECRET for the app secret, ' +
          'PGW_AGENT_ENV_* for the agent, or name it in agent.passEnv).',
      );
    }
    if (key === 'env') {
      throw new ConfigError(
        `${path}: ${flat(key)} would put values in the file. List the variable names in ` +
          'agent.passEnv, or set PGW_AGENT_ENV_<NAME> in the environment.',
      );
    }
    if (!known.includes(key)) {
      throw new ConfigError(`${path}: unknown setting ${flat(key)} (known: ${known.join(', ')})`);
    }
  }
}

function section(path: string, prefix: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path}: ${prefix === '' ? 'the file' : prefix} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function subsection(
  path: string,
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = root[key];
  if (value === undefined || value === null) return {};
  return section(path, key, value);
}

function str(path: string, key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${path}: ${key} must be a non-empty string`);
  }
  return value.trim();
}

function strings(path: string, key: string, value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path}: ${key} must be a list`);
  return unique(
    value.map((entry, i) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new ConfigError(`${path}: ${key}[${i}] must be a non-empty string`);
      }
      return entry.trim();
    }),
  );
}

function bool(path: string, key: string, value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${path}: ${key} must be true or false, got ${JSON.stringify(value)}`);
  }
  return value;
}

function positiveInt(path: string, key: string, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${path}: ${key} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

/** Absent and empty are the same mistake: an empty app secret connects and hangs. */
function envString(env: Env, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

/**
 * A comma-separated list, replacing whatever the file said.
 *
 * `PGW_ALLOW_TALK=` -- set but empty -- is a deliberate "nobody but the owner",
 * which is why it returns an empty list rather than falling through to the file.
 */
function envList(env: Env, key: string): readonly string[] | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  return unique(
    raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== ''),
  );
}

function envFlag(env: Env, key: string): boolean | undefined {
  const value = envString(env, key);
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  // Not defaulted. A typo'd flag silently taking its default is how a setting
  // someone deliberately changed turns out never to have applied.
  throw new ConfigError(`${key}: expected a boolean, got ${JSON.stringify(value)}`);
}

function envInteger(env: Env, key: string): number | undefined {
  const value = envString(env, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${key}: expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------

function domainOf(domain: string | undefined): { domain?: string } {
  return domain === undefined ? {} : { domain };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function fail(message: string): never {
  throw new ConfigError(message);
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
