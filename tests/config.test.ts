import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

/**
 * Configuration is where a security property is easiest to lose by accident: a
 * default that reads as "nothing configured" and means "no restrictions", or a
 * pass-through that hands the agent the one credential it must never hold.
 *
 * `loadConfig` takes its environment as a parameter, so all of that is testable
 * without touching `process.env`.
 */

const OWNER = 'ou_owner';

const BASE: Record<string, string> = {
  PRIME_HOME: '/var/lib/prime',
  PRIME_OWNER_OPEN_ID: OWNER,
  PRIME_WORKSPACE: '/srv/repo',
  PRIME_AGENT_COMMAND: 'claude',
  LARK_APP_ID: 'cli_app',
  LARK_APP_SECRET: 'secret',
};

function load(over: Record<string, string | undefined> = {}) {
  return loadConfig({ ...BASE, ...over });
}

describe('loadConfig: required values', () => {
  it('names the variable that is missing', () => {
    for (const key of Object.keys(BASE)) {
      if (key === 'PRIME_HOME') continue; // has a fallback
      expect(() => load({ [key]: undefined })).toThrow(new RegExp(`${key} is required`));
    }
  });

  it('treats an empty string as absent', () => {
    // An unset variable and one set to the empty string are the same mistake, and
    // an empty app secret produces a bot that connects and then does nothing.
    expect(() => load({ LARK_APP_SECRET: '' })).toThrow(ConfigError);
  });

  it('refuses a relative workspace path', () => {
    // Relative resolves against whatever cwd the service manager set, so the
    // workspace would depend on how the process was launched.
    expect(() => load({ PRIME_WORKSPACE: './repo' })).toThrow('absolute path');
  });

  it('derives the paths that are not set from PRIME_HOME', () => {
    const cfg = load();
    expect(cfg.dbPath).toBe(join('/var/lib/prime', 'gateway.db'));
    expect(cfg.downloadDir).toBe(join('/var/lib/prime', 'downloads'));
  });

  it('lets each derived path be overridden on its own', () => {
    const cfg = load({ PRIME_DB: '/tmp/db.sqlite', PRIME_DOWNLOAD_DIR: '/tmp/dl' });
    expect(cfg.dbPath).toBe('/tmp/db.sqlite');
    expect(cfg.downloadDir).toBe('/tmp/dl');
  });

  it('finds the bundled migrations without help from the working directory', () => {
    // The service manager chooses the cwd. Resolving migrations against it means a
    // gateway that boots from one directory and fails to find its schema from
    // another -- and an unmigrated database is a first-message failure, not a
    // start-up one.
    const cfg = load();
    expect(isAbsolute(cfg.schemaDir)).toBe(true);
    expect(existsSync(join(cfg.schemaDir, '001_initial.sql'))).toBe(true);
    expect(load({ PRIME_SCHEMA_DIR: '/tmp/schema' }).schemaDir).toBe('/tmp/schema');
  });

  it('omits the Lark domain rather than guessing one', () => {
    expect('domain' in load().lark).toBe(false);
    expect(load({ LARK_DOMAIN: 'https://open.larksuite.com' }).lark.domain).toBe(
      'https://open.larksuite.com',
    );
  });
});

describe('loadConfig: allowlists', () => {
  it('always includes the owner, in both tiers', () => {
    const cfg = load({ PRIME_ALLOW_TALK: 'ou_a', PRIME_ALLOW_OPERATE: 'ou_a' });
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

  it('trims, drops blanks and de-duplicates a list', () => {
    const cfg = load({ PRIME_ALLOW_TALK: ' ou_a , ,ou_b,ou_a ' });
    expect(cfg.auth.allowTalk).toEqual([OWNER, 'ou_a', 'ou_b']);
  });

  it('reads an empty chat allowlist as any chat, which is the documented meaning', () => {
    expect(load({ PRIME_ALLOW_CHATS: '  ' }).auth.allowChats).toEqual([]);
    expect(load({ PRIME_ALLOW_CHATS: 'oc_1,oc_2' }).auth.allowChats).toEqual(['oc_1', 'oc_2']);
  });
});

describe('loadConfig: flags and numbers', () => {
  it('defaults @all to off and direct messages to on', () => {
    const cfg = load();
    // `@all` is a room-wide notification, not an instruction.
    expect(cfg.auth.allowMentionAll).toBe(false);
    expect(cfg.auth.allowDirectMessages).toBe(true);
  });

  it('accepts the spellings people actually type', () => {
    for (const yes of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(load({ PRIME_ALLOW_MENTION_ALL: yes }).auth.allowMentionAll).toBe(true);
    }
    for (const no of ['0', 'false', 'No', 'off']) {
      expect(load({ PRIME_ALLOW_DM: no }).auth.allowDirectMessages).toBe(false);
    }
  });

  it('refuses a flag it cannot read instead of defaulting it', () => {
    // A typo'd flag silently taking its default is how a setting someone
    // deliberately changed turns out never to have applied.
    expect(() => load({ PRIME_ALLOW_MENTION_ALL: 'ture' })).toThrow('expected a boolean');
  });

  it('refuses a session cap that is not a positive integer', () => {
    expect(load().maxLiveSessions).toBe(8);
    expect(load({ PRIME_MAX_LIVE_SESSIONS: '2' }).maxLiveSessions).toBe(2);
    for (const bad of ['0', '-1', '2.5', 'many']) {
      expect(() => load({ PRIME_MAX_LIVE_SESSIONS: bad })).toThrow('positive integer');
    }
  });
});

describe('loadConfig: the agent process', () => {
  it('forwards only variables that opted in by prefix', () => {
    const cfg = load({
      PRIME_AGENT_ENV_ANTHROPIC_API_KEY: 'sk-test',
      PRIME_AGENT_ENV_: 'nameless',
      SOME_OTHER_SECRET: 'nope',
    });
    // Forwarding the whole environment would hand the agent the Feishu app secret,
    // and an agent holding that can post as the bot and answer its own approvals.
    expect(cfg.agent.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(Object.values(cfg.agent.env)).not.toContain('secret');
  });

  it('splits arguments on whitespace, honouring quotes', () => {
    const cfg = load({ PRIME_AGENT_ARGS: '--acp --flag "two words" \'single quoted\'' });
    expect(cfg.agent.args).toEqual(['--acp', '--flag', 'two words', 'single quoted']);
  });

  it('does not pretend to be a shell', () => {
    // The agent is spawned with `shell: false`. Accepting expansion here and
    // dropping it there is the half-support that looks like it works.
    const cfg = load({ PRIME_AGENT_ARGS: '$(whoami) $HOME' });
    expect(cfg.agent.args).toEqual(['$(whoami)', '$HOME']);
  });

  it('defaults to no arguments rather than to a guess', () => {
    expect(load().agent.args).toEqual([]);
    expect(load({ PRIME_AGENT_ARGS: '   ' }).agent.args).toEqual([]);
  });
});
