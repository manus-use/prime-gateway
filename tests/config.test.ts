import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError, loadConfig, type FileReader } from '../src/config.js';

/**
 * Configuration is where a security property is easiest to lose by accident: a
 * default that reads as "nothing configured" and means "no restrictions", a typo'd
 * key that silently takes its default, or a credential that ends up in a file the
 * unsandboxed agent can read.
 *
 * `loadConfig` takes both the environment and the file reader as parameters, so all
 * of that is testable without touching `process.env` or the disk. One test at the
 * bottom uses the real reader, because the default path is derived and a loader
 * that reads the wrong file looks exactly like one whose settings are ignored.
 */

const OWNER = 'ou_owner';
const HOME = '/var/lib/prime';
const DEFAULT_PATH = join(HOME, 'config.yaml');

/** The minimum environment: the secret, which the file may never hold. */
const BASE: Record<string, string> = {
  PGW_HOME: HOME,
  LARK_APP_SECRET: 'app-secret',
};

/** A complete file. Tests override the one section they are about. */
const BASE_FILE: Record<string, unknown> = {
  workspace: '/srv/repo',
  lark: { appId: 'cli_app' },
  auth: { owner: OWNER },
  agent: { command: 'claude-agent-acp' },
};

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The base file with `over` merged one level deep, serialized.
 *
 * Built from an object rather than by concatenating YAML text, because appending a
 * second `auth:` block produces a duplicate-key parse error instead of the setting
 * under test.
 */
function yamlFile(over: Record<string, unknown> = {}): string {
  const merged: Record<string, unknown> = { ...BASE_FILE };
  for (const [key, value] of Object.entries(over)) {
    const base = merged[key];
    merged[key] = isMapping(value) && isMapping(base) ? { ...base, ...value } : value;
  }
  return stringify(merged);
}

const FULL_FILE = yamlFile();

function reader(files: Record<string, string>): FileReader & { asked: string[] } {
  const asked: string[] = [];
  const fn = (path: string): string | undefined => {
    asked.push(path);
    return files[path];
  };
  return Object.assign(fn, { asked });
}

/** Load with the standard file at the default path. */
function load(env: Record<string, string | undefined> = {}, file: string = FULL_FILE) {
  return loadConfig({ ...BASE, ...env }, reader({ [DEFAULT_PATH]: file }));
}

/** Load with no file at all, so every value has to come from the environment. */
function loadEnvOnly(env: Record<string, string | undefined>) {
  return loadConfig({ ...BASE, ...env }, reader({}));
}

const ENV_ONLY: Record<string, string> = {
  PGW_OWNER_OPEN_ID: OWNER,
  PGW_WORKSPACE: '/srv/repo',
  PGW_AGENT_COMMAND: 'claude-agent-acp',
  LARK_APP_ID: 'cli_app',
};

describe('loadConfig: where settings come from', () => {
  it('runs from the environment alone, with no file', () => {
    // The container deployment. A missing file at the default location is ordinary.
    const cfg = loadEnvOnly(ENV_ONLY);
    expect(cfg.workspaceDir).toBe('/srv/repo');
    expect(cfg.auth.ownerOpenId).toBe(OWNER);
    expect(cfg.agent.command).toBe('claude-agent-acp');
    expect(cfg.configPath).toBeUndefined();
  });

  it('runs from the file, with only the secret in the environment', () => {
    const cfg = load();
    expect(cfg.workspaceDir).toBe('/srv/repo');
    expect(cfg.lark.appId).toBe('cli_app');
    expect(cfg.lark.appSecret).toBe('app-secret');
    expect(cfg.configPath).toBe(DEFAULT_PATH);
  });

  it('lets the environment win over every setting in the file', () => {
    // The emergency path: an override must not require editing a file, because the
    // reason for the override is often that the file is what is wrong.
    const cfg = load({
      PGW_WORKSPACE: '/srv/other',
      PGW_OWNER_OPEN_ID: 'ou_new_owner',
      PGW_AGENT_COMMAND: 'gemini',
      PGW_MAX_LIVE_SESSIONS: '2',
      LARK_APP_ID: 'cli_other',
      LARK_DOMAIN: 'https://open.larksuite.com',
    });
    expect(cfg.workspaceDir).toBe('/srv/other');
    expect(cfg.auth.ownerOpenId).toBe('ou_new_owner');
    expect(cfg.agent.command).toBe('gemini');
    expect(cfg.maxLiveSessions).toBe(2);
    expect(cfg.lark.appId).toBe('cli_other');
    expect(cfg.lark.domain).toBe('https://open.larksuite.com');
  });

  it('looks for the file under PGW_HOME, and reads the one PGW_CONFIG names', () => {
    const byDefault = reader({});
    loadConfig({ ...BASE, ...ENV_ONLY }, byDefault);
    expect(byDefault.asked).toEqual([DEFAULT_PATH]);

    const named = reader({ '/etc/prime/gw.yaml': FULL_FILE });
    const cfg = loadConfig({ ...BASE, PGW_CONFIG: '/etc/prime/gw.yaml' }, named);
    expect(named.asked).toEqual(['/etc/prime/gw.yaml']);
    expect(cfg.configPath).toBe('/etc/prime/gw.yaml');
  });

  it('refuses a named file that is not there', () => {
    // Silently falling back to the environment would start a gateway with none of
    // the settings the operator believed they had written down.
    expect(() => loadConfig({ ...BASE, PGW_CONFIG: '/etc/nope.yaml' }, reader({}))).toThrow(
      /PGW_CONFIG points at \/etc\/nope\.yaml, which does not exist/,
    );
  });

  it('treats an empty file as no settings rather than as an error', () => {
    const cfg = loadConfig({ ...BASE, ...ENV_ONLY }, reader({ [DEFAULT_PATH]: '\n# nothing yet\n' }));
    expect(cfg.workspaceDir).toBe('/srv/repo');
  });
});

describe('loadConfig: required values', () => {
  it('names both sources for a value it cannot find', () => {
    expect(() => loadEnvOnly({ ...ENV_ONLY, PGW_OWNER_OPEN_ID: undefined })).toThrow(
      /auth\.owner in the config file, or PGW_OWNER_OPEN_ID/,
    );
    expect(() => loadEnvOnly({ ...ENV_ONLY, PGW_WORKSPACE: undefined })).toThrow(
      /workspace in the config file, or PGW_WORKSPACE/,
    );
    expect(() => loadEnvOnly({ ...ENV_ONLY, PGW_AGENT_COMMAND: undefined })).toThrow(
      /agent\.command in the config file, or PGW_AGENT_COMMAND/,
    );
    expect(() => loadEnvOnly({ ...ENV_ONLY, LARK_APP_ID: undefined })).toThrow(
      /lark\.appId in the config file, or LARK_APP_ID/,
    );
  });

  it('requires the app secret from the environment and nowhere else', () => {
    expect(() => load({ LARK_APP_SECRET: undefined })).toThrow('LARK_APP_SECRET is required');
    // An unset variable and one set to the empty string are the same mistake, and
    // an empty app secret produces a bot that connects and then does nothing.
    expect(() => load({ LARK_APP_SECRET: '' })).toThrow(ConfigError);
  });

  it('refuses a relative workspace, from either source', () => {
    // Relative resolves against whatever cwd the service manager set, so the
    // workspace would depend on how the process was launched.
    expect(() => load({ PGW_WORKSPACE: './repo' })).toThrow('must be an absolute path');
    expect(() => load({}, yamlFile({ workspace: './repo' }))).toThrow('must be an absolute path');
  });

  it('derives the paths that are not set from PGW_HOME', () => {
    const cfg = load();
    expect(cfg.dbPath).toBe(join(HOME, 'gateway.db'));
    expect(cfg.downloadDir).toBe(join(HOME, 'downloads'));
  });

  it('lets each derived path be overridden from either source', () => {
    const fromFile = load({}, yamlFile({ db: '/tmp/db.sqlite', downloads: '/tmp/dl' }));
    expect(fromFile.dbPath).toBe('/tmp/db.sqlite');
    expect(fromFile.downloadDir).toBe('/tmp/dl');

    const fromEnv = load({ PGW_DB: '/tmp/env.sqlite', PGW_DOWNLOAD_DIR: '/tmp/env-dl' });
    expect(fromEnv.dbPath).toBe('/tmp/env.sqlite');
    expect(fromEnv.downloadDir).toBe('/tmp/env-dl');
  });

  it('finds the bundled migrations without help from the working directory', () => {
    // The service manager chooses the cwd. Resolving migrations against it means a
    // gateway that boots from one directory and fails to find its schema from
    // another -- and an unmigrated database is a first-message failure, not a
    // start-up one.
    const cfg = load();
    expect(isAbsolute(cfg.schemaDir)).toBe(true);
    expect(existsSync(join(cfg.schemaDir, '001_initial.sql'))).toBe(true);
    expect(load({ PGW_SCHEMA_DIR: '/tmp/schema' }).schemaDir).toBe('/tmp/schema');
    // Not a file setting: it points at migrations belonging to this build, which is
    // packaging rather than operations.
    expect(() => load({}, yamlFile({ schemaDir: '/tmp/schema' }))).toThrow('unknown setting');
  });

  it('omits the Lark domain rather than guessing one', () => {
    expect('domain' in load().lark).toBe(false);
    expect(load({}, yamlFile({ lark: { domain: 'https://open.larksuite.com' } })).lark.domain).toBe(
      'https://open.larksuite.com',
    );
  });
});

describe('loadConfig: the file must not become a secret store', () => {
  it('refuses a credential-shaped key and says where it belongs', () => {
    // The agent is not sandboxed and runs as the same user, so anything on disk it
    // can read. Accepting these would work, which is why nobody would notice the
    // file had become a secret store until it was in a backup or a commit.
    for (const key of ['appSecret', 'app_secret', 'APP-SECRET', 'apiKey', 'token', 'password']) {
      expect(() => load({}, yamlFile({ lark: { [key]: 'oops' } }))).toThrow(
        /looks like a credential/,
      );
    }
    expect(() => load({}, yamlFile({ lark: { appSecret: 'oops' } }))).toThrow(/LARK_APP_SECRET/);
  });

  it('refuses agent.env, pointing at the two ways to pass a value', () => {
    expect(() => load({}, yamlFile({ agent: { env: { ANTHROPIC_API_KEY: 'sk-oops' } } }))).toThrow(
      /agent\.passEnv, or set PGW_AGENT_ENV_/,
    );
  });
});

describe('loadConfig: the file is validated, not trusted', () => {
  it('reports invalid YAML against the file it came from', () => {
    expect(() => load({}, 'workspace: [unclosed\n')).toThrow(
      new RegExp(`${DEFAULT_PATH.replace(/\//g, '\\/')} is not valid YAML`),
    );
  });

  it('refuses a file that is not a mapping', () => {
    expect(() => load({}, '- one\n- two\n')).toThrow('the file must be a mapping');
    expect(() => load({}, 'auth: not-a-mapping\n')).toThrow('auth must be a mapping');
  });

  it('refuses an unknown setting instead of ignoring it', () => {
    // A typo'd key silently taking its default is how a setting someone
    // deliberately changed turns out never to have applied. For the auth keys that
    // failure is silent *and* permissive.
    expect(() => load({}, yamlFile({ workspce: '/srv/repo' }))).toThrow(
      /unknown setting workspce \(known: workspace, /,
    );
    expect(() => load({}, yamlFile({ auth: { talkk: ['ou_a'] } }))).toThrow(
      'unknown setting auth.talkk',
    );
  });

  it('refuses a value of the wrong type', () => {
    expect(() => load({}, yamlFile({ auth: { talk: 'ou_a' } }))).toThrow('auth.talk must be a list');
    expect(() => load({}, yamlFile({ auth: { talk: ['ou_a', ''] } }))).toThrow(
      'auth.talk[1] must be a non-empty string',
    );
    expect(() => load({}, yamlFile({ auth: { mentionAll: 'yes' } }))).toThrow(
      'auth.mentionAll must be true or false',
    );
    expect(() => load({}, yamlFile({ maxLiveSessions: 0 }))).toThrow(
      'maxLiveSessions must be a positive integer',
    );
    expect(() => load({}, yamlFile({ maxLiveSessions: 2.5 }))).toThrow('positive integer');
    expect(() => load({}, yamlFile({ workspace: 12 }))).toThrow(
      'workspace must be a non-empty string',
    );
  });
});

describe('loadConfig: allowlists', () => {
  it('always includes the owner, in both tiers', () => {
    const cfg = load({}, yamlFile({ auth: { talk: ['ou_a'], operate: ['ou_a'] } }));
    // An allowlist that excludes the owner locks out the only person who can fix
    // it, and it is not editable from chat.
    expect(cfg.auth.allowTalk).toEqual([OWNER, 'ou_a']);
    expect(cfg.auth.allowOperate).toEqual([OWNER, 'ou_a']);
  });

  it('is closed when nothing is listed', () => {
    const cfg = load();
    // Empty means closed, not unrestricted -- everyone except the owner.
    expect(cfg.auth.allowTalk).toEqual([OWNER]);
    expect(cfg.auth.allowChats).toEqual([]);
  });

  it('trims, drops blanks and de-duplicates, from either source', () => {
    const fromFile = load({}, yamlFile({ auth: { talk: [' ou_a ', 'ou_b', 'ou_a'] } }));
    expect(fromFile.auth.allowTalk).toEqual([OWNER, 'ou_a', 'ou_b']);

    const fromEnv = load({ PGW_ALLOW_TALK: ' ou_a , ,ou_b,ou_a ' });
    expect(fromEnv.auth.allowTalk).toEqual([OWNER, 'ou_a', 'ou_b']);
  });

  it('replaces a list from the environment instead of merging it', () => {
    // Merging would leave no way to revoke: the removed id stays in the file and
    // there is no spelling of "not these" for an emergency lockdown.
    const cfg = load({ PGW_ALLOW_TALK: 'ou_c' }, yamlFile({ auth: { talk: ['ou_a', 'ou_b'] } }));
    expect(cfg.auth.allowTalk).toEqual([OWNER, 'ou_c']);
  });

  it('reads a set-but-empty list as owner-only, deliberately', () => {
    const cfg = load({ PGW_ALLOW_TALK: '' }, yamlFile({ auth: { talk: ['ou_a'] } }));
    expect(cfg.auth.allowTalk).toEqual([OWNER]);
  });

  it('reads an empty chat allowlist as any chat, which is the documented meaning', () => {
    expect(load().auth.allowChats).toEqual([]);
    expect(load({ PGW_ALLOW_CHATS: 'oc_1,oc_2' }).auth.allowChats).toEqual(['oc_1', 'oc_2']);
    expect(load({}, yamlFile({ auth: { chats: ['oc_1'] } })).auth.allowChats).toEqual(['oc_1']);
  });
});

describe('loadConfig: flags and numbers', () => {
  it('defaults @all to off and direct messages to on', () => {
    const cfg = load();
    // `@all` is a room-wide notification, not an instruction.
    expect(cfg.auth.allowMentionAll).toBe(false);
    expect(cfg.auth.allowDirectMessages).toBe(true);
  });

  it('takes booleans from the file as booleans', () => {
    const cfg = load({}, yamlFile({ auth: { mentionAll: true, directMessages: false } }));
    expect(cfg.auth.allowMentionAll).toBe(true);
    expect(cfg.auth.allowDirectMessages).toBe(false);
  });

  it('accepts the spellings people actually type in the environment', () => {
    for (const yes of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(load({ PGW_ALLOW_MENTION_ALL: yes }).auth.allowMentionAll).toBe(true);
    }
    for (const no of ['0', 'false', 'No', 'off']) {
      expect(load({ PGW_ALLOW_DM: no }).auth.allowDirectMessages).toBe(false);
    }
  });

  it('refuses a flag it cannot read instead of defaulting it', () => {
    expect(() => load({ PGW_ALLOW_MENTION_ALL: 'ture' })).toThrow('expected a boolean');
  });

  it('refuses a session cap that is not a positive integer', () => {
    expect(load().maxLiveSessions).toBe(8);
    expect(load({}, yamlFile({ maxLiveSessions: 3 })).maxLiveSessions).toBe(3);
    for (const bad of ['0', '-1', '2.5', 'many']) {
      expect(() => load({ PGW_MAX_LIVE_SESSIONS: bad })).toThrow('positive integer');
    }
  });
});

describe('loadConfig: the agent process', () => {
  it('forwards a variable the file names, taking the value from the environment', () => {
    const cfg = load(
      { ANTHROPIC_API_KEY: 'sk-test' },
      yamlFile({ agent: { passEnv: ['ANTHROPIC_API_KEY'] } }),
    );
    expect(cfg.agent.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
  });

  it('refuses to forward a name that is not set, because that is the typo case', () => {
    // Forwarding nothing surfaces much later as the agent failing to authenticate,
    // which reads as a credential problem rather than a configuration one.
    expect(() => load({}, yamlFile({ agent: { passEnv: ['ANTHROPIC_API_KEY'] } }))).toThrow(
      /passEnv names ANTHROPIC_API_KEY, which is not set/,
    );
  });

  it('refuses to forward the gateway its own configuration or identity', () => {
    // An agent holding the Feishu secret can post as the bot and answer its own
    // approval requests.
    expect(() => load({}, yamlFile({ agent: { passEnv: ['LARK_APP_SECRET'] } }))).toThrow(
      /must not forward LARK_APP_SECRET/,
    );
    expect(() => load({}, yamlFile({ agent: { passEnv: ['PGW_HOME'] } }))).toThrow(
      /must not forward PGW_HOME/,
    );
  });

  it('forwards only environment variables that opted in by prefix', () => {
    const cfg = load({
      PGW_AGENT_ENV_ANTHROPIC_API_KEY: 'sk-test',
      PGW_AGENT_ENV_: 'nameless',
      SOME_OTHER_SECRET: 'nope',
    });
    // Forwarding the whole environment would hand the agent the Feishu app secret.
    expect(cfg.agent.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(Object.values(cfg.agent.env)).not.toContain('app-secret');
  });

  it('lets a prefixed variable override one passed through by name', () => {
    const cfg = load(
      { ANTHROPIC_API_KEY: 'sk-ambient', PGW_AGENT_ENV_ANTHROPIC_API_KEY: 'sk-for-the-agent' },
      yamlFile({ agent: { passEnv: ['ANTHROPIC_API_KEY'] } }),
    );
    // The prefixed spelling exists to say "this value is for the agent", so it wins
    // over whatever the gateway happens to be running with.
    expect(cfg.agent.env).toEqual({ ANTHROPIC_API_KEY: 'sk-for-the-agent' });
  });

  it('refuses a subcommand written into the command, from either source', () => {
    // `command: bytesec acp` asks for a file whose name contains a space, because
    // the agent is spawned with `shell: false`. It fails as an ENOENT at the first
    // prompt -- long after boot, and reported as the agent not starting.
    expect(() => load({}, yamlFile({ agent: { command: 'bytesec acp' } }))).toThrow(
      /contains a space, and is not a path/,
    );
    // And says what to write instead, since the fix is not obvious from the symptom.
    expect(() => load({ PGW_AGENT_COMMAND: 'bytesec acp' })).toThrow(
      /command: bytesec, args: \[acp\]/,
    );
  });

  it('allows a space in an absolute path, which is a real binary name', () => {
    const cfg = load({ PGW_AGENT_COMMAND: '/Applications/My App/bin/agent' });
    expect(cfg.agent.command).toBe('/Applications/My App/bin/agent');
  });

  it('accepts arguments as a list or as one string', () => {
    expect(load({}, yamlFile({ agent: { args: ['--acp', '--debug'] } })).agent.args).toEqual([
      '--acp',
      '--debug',
    ]);
    expect(
      load({}, yamlFile({ agent: { args: '--acp --flag "two words"' } })).agent.args,
    ).toEqual(['--acp', '--flag', 'two words']);
    expect(load({ PGW_AGENT_ARGS: '--acp --one' }).agent.args).toEqual(['--acp', '--one']);
  });

  it('does not pretend to be a shell', () => {
    // The agent is spawned with `shell: false`. Accepting expansion here and
    // dropping it there is the half-support that looks like it works.
    expect(load({ PGW_AGENT_ARGS: '$(whoami) $HOME' }).agent.args).toEqual(['$(whoami)', '$HOME']);
  });

  it('defaults to no arguments rather than to a guess', () => {
    expect(load().agent.args).toEqual([]);
    expect(load({ PGW_AGENT_ARGS: '   ' }).agent.args).toEqual([]);
  });
});

describe('loadConfig: against a real file', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it('reads config.yaml from PGW_HOME with the default reader', () => {
    // The one test that exercises path derivation and the reader together. The
    // default location is computed, and a loader reading the wrong file is
    // indistinguishable from one whose settings are being ignored.
    const dir = mkdtempSync(join(tmpdir(), 'prime-config-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'config.yaml'), FULL_FILE);

    const cfg = loadConfig({ PGW_HOME: dir, LARK_APP_SECRET: 'app-secret' });
    expect(cfg.configPath).toBe(join(dir, 'config.yaml'));
    expect(cfg.workspaceDir).toBe('/srv/repo');
    expect(cfg.dbPath).toBe(join(dir, 'gateway.db'));
  });

  it('loads the example file the README tells people to copy', () => {
    // The example is documentation that can rot into a file that does not load: a key
    // renamed here, or one of this loader's own refusals tripped by a comment example.
    const dir = mkdtempSync(join(tmpdir(), 'prime-config-'));
    dirs.push(dir);
    copyFileSync(
      fileURLToPath(new URL('../config.example.yaml', import.meta.url)),
      join(dir, 'config.yaml'),
    );

    // Nothing in the environment but the secret, which is the whole point: an
    // example that only loads once you have also guessed at some variable is an
    // example that fails on the first copy.
    const cfg = loadConfig({ PGW_HOME: dir, LARK_APP_SECRET: 'app-secret' });
    expect(cfg.auth.ownerOpenId).toMatch(/^ou_/);
    expect(cfg.agent.env).toEqual({});
    expect(cfg.maxLiveSessions).toBe(8);
  });

  it('starts without a file when the environment carries everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-config-'));
    dirs.push(dir);
    const cfg = loadConfig({ PGW_HOME: dir, LARK_APP_SECRET: 'app-secret', ...ENV_ONLY });
    expect(cfg.configPath).toBeUndefined();
  });
});
