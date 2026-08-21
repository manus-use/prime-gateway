import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig, type GatewayConfig } from './config.js';
import { migrate, openDb, type Db } from './db/open.js';
import { sweepSeen } from './db/dedup.js';
import { LarkAdapter } from './channel/lark/adapter.js';
import { LarkInbound } from './channel/lark/inbound.js';
import { createAcpDriver } from './driver/acp/driver.js';
import { getDriver, registerDriver } from './driver/registry.js';
import { Authorizer } from './policy/auth.js';
import { Router } from './core/router.js';
import { SessionRegistry } from './core/registry.js';
import { PlainDirWorkspaces } from './core/workspace.js';
import { replyUuid } from './core/ids.js';
import { systemClock } from './time.js';

/**
 * Wiring, and the boot order.
 *
 * The order is the interesting part, and it is not arbitrary:
 *
 * 1. Open and migrate the database.
 * 2. **Reconcile** -- before the channel is connected. Reconciling after messages
 *    can arrive means racing a live turn against the code that decides what
 *    happened to the last one.
 * 3. Report what reconciliation found, to the chats that were affected. A finding
 *    nobody is told about is indistinguishable from a session that silently stopped.
 * 4. Connect.
 *
 * Shutdown runs it backwards, and drains: the last card write and the terminal
 * event both have to land, or the user is left looking at a partial answer with a
 * typing indicator on it.
 */

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly db: Db;
}

export async function createGateway(config: GatewayConfig): Promise<Gateway> {
  const note = (line: string): void => {
    // Metadata only. No message bodies, no agent text -- the log is operational,
    // and a log that quotes user content is a second copy of the data with none of
    // the retention rules.
    process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  };

  await mkdir(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  await mkdir(config.downloadDir, { recursive: true, mode: 0o700 });

  const db = openDb(config.dbPath);
  const version = migrate(db, config.schemaDir);
  note(`schema at version ${version}`);

  // Registration is process-global, so a second `createGateway` in one process --
  // which is exactly what a test suite does -- must not fail on a duplicate.
  if (!getDriverSafely('acp')) {
    registerDriver('acp', () =>
      createAcpDriver({
        command: config.agent.command,
        args: config.agent.args,
        env: config.agent.env,
        clientName: 'prime-gateway',
      }),
    );
  }
  const driver = getDriver('acp');

  const adapter = new LarkAdapter({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    // The agent may only attach files from its own workspace. Without this the
    // SDK enforces a blocklist only, which does not stop it reading elsewhere.
    allowedFileDirs: [config.workspaceDir],
    ...(config.lark.domain === undefined ? {} : { domain: config.lark.domain }),
  });

  const authorizer = new Authorizer({
    allowTalk: config.auth.allowTalk,
    allowOperate: config.auth.allowOperate,
    ownerOpenId: config.auth.ownerOpenId,
    allowChats: config.auth.allowChats,
    allowBots: [],
    allowDirectMessages: config.auth.allowDirectMessages,
    allowMentionAll: config.auth.allowMentionAll,
  });

  const registry = new SessionRegistry({
    db,
    driver,
    channel: adapter,
    workspaces: new PlainDirWorkspaces(config.workspaceDir),
    channelId: adapter.id,
    appId: config.lark.appId,
    maxLive: config.maxLiveSessions,
    note,
  });

  const router = new Router({
    db,
    registry,
    authorizer,
    channel: adapter,
    channelId: adapter.id,
    appId: config.lark.appId,
    note,
  });

  const inbound = new LarkInbound({
    adapter,
    router,
    config: { appId: config.lark.appId, downloadDir: config.downloadDir },
    note,
  });

  let housekeeping: NodeJS.Timeout | undefined;
  let stopped = false;

  return {
    db,

    async start(): Promise<void> {
      // Before connecting. Reconciling against a channel that is already delivering
      // means deciding what happened to the last turn while the next one runs.
      const findings = registry.reconcileBoot();
      note(`reconciled ${findings.length} session(s) needing attention`);

      await adapter.connect();
      inbound.start();
      note(`connected as ${adapter.botOpenId ?? 'unknown bot identity'}`);

      // Only now, because saying it requires a connection. Failing to deliver a
      // finding must not prevent the gateway from starting -- the session is
      // already held, and refusing to start would remove the only way to look at it.
      for (const finding of findings) {
        for (const key of finding.bindings) {
          try {
            await adapter.sendText(
              { chatId: key.conversationId, threadId: key.threadId },
              finding.message,
              replyUuid(config.lark.appId, `boot:${finding.sessionId}`, 'reconcile'),
            );
          } catch (err) {
            note(
              `reporting ${finding.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      housekeeping = setInterval(
        () => {
          try {
            // Parking is a visibility change, never a decision. There is no
            // timeout-to-default: a parked approval stays answerable forever.
            const parked = registry.park();
            const swept = sweepSeen(db, systemClock.now());
            if (parked > 0 || swept > 0) note(`housekeeping: parked ${parked}, swept ${swept}`);
          } catch (err) {
            note(`housekeeping failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        60_000,
      );
      housekeeping.unref();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;

      if (housekeeping !== undefined) clearInterval(housekeeping);
      // Stop taking work before draining it, or the drain never finishes.
      inbound.stop();
      await adapter.disconnect().catch((err: unknown) => {
        note(`disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      // Actors last. Each close awaits its final card write, which needs the
      // channel -- so this runs after disconnect only because the SDK's send path
      // survives it; a failed final write is logged, not fatal.
      await registry.closeAll();
      db.close();
    },
  };
}

function getDriverSafely(id: string): boolean {
  try {
    getDriver(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Entry point.
 *
 * Shutdown is wired to both SIGINT and SIGTERM, and is idempotent. A second signal
 * during a drain exits immediately: an operator sending it twice means "stop now",
 * and a shutdown that ignores that is one they have to `kill -9`.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const gateway = await createGateway(config);
  await gateway.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.stderr.write(`${signal} again; exiting immediately\n`);
      process.exit(1);
    }
    shuttingDown = true;
    process.stderr.write(`${signal}; draining\n`);
    gateway
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`shutdown failed: ${String(err)}\n`);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
