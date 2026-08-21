import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CardActionEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { LarkAdapter } from './adapter.js';
import type { InboundAttachment, InboundMessage, Principal } from '../../types.js';
import type { InboundCardAction, Router } from '../../core/router.js';

/**
 * Turn Lark events into the gateway's own vocabulary.
 *
 * Everything vendor-shaped stops here. The router below it sees `InboundMessage`
 * and `InboundCardAction` and nothing else, which is what keeps Feishu's quirks --
 * `root_id` versus `thread_id`, app-scoped versus tenant-scoped ids, the re-push
 * ladder -- from becoming gateway vocabulary.
 */

/** Attachment cap. Beyond this the file is skipped and the user told. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface LarkInboundConfig {
  appId: string;
  /** Directory attachments are written to. Must not be inside the workspace. */
  downloadDir: string;
}

export interface LarkInboundDeps {
  adapter: LarkAdapter;
  router: Router;
  config: LarkInboundConfig;
  note?: (line: string) => void;
}

export class LarkInbound {
  readonly #deps: LarkInboundDeps;
  readonly #note: (line: string) => void;
  #unsubscribe: (() => void) | undefined;

  constructor(deps: LarkInboundDeps) {
    this.#deps = deps;
    this.#note = deps.note ?? (() => undefined);
  }

  start(): void {
    if (this.#unsubscribe !== undefined) return;
    this.#unsubscribe = this.#deps.adapter.raw.on({
      message: (msg) => this.#onMessage(msg),
      cardAction: (evt) => this.#onCardAction(evt),
      // The SDK's own policy layer rejects before we see the message. Ours is the
      // one that decides, so this is only ever a log line -- but a silent
      // divergence between the two policies is worth being able to see.
      reject: (evt) => this.#note(`sdk rejected ${evt.messageId}: ${evt.reason}`),
      error: (err) => this.#note(`channel error: ${err.message}`),
      // A revoked token and a network blip look identical under infinite retry, so
      // reconnect churn has to be visible rather than merely survived.
      reconnecting: () => this.#note('websocket reconnecting'),
      reconnected: () => this.#note('websocket reconnected'),
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #onMessage(msg: NormalizedMessage): Promise<void> {
    // Loop guard. `undefined` means we could not tell, and "cannot tell" must not
    // resolve to "not us": a bot processing its own output loops until someone
    // notices the bill.
    const botOpenId = this.#deps.adapter.botOpenId;
    if (botOpenId === undefined) {
      this.#note(`dropping ${msg.messageId}: bot identity not yet known`);
      return;
    }
    if (msg.senderId === botOpenId) return;

    const raw = asRawMessage(msg.raw);
    const senderType = raw?.sender?.sender_type;

    const sender: Principal = {
      openId: msg.senderId,
      // The canonical human key, and the reason `includeRawEvent` is on. The
      // normalizer drops it, and `open_id` is app-scoped -- correct as a per-bot
      // handle, wrong as a durable identity.
      unionId: raw?.sender?.sender_id?.union_id ?? null,
      displayName: msg.senderName ?? null,
    };

    const message: InboundMessage = {
      messageId: msg.messageId,
      appId: this.#deps.config.appId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      // `thread_id` only, never `root_id`. Every reply in a chat carries a
      // `root_id`, so keying a session on it forks one session per reply chain --
      // and a topic group's real thread would never be found.
      threadId: msg.threadId ?? '',
      sender,
      senderIsBot: senderType === 'app' || senderType === 'bot',
      text: msg.content,
      mentionedBot: msg.mentionedBot,
      mentionAll: msg.mentionAll,
      attachments: await this.#download(msg),
      createTime: msg.createTime,
    };

    await this.#deps.router.onMessage(message);
  }

  /**
   * Fetch attachments to disk and hand the agent paths.
   *
   * Paths, never inline bytes: a 10 MB upload inlined into a prompt spends the
   * context window on data the agent can read on demand.
   *
   * A failed download is reported and skipped rather than failing the message. The
   * text a user wrote alongside a file is usually the instruction, and losing the
   * whole message because one image would not fetch is the wrong trade.
   */
  async #download(msg: NormalizedMessage): Promise<InboundAttachment[]> {
    if (msg.resources.length === 0) return [];

    const dir = join(this.#deps.config.downloadDir, msg.messageId);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const out: InboundAttachment[] = [];
    for (const resource of msg.resources) {
      const attachment: InboundAttachment = {
        fileKey: resource.fileKey,
        kind: resource.type,
        name: resource.fileName ?? null,
      };
      try {
        // The SDK's download surface has two types, not five. Anything that is not
        // an image goes down the `file` path, which is what the API itself expects.
        const buffer = await this.#deps.adapter.raw.downloadResource(
          resource.fileKey,
          resource.type === 'image' ? 'image' : 'file',
        );
        if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
          this.#note(`skipping ${resource.fileKey}: ${buffer.byteLength} bytes`);
          out.push(attachment);
          continue;
        }
        const path = join(dir, safeName(resource.fileKey, resource.fileName));
        await writeFile(path, buffer, { mode: 0o600 });
        out.push({ ...attachment, localPath: path });
      } catch (err) {
        this.#note(
          `download ${resource.fileKey} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        out.push(attachment);
      }
    }
    return out;
  }

  /**
   * Handle a button click.
   *
   * **Known gap.** Feishu allows a callback response body within three seconds,
   * which is how a click produces a toast. The SDK's high-level `Channel` module
   * acknowledges the event itself and discards this handler's return value, so the
   * toast is unreachable from here. The outcome is therefore posted as a message in
   * the thread instead. That is slower and noisier, and also durable and visible to
   * everyone who can see the card -- which for an authorization decision is
   * arguably the better record. It is a deviation from the design either way, and a
   * small change once the SDK exposes a response channel.
   */
  async #onCardAction(evt: CardActionEvent): Promise<void> {
    const action: InboundCardAction = {
      chatId: evt.chatId,
      messageId: evt.messageId,
      operator: {
        // Identity comes from here and only from here. `action.value` round-trips
        // through the client and Lark does not verify it.
        openId: evt.operator.openId,
        unionId: asRawCardAction(evt.raw)?.operator?.union_id ?? null,
        displayName: evt.operator.name ?? null,
      },
      value: isRecord(evt.action.value) ? evt.action.value : {},
    };

    const outcome = await this.#deps.router.onCardAction(action);
    try {
      await this.#deps.adapter.sendText(
        // Chat scope: the card is already the anchor, and threading the
        // acknowledgement under it needs a thread id the callback does not carry.
        { chatId: evt.chatId, threadId: '' },
        outcome,
        // Keyed on the click, not on the outcome. Feishu's own re-delivery of the
        // same click then collapses to one acknowledgement.
        clickUuid(this.#deps.config.appId, evt),
      );
    } catch (err) {
      this.#note(
        `acknowledging click on ${evt.messageId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

interface RawMessageShape {
  sender?: { sender_id?: { union_id?: string }; sender_type?: string };
}

function asRawMessage(raw: unknown): RawMessageShape | undefined {
  return isRecord(raw) ? (raw as RawMessageShape) : undefined;
}

interface RawCardActionShape {
  operator?: { union_id?: string };
}

function asRawCardAction(raw: unknown): RawCardActionShape | undefined {
  return isRecord(raw) ? (raw as RawCardActionShape) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clickUuid(appId: string, evt: CardActionEvent): string {
  const canonical = `${appId} ${evt.messageId} ${evt.operator.openId} ${JSON.stringify(evt.action.value ?? null)}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 50);
}

/**
 * A filename that cannot escape its directory.
 *
 * The file key is hashed in rather than trusted, and the user-supplied name is
 * reduced to a suffix. A name arriving as `../../.ssh/authorized_keys` is not a
 * hypothetical: the field is whatever the sender's client put in it.
 */
function safeName(fileKey: string, fileName: string | undefined): string {
  const digest = createHash('sha256').update(fileKey, 'utf8').digest('hex').slice(0, 12);
  const cleaned = (fileName ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const suffix = cleaned === '' ? 'bin' : cleaned.slice(-64);
  return `${digest}-${suffix}`;
}
