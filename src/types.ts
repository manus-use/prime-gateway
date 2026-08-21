/**
 * Shared domain types. No I/O, no dependencies on db/channel/driver.
 */

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

/** Who produced an event. Stamped on every row; never inferred at read time. */
export type Actor = 'user' | 'agent' | 'gateway' | 'policy';

export type EventType =
  // inbound
  | 'inbound_message'
  | 'policy_rejected'
  | 'binding_resolved'
  | 'command_invoked'
  // turn lifecycle
  | 'turn_submitted'
  | 'turn_delivery_ambiguous'
  | 'turn_ended'
  // agent output
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'usage'
  // approvals
  | 'approval_requested'
  | 'approval_resolved'
  // session lifecycle
  | 'session_created'
  | 'session_state_changed'
  | 'generation_bumped'
  | 'agent_error';

export interface Event {
  sessionId: string;
  seq: number;
  ts: number;
  generation: number;
  brokerSeq: number | null;
  turnId: string | null;
  type: EventType;
  actor: Actor;
  payload: unknown;
}

/** An event that has not been assigned a seq yet. */
export interface NewEvent {
  type: EventType;
  actor: Actor;
  payload: unknown;
  turnId?: string | null;
  generation?: number;
  brokerSeq?: number | null;
  ts?: number;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * `quarantined` is deliberately distinct from `cold`: a cold session may be
 * resumed automatically, a quarantined one may not. See §2.4.
 */
export type SessionState =
  | 'initializing'
  | 'live'
  | 'idle'
  | 'blocked'
  | 'cold'
  | 'quarantined'
  | 'archived'
  | 'terminated'
  | 'unknown';

export interface SessionRow {
  id: string;
  agentId: string;
  workspaceId: string;
  ownerPrincipal: string;
  state: SessionState;
  title: string | null;
  generation: number;
  providerSessionId: string | null;
  executionHandle: string | null;
  executionBackend: string | null;
  lastSeq: number;
  createdAt: number;
  lastActivityAt: number;
  coldAt: number | null;
}

/**
 * Whether a runtime exists for a session, as three states rather than two.
 * Collapsing `cold` and `absent` is how session-exists-but-process-dead falls
 * into the create branch and produces duplicate sessions on one thread.
 */
export type RuntimePresence = 'live' | 'cold' | 'absent';

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export type TurnState =
  | 'pending'
  | 'delivering'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'indeterminate';

/**
 * Evidence-graded turn outcome, decoupled from display text. Non-empty final
 * text is not a reliable completion contract. Empty output is a terminal.
 * Cancellation is a terminal, not a deletion.
 */
export type TurnTerminal = 'completed' | 'failed' | 'cancelled' | 'ambiguous';

export interface TurnRow {
  sessionId: string;
  turnId: string;
  generation: number;
  idempotencyKey: string;
  state: TurnState;
  terminal: TurnTerminal | null;
  fence: string | null;
  submittedAt: number;
  endedAt: number | null;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export interface BindingKey {
  channel: string;
  /** Bot identity. Part of the key so N bots can coexist in one chat. */
  appId: string;
  conversationId: string;
  /** Feishu thread_id, or '' for chat scope. NEVER root_id -- see §3.3. */
  threadId: string;
}

export interface BindingRow extends BindingKey {
  sessionId: string;
  isPrimary: boolean;
  cursorSeq: number;
  boundAt: number;
  revokedAt: number | null;
  activeCardId: string | null;
  activeMessageId: string | null;
  cardCreatedAt: number | null;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export type ApprovalState = 'pending' | 'parked' | 'resolved';

export interface ApprovalRow {
  approvalId: string;
  sessionId: string;
  turnId: string;
  generation: number;
  action: string;
  payload: unknown;
  options: PermissionOption[];
  state: ApprovalState;
  optionId: string | null;
  resolvedBy: string | null;
  resolvedVia: string | null;
  cardMessageId: string | null;
  createdAt: number;
  parksAt: number;
  resolvedAt: number | null;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * `unionId` is the canonical human key. `openId` is app-scoped: correct as a
 * per-bot handle, wrong as a durable identity.
 */
export interface Principal {
  openId: string;
  unionId: string | null;
  displayName: string | null;
}

/** Authorization tiers. Every command declares which one it needs. */
export type Tier = 'talk' | 'operate';

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export interface InboundAttachment {
  fileKey: string;
  kind: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  name: string | null;
  /** Local path once downloaded. Attachments are injected as paths, never inline. */
  localPath?: string;
}

export interface InboundMessage {
  messageId: string;
  appId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  /** '' for chat scope. Derived from thread_id only. */
  threadId: string;
  sender: Principal;
  senderIsBot: boolean;
  text: string;
  mentionedBot: boolean;
  mentionAll: boolean;
  attachments: InboundAttachment[];
  createTime: number;
}

export type RejectReason =
  | 'sender_not_allowed'
  | 'chat_not_allowed'
  | 'no_mention'
  | 'dm_disabled'
  | 'mention_all_blocked'
  | 'bot_sender'
  | 'insufficient_tier';
