#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildAntigravityArgs, createAntigravityAdapter } from '../chat/adapters/antigravity.mjs';
import { parseAntigravityModels } from '../chat/antigravity-models.mjs';

const args = buildAntigravityArgs('Ping', {
  conversationId: 'conversation-1',
  model: 'gemini-test-high',
  effort: 'high',
});
assert.deepEqual(args.slice(0, 4), ['-p', 'Ping', '--output-format', 'stream-json']);
assert.deepEqual(args.slice(4), [
  '--conversation', 'conversation-1',
  '--model', 'gemini-test-high',
  '--effort', 'high',
]);

const streamArgs = buildAntigravityArgs('', { streamInput: true, sandbox: true });
assert.deepEqual(streamArgs, [
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--sandbox',
]);

let adapter = createAntigravityAdapter();
const parsed = [];
const feed = (value) => parsed.push(...adapter.parseLine(JSON.stringify(value)));
feed({ event: 'init', conversation_id: 'conversation-1', init: { permission_mode: 'request-review' } });
feed({ event: 'step_update', step_update: {
  conversation_id: 'conversation-1', step_index: 0, state: 'DONE', step_type: 'user_input',
} });
feed({ event: 'step_update', step_update: {
  conversation_id: 'conversation-1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hel',
} });
const restored = createAntigravityAdapter();
restored.restoreProjectionState(adapter.getProjectionState());
adapter = restored;
feed({ event: 'step_update', step_update: {
  conversation_id: 'conversation-1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'lo',
  usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 4 },
} });
feed({ event: 'step_update', step_update: {
  conversation_id: 'conversation-1', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command',
  tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' } },
} });
feed({ event: 'step_update', step_update: {
  conversation_id: 'conversation-1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command',
  tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' }, output: '/tmp\n' },
} });
feed({ event: 'result', result: {
  conversation_id: 'conversation-1', status: 'SUCCESS', response: 'Hello',
  usage: { input_tokens: 999, output_tokens: 999 },
} });

assert.equal(parsed.filter((event) => event.type === 'message').length, 1, 'result text must not duplicate streamed response steps');
assert.equal(parsed.find((event) => event.type === 'message')?.content, 'Hello');
assert.equal(parsed.filter((event) => event.type === 'tool_use').length, 1);
assert.equal(parsed.filter((event) => event.type === 'tool_result').length, 1);
assert.deepEqual(
  parsed.filter((event) => event.type === 'usage').map((event) => ({
    input: event.inputTokens,
    output: event.outputTokens,
    reasoning: event.reasoningTokens,
    cached: event.cachedInputTokens,
  })),
  [{ input: 10, output: 2, reasoning: 1, cached: 4 }],
  'per-step usage should avoid Antigravity cumulative-session counters',
);
assert.equal(parsed.at(-1)?.content, 'completed');

const fallback = createAntigravityAdapter().parseLine(JSON.stringify({
  event: 'result',
  result: { status: 'ERROR', response: 'partial response', error: 'authentication required' },
}));
assert.equal(fallback.find((event) => event.type === 'message')?.content, 'partial response');
assert.match(fallback.find((event) => event.type === 'status')?.content || '', /authentication required/);

assert.deepEqual(
  parseAntigravityModels([
    '\u001b[32mgemini-test-high\u001b[0m     Gemini Test (High)',
    'gemini-test-medium   Gemini Test (Medium)',
    '',
  ].join('\n')).map((model) => [model.id, model.label]),
  [
    ['gemini-test-high', 'Gemini Test (High)'],
    ['gemini-test-medium', 'Gemini Test (Medium)'],
  ],
);

console.log('test-antigravity-adapter: ok');
