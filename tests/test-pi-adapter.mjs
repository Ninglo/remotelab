#!/usr/bin/env node
import assert from 'assert/strict';
import { buildPiArgs, createPiAdapter } from '../chat/adapters/pi.mjs';

const args = buildPiArgs('Hello\0 world', {
  sessionId: 'session-1',
  model: 'gpt-test',
  thinking: 'high',
});
assert.deepEqual(args.slice(0, 5), ['--mode', 'json', '--provider', 'openai-codex', '--approve']);
assert.ok(args.includes('--session-id'));
assert.ok(args.includes('session-1'));
assert.ok(args.includes('gpt-test'));
assert.ok(args.includes('high'));
assert.equal(args.at(-1), 'Hello world');

const adapter = createPiAdapter();
const messageEvents = adapter.parseLine(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'checking' },
      { type: 'text', text: 'done' },
    ],
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      reasoning: 1,
      totalTokens: 16,
      cost: { total: 0.01 },
    },
    stopReason: 'stop',
  },
}));
assert.deepEqual(messageEvents.map((event) => event.type), ['reasoning', 'message', 'usage']);
assert.equal(messageEvents[1].content, 'done');
assert.equal(messageEvents[2].contextTokens, 16);

const toolEvents = [
  ...adapter.parseLine(JSON.stringify({
    type: 'tool_execution_start',
    toolName: 'bash',
    args: { command: 'pwd' },
  })),
  ...adapter.parseLine(JSON.stringify({
    type: 'tool_execution_end',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: '/tmp' }] },
    isError: false,
  })),
];
assert.deepEqual(toolEvents.map((event) => event.type), ['tool_use', 'tool_result']);
assert.equal(toolEvents[1].output, '/tmp');
assert.equal(adapter.parseLine('{bad json').length, 0);

const retryingAdapter = createPiAdapter();
const transientFailureEvents = retryingAdapter.parseLine(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: 'temporary failure',
  },
}));
assert.equal(
  transientFailureEvents.some((event) => event.type === 'status' && /^error:/i.test(event.content)),
  false,
  'a failed provider attempt must not terminalize RemoteLab while Pi is still retrying',
);
assert.equal(
  retryingAdapter.parseLine(JSON.stringify({ type: 'agent_end', willRetry: true })).length,
  0,
  'agent_end may precede an automatic retry and must not complete the run',
);
retryingAdapter.parseLine(JSON.stringify({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' },
}));
assert.equal(
  retryingAdapter.parseLine(JSON.stringify({ type: 'agent_settled' }))[0]?.content,
  'completed',
  'a successful retry should publish one completed terminal status',
);

const failedAdapter = createPiAdapter();
failedAdapter.parseLine(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: 'final provider failure',
  },
}));
assert.equal(
  failedAdapter.parseLine(JSON.stringify({ type: 'agent_settled' }))[0]?.content,
  'error: final provider failure',
  'only the settled final provider failure should terminalize the run',
);

const splitFailureAdapter = createPiAdapter();
splitFailureAdapter.parseLine(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: 'split-delta provider failure',
  },
}));
const resumedFailureAdapter = createPiAdapter();
resumedFailureAdapter.restoreProjectionState(splitFailureAdapter.getProjectionState());
assert.equal(
  resumedFailureAdapter.parseLine(JSON.stringify({ type: 'agent_settled' }))[0]?.content,
  'error: split-delta provider failure',
  'incremental spool projection should preserve Pi attempt state across polling deltas',
);

const settledAdapter = createPiAdapter();
settledAdapter.parseLine(JSON.stringify({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' },
}));
assert.equal(
  settledAdapter.parseLine(JSON.stringify({ type: 'agent_settled' }))[0]?.content,
  'completed',
);

console.log('test-pi-adapter: ok');
