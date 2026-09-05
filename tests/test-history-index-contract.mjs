#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = mkdtempSync(join(tmpdir(), 'remotelab-history-index-'));
setIsolatedTestHome(home);

const { appendEvents, readEventBody, readEventsAfter } = await import('./chat/history.mjs');

try {
  const sessionId = 'history-index-contract';
  const longReasoning = 'thinking '.repeat(900);
  const shortToolInput = 'echo hello';
  const shortToolResult = 'hello';
  const events = [];

  for (let index = 0; index < 620; index += 1) {
    events.push({
      type: 'message',
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `message ${index}`,
    });
  }

  events.splice(10, 0, { type: 'reasoning', content: longReasoning });
  events.splice(11, 0, { type: 'tool_use', id: 'tool-1', toolName: 'shell', toolInput: shortToolInput });
  events.splice(12, 0, { type: 'tool_result', output: shortToolResult, exitCode: 0 });

  await appendEvents(sessionId, events);

  const eventIndex = await readEventsAfter(sessionId, 0);
  assert.equal(eventIndex.length, events.length, 'history reads should return the full event index without a hard limit');
  assert.equal(eventIndex.at(-1)?.seq, events.length, 'full history reads should advance through the final sequence');

  const firstMessage = eventIndex.find((event) => event.type === 'message');
  assert.ok(firstMessage, 'message event should be present');
  assert.equal(firstMessage.content, '', 'chat messages should be deferred from the main event index');
  assert.equal(firstMessage.bodyAvailable, true, 'message event should expose a lazy body');
  assert.equal(firstMessage.bodyLoaded, false, 'message body should stay unloaded in the event index');

  const reasoning = eventIndex.find((event) => event.type === 'reasoning');
  assert.ok(reasoning, 'reasoning event should be present');
  assert.equal(reasoning.content, '', 'reasoning body should be deferred from the event index');
  assert.equal(reasoning.bodyAvailable, true, 'reasoning event should expose a lazy body');
  assert.equal(reasoning.bodyLoaded, false, 'reasoning body should stay unloaded in the event index');

  const toolUse = eventIndex.find((event) => event.type === 'tool_use');
  assert.ok(toolUse, 'tool use event should be present');
  assert.equal(toolUse.toolInput, '', 'tool input should be deferred from the event index');
  assert.equal(toolUse.bodyAvailable, true, 'tool use should expose a lazy body');
  assert.equal(toolUse.bodyLoaded, false, 'tool use body should stay unloaded in the event index');

  const toolResult = eventIndex.find((event) => event.type === 'tool_result');
  assert.ok(toolResult, 'tool result event should be present');
  assert.equal(toolResult.output, '', 'tool result should be deferred from the event index');
  assert.equal(toolResult.bodyAvailable, true, 'tool result should expose a lazy body');
  assert.equal(toolResult.bodyLoaded, false, 'tool result body should stay unloaded in the event index');

  const messageBody = await readEventBody(sessionId, firstMessage.seq);
  assert.equal(messageBody?.value, 'message 0', 'message body should load on demand');

  const reasoningBody = await readEventBody(sessionId, reasoning.seq);
  assert.equal(reasoningBody?.value, longReasoning, 'reasoning body should load on demand');

  const toolUseBody = await readEventBody(sessionId, toolUse.seq);
  assert.equal(toolUseBody?.value, shortToolInput, 'inline tool input should still load on demand');

  const toolResultBody = await readEventBody(sessionId, toolResult.seq);
  assert.equal(toolResultBody?.value, shortToolResult, 'inline tool result should still load on demand');

  console.log('history-index-contract: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
