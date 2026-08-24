#!/usr/bin/env node
/**
 * A fake ACP agent, spoken by hand over stdio.
 *
 * Written against the wire format rather than the SDK's agent helper on purpose.
 * The driver's job is to survive real agents, and real agents are other people's
 * processes: they exit mid-turn, refuse to initialize, advertise capabilities they
 * do not have, and send updates the gateway has no projection for. A cooperative
 * in-process double cannot produce any of those.
 *
 * Behaviour is chosen by `FAKE_AGENT_MODE`:
 *
 *   basic       stream two message chunks and a tool call, then end_turn
 *   permission  ask for permission, report the option that came back
 *   refusal     end the turn with stopReason `refusal`
 *   silent      write to stderr, send no updates, and report end_turn anyway
 *   banner-only write to stderr at start-up only, then an empty end_turn
 *   noise       send updates the gateway has no projection for, then end_turn
 *   hang        never answer the prompt until `session/cancel` arrives
 *   crash       exit mid-turn without answering
 *   resume      advertise `sessionCapabilities.resume`
 *   load        advertise `loadSession` only
 *   bad-init    reject `initialize`, having written to stderr first
 *
 * Every method it handles is appended to `FAKE_AGENT_LOG` as one JSON line, which
 * is how a test observes what the driver actually called -- including the replayed
 * prompts, whose output the driver deliberately discards.
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const MODE = process.env['FAKE_AGENT_MODE'] ?? 'basic';
const LOG = process.env['FAKE_AGENT_LOG'];
const SESSION_ID = process.env['FAKE_AGENT_SESSION_ID'] ?? 'sess_fake_1';

/** Set while a prompt is in flight, so `session/cancel` has something to answer. */
let pendingPrompt = null;
let nextId = 1000;
const inflight = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(entry) {
  if (LOG === undefined) return;
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function failure(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

/** Send a request to the client and resolve when its response comes back. */
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    inflight.set(id, { resolve, reject });
  });
}

function update(update) {
  notify('session/update', { sessionId: SESSION_ID, update });
}

function capabilities() {
  switch (MODE) {
    case 'resume':
      // The shape the driver probes for: `sessionCapabilities.resume != null`.
      return { sessionCapabilities: { resume: {} } };
    case 'load':
      return { loadSession: true };
    default:
      return {};
  }
}

async function runPrompt(id, params) {
  const text = (params.prompt ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const links = (params.prompt ?? [])
    .filter((block) => block.type === 'resource_link')
    .map((block) => block.uri);
  record({ method: 'session/prompt', text, links });

  pendingPrompt = id;

  switch (MODE) {
    case 'crash':
      process.stderr.write('fake agent is going down mid-turn\n');
      process.exit(7);
      return;

    case 'hang':
      // Answered only by `session/cancel`.
      return;

    case 'refusal':
      pendingPrompt = null;
      result(id, { stopReason: 'refusal' });
      return;

    case 'banner-only':
      // Wrote at start-up, said nothing during the turn. The banner is still in
      // the ring buffer, and quoting it would blame the credentials for this.
      pendingPrompt = null;
      result(id, { stopReason: 'end_turn' });
      return;

    case 'silent':
      // Fails internally, says nothing, and reports success anyway. A real agent
      // does this when its configured model does not exist.
      process.stderr.write('ProviderModelNotFoundError: no such model "big-pickle"\n');
      pendingPrompt = null;
      result(id, { stopReason: 'end_turn' });
      return;

    case 'noise':
      update({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact', description: 'compact the context' }],
      });
      update({ sessionUpdate: 'usage_update', used: 1200, size: 200000 });
      pendingPrompt = null;
      result(id, { stopReason: 'end_turn' });
      return;

    case 'permission': {
      const response = await request('session/request_permission', {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: 'tc_1', title: 'rm -rf /tmp/scratch', status: 'pending' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const outcome = response?.outcome?.outcome;
      record({ method: 'permission-outcome', outcome, optionId: response?.outcome?.optionId });
      pendingPrompt = null;
      if (outcome === 'cancelled') {
        result(id, { stopReason: 'cancelled' });
        return;
      }
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `picked:${response.outcome.optionId}` },
      });
      result(id, { stopReason: 'end_turn' });
      return;
    }

    default:
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } });
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_1',
        title: `read ${links[0] ?? 'nothing'}`,
        status: 'in_progress',
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_1',
        status: 'completed',
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `world (${text})` },
      });
      pendingPrompt = null;
      result(id, { stopReason: 'end_turn' });
      return;
  }
}

async function handle(message) {
  // A response to something we asked the client.
  if (message.id !== undefined && message.method === undefined) {
    const waiting = inflight.get(message.id);
    inflight.delete(message.id);
    if (waiting === undefined) return;
    if (message.error !== undefined) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
    return;
  }

  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      record({ method });
      if (MODE === 'banner-only') {
        process.stderr.write('Authenticated as: someone (via OIDC)\n');
      }
      if (MODE === 'bad-init') {
        process.stderr.write('fake agent cannot initialize: no credentials\n');
        failure(id, 'initialize refused');
        return;
      }
      result(id, {
        protocolVersion: params.protocolVersion,
        agentCapabilities: capabilities(),
      });
      return;

    case 'session/new':
      record({ method, cwd: params.cwd });
      result(id, { sessionId: SESSION_ID });
      return;

    case 'session/resume':
      record({ method, sessionId: params.sessionId });
      result(id, {});
      return;

    case 'session/load':
      record({ method, sessionId: params.sessionId });
      result(id, {});
      return;

    case 'session/prompt':
      await runPrompt(id, params);
      return;

    case 'session/cancel':
      record({ method });
      if (pendingPrompt !== null) {
        const id = pendingPrompt;
        pendingPrompt = null;
        result(id, { stopReason: 'cancelled' });
      }
      return;

    case 'session/close':
      record({ method });
      result(id, {});
      return;

    default:
      record({ method: `unhandled:${String(method)}` });
      if (id !== undefined) failure(id, `unimplemented: ${String(method)}`);
      return;
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  void handle(message);
});

// Stdin closing means the client is gone. Nothing left to answer.
lines.on('close', () => {
  process.exit(0);
});
