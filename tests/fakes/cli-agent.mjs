#!/usr/bin/env node
/**
 * A fake command-line agent, emitting ByteSec's `run --format json` stream by hand.
 *
 * Written against the observed wire format rather than a shared helper, for the
 * same reason `agent.mjs` is: the driver's job is to survive other people's
 * processes, and a real one interleaves its structured events with logger noise on
 * the same stdout, writes its actual failure reason to stderr, exits without
 * finishing, and ignores being asked to stop. None of that is reproducible with a
 * cooperative double.
 *
 * Behaviour is chosen by `FAKE_CLI_MODE`:
 *
 *   basic       two text deltas and token stats, then a completed turn
 *   tool        a tool call through running -> completed, then a completed turn
 *   noise       lines the driver has no projection for, then a completed turn
 *   permission  ask for permission, which no command line can answer
 *   error       write a reason to stderr, finish with `error`, exit 1
 *   crash       write to stderr and exit without finishing
 *   hang        stream one delta and then never finish
 *   unstreamed  stream nothing, put the whole answer in the summary
 *   weird       finish with a value nobody has a projection for
 *
 * Every invocation appends its argv to `FAKE_CLI_LOG` as one JSON line. That file
 * is how a test sees the composed prompt -- which is the whole of this driver's
 * session handling, and otherwise invisible.
 */

import { appendFileSync } from 'node:fs';

const MODE = process.env['FAKE_CLI_MODE'] ?? 'basic';
const LOG = process.env['FAKE_CLI_LOG'];

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const prompt = dashdash === -1 ? '' : argv.slice(dashdash + 1).join(' ');

if (LOG !== undefined) {
  appendFileSync(LOG, `${JSON.stringify({ argv, prompt })}\n`);
}

const SESSION = 'ses_fake_cli';

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}

function event(type, extra = {}) {
  emit({ type, session_id: SESSION, message_id: 'msg_1', agent_path: '/root', ...extra });
}

function delta(text) {
  event('text_delta', { part_id: 'prt_text', text });
}

function summary(finish, content) {
  emit({
    content,
    finish,
    timing_summary: { start_ms: 1, end_ms: 2, duration_ms: 1 },
    tokens: { cached: 0, input: 10, output: 2, reasoning: 0 },
    tool_calls: null,
    tool_results: null,
    turn: 1,
  });
}

switch (MODE) {
  case 'tool': {
    event('tool_running', { part_id: 'prt_tool', tool: 'Glob', status: 'running' });
    event('tool_completed', {
      part_id: 'prt_tool',
      tool: 'Glob',
      status: 'completed',
      output: 'a.txt\nb.txt',
    });
    delta('two files');
    summary('completed', 'two files');
    break;
  }

  case 'noise': {
    // Not JSON at all, and on stdout. A real one prints this before anything else.
    process.stdout.write(
      '[Stats] 2026-08-24 20:05:00.722 failed to init cgroup collector: no such file\n',
    );
    // The agent's own structured logger, on the same stream as the events.
    emit({ level: 'warn', component: 'memory-sync', message: 'startup memory sync failed' });
    // A telemetry envelope with no `type` and no `finish`.
    emit({ agent_step_budget: { total_steps: 0 }, tag: 'agent_step_budget', unix_ms: 1 });
    // A type from a later version than this driver.
    event('sentiment_delta', { mood: 'chipper' });
    event('token_stats', { tokens: { cached: 0, input: 10, output: 2, reasoning: 0 } });
    summary('completed', '');
    break;
  }

  case 'permission': {
    delta('about to do something');
    event('permission_request', { tool: 'Bash', action: 'rm -rf /tmp/scratch' });
    // Waits for an answer that cannot arrive. Being killed is the correct outcome.
    setInterval(() => {}, 1000);
    break;
  }

  case 'error': {
    // Colour codes and a line the driver must not mistake for the reason.
    process.stderr.write(
      '[1;31mError [model-retry] attempt failed attempt=5/5 retryable=true[0m\n',
    );
    process.stderr.write(
      '{"level":"info","component":"tce-shutdown","message":"engine cleanup completed"}\n',
    );
    summary('error', '');
    process.stderr.write('headless run terminated in error state: no such model "big-pickle"\n');
    process.exitCode = 1;
    break;
  }

  case 'crash': {
    delta('starting');
    process.stderr.write('fake agent is going down mid-turn\n');
    process.exit(7);
    break;
  }

  case 'hang': {
    delta('working');
    setInterval(() => {}, 1000);
    break;
  }

  case 'unstreamed': {
    // Streams nothing at all. The answer exists only in the summary, and a card
    // reading "finished with no output" next to it would be a gateway bug.
    summary('completed', 'the whole answer, unstreamed');
    break;
  }

  case 'weird': {
    delta('half an answer');
    summary('interrupted_by_something_new', 'half an answer');
    break;
  }

  default: {
    delta('hello ');
    delta(`world (${prompt.split('\n').at(-1) ?? ''})`);
    event('token_stats', { tokens: { cached: 0, input: 10, output: 2, reasoning: 0 } });
    summary('completed', `hello world (${prompt.split('\n').at(-1) ?? ''})`);
    break;
  }
}
