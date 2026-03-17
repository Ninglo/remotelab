#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildEventBlockEvents,
  buildSessionDisplayEvents,
} from './chat/session-display-events.mjs';

const interleavedTurnHistory = [
  { seq: 1, type: 'message', role: 'user', content: 'Please summarize the work' },
  { seq: 2, type: 'status', role: 'system', content: 'thinking' },
  { seq: 3, type: 'reasoning', role: 'assistant', content: 'Inspecting repository state' },
  { seq: 4, type: 'status', role: 'system', content: 'Running tool A' },
  { seq: 5, type: 'tool_use', role: 'assistant', toolName: 'shell', toolInput: 'ls -la' },
  { seq: 6, type: 'tool_result', role: 'system', output: 'file list', exitCode: 0 },
  { seq: 7, type: 'message', role: 'assistant', content: 'Final summary' },
  { seq: 8, type: 'usage', role: 'system', contextTokens: 1200, outputTokens: 42 },
];

const interleavedDisplay = buildSessionDisplayEvents(interleavedTurnHistory, { sessionRunning: false });
assert.deepEqual(
  interleavedDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'message', 'usage'],
  'turn display should collapse intermediate turn content and keep only the final assistant summary visible',
);
assert.equal(interleavedDisplay[1].blockStartSeq, 3, 'collapsed range should begin with the first intermediate event after the user message');
assert.equal(interleavedDisplay[1].blockEndSeq, 6, 'collapsed range should extend through the final hidden event before the summary');
assert.equal(interleavedDisplay[1].label, 'Thought · used shell', 'completed blocks should reuse the same thought label family as the running block');

const interleavedBlockEvents = buildEventBlockEvents(interleavedTurnHistory, 3, 6);
assert.deepEqual(
  interleavedBlockEvents.map((event) => event.type),
  ['reasoning', 'tool_use', 'tool_result'],
  'collapsed block payload should still expose the hidden implementation events on demand',
);

const leadingVisibleStatusHistory = [
  { seq: 1, type: 'message', role: 'user', content: 'Do the thing' },
  { seq: 2, type: 'status', role: 'system', content: 'Preparing environment' },
  { seq: 3, type: 'reasoning', role: 'assistant', content: 'Checking dependencies' },
  { seq: 4, type: 'tool_use', role: 'assistant', toolName: 'shell', toolInput: 'npm test' },
  { seq: 5, type: 'message', role: 'assistant', content: 'Done summary' },
];

const leadingVisibleDisplay = buildSessionDisplayEvents(leadingVisibleStatusHistory, { sessionRunning: false });
assert.deepEqual(
  leadingVisibleDisplay.map((event) => event.type),
  ['message', 'thinking_block', 'message'],
  'leading visible status updates should also fold into the intermediate collapsed block when a final summary exists',
);
assert.equal(leadingVisibleDisplay[1].blockStartSeq, 2, 'collapsed range should include visible intermediate status events before hidden work');
assert.equal(leadingVisibleDisplay[1].blockEndSeq, 4, 'collapsed range should end at the last hidden implementation event before the summary');
assert.equal(leadingVisibleDisplay[1].label, 'Thought · used shell', 'completed folded blocks should keep the same thought header copy');

const runningTurnHistory = [
  { seq: 1, type: 'message', role: 'user', content: 'Work on this task' },
  { seq: 2, type: 'status', role: 'system', content: 'Preparing environment' },
  { seq: 3, type: 'reasoning', role: 'assistant', content: 'Inspecting files' },
  { seq: 4, type: 'tool_use', role: 'assistant', toolName: 'bash', toolInput: 'rg TODO' },
  { seq: 5, type: 'tool_result', role: 'system', output: 'matches', exitCode: 0 },
  { seq: 6, type: 'message', role: 'assistant', content: 'partial draft that should stay hidden while running' },
];

const runningDisplay = buildSessionDisplayEvents(runningTurnHistory, { sessionRunning: true });
assert.deepEqual(
  runningDisplay.map((event) => event.type),
  ['message', 'thinking_block'],
  'running turns should collapse into a single thinking block instead of streaming multiple visible intermediate fragments',
);
assert.equal(runningDisplay[1].label, 'Thinking · using bash', 'running turns should use the same thought block label family as completed turns');
assert.equal(runningDisplay[1].blockStartSeq, 2, 'running collapsed block should start with the first non-user event in the turn');
assert.equal(runningDisplay[1].blockEndSeq, 6, 'running collapsed block should extend through the latest in-flight event');

console.log('test-session-display-events: ok');
