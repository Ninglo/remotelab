#!/usr/bin/env node
import assert from 'assert/strict';
import { createCodexAdapter } from '../chat/adapters/codex.mjs';

const adapter = createCodexAdapter();

const reconnectEvents = adapter.parseLine(JSON.stringify({
  type: 'error',
  message: 'Reconnecting... 2/5 (stream disconnected before completion)',
}));
assert.equal(reconnectEvents.length, 1);
assert.equal(reconnectEvents[0].type, 'status');
assert.match(reconnectEvents[0].content, /^Provider notice:/);
assert.doesNotMatch(
  reconnectEvents[0].content,
  /^error:/i,
  'a retryable Codex transport event must not terminalize the RemoteLab run',
);

const fallbackEvents = adapter.parseLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_0',
    type: 'error',
    message: 'Falling back from WebSockets to HTTPS transport.',
  },
}));
assert.equal(fallbackEvents.length, 1);
assert.equal(fallbackEvents[0].type, 'status');
assert.match(fallbackEvents[0].content, /^Provider notice:/);
assert.doesNotMatch(
  fallbackEvents[0].content,
  /^error:/i,
  'an item-level Codex error must not be treated as a turn-level failure',
);

const completedEvents = adapter.parseLine(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
assert.equal(completedEvents[0]?.content, 'completed');

const failedEvents = adapter.parseLine(JSON.stringify({
  type: 'turn.failed',
  error: { message: 'final provider failure' },
}));
assert.equal(failedEvents.length, 1);
assert.equal(failedEvents[0].content, 'error: final provider failure');

console.log('test-codex-adapter: ok');

const start = adapter.parseLine(JSON.stringify({ type: 'item.started', item: {
  id: 'command_a', type: 'command_execution', status: 'in_progress', command: 'npm test',
} }));
// A fresh adapter simulates incremental projection after a controller restart.
const finish = createCodexAdapter().parseLine(JSON.stringify({ type: 'item.completed', item: {
  id: 'command_a', type: 'command_execution', status: 'completed', command: 'npm test', aggregated_output: 'ok', exit_code: 0,
} }));
assert.equal(start[0].toolCallId, 'command_a');
assert.ok(finish.every(event => event.toolCallId === 'command_a'), 'identity survives restart without in-memory matching');
const change = adapter.parseLine(JSON.stringify({ type: 'item.completed', item: {
  type: 'file_change', status: 'completed', changes: [{ path: 'a.js', kind: 'update', diff: '@@\n-old\n+new' }],
} }));
assert.equal(change[0].diff, '@@\n-old\n+new');
const search = adapter.parseLine(JSON.stringify({ type: 'item.completed', item: {
  id: 'search_a', type: 'web_search', query: 'test',
} }));
assert.equal(search[0].toolState, 'completed', 'completed searches cannot stay running');
