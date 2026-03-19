#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist in ui.js`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const renderHiddenBlockEventsIntoSource = extractFunctionSource(uiSource, 'renderHiddenBlockEventsInto');

const calls = [];
const context = {
  console,
  renderMessageInto(container, event) {
    calls.push(`message:${event.role || 'assistant'}`);
    return { container, event };
  },
  renderReasoningInto(container, event) {
    calls.push(`reasoning:${event.content}`);
    return { container, event };
  },
  renderManagerContextInto(container, event) {
    calls.push(`manager_context:${event.content}`);
    return { container, event };
  },
  renderToolUseInto(container, event) {
    calls.push(`tool_use:${event.toolName}`);
    return { container, event };
  },
  renderToolResultInto(container, event) {
    calls.push(`tool_result:${event.toolName}`);
    return { container, event };
  },
  renderFileChangeInto(container, event) {
    calls.push(`file_change:${event.filePath}`);
    return { container, event };
  },
  renderStatusInto(container, event) {
    calls.push(`status:${event.content}`);
    return { container, event };
  },
  renderContextBarrierInto(container, event) {
    calls.push(`context_barrier:${event.content}`);
    return { container, event };
  },
  renderUsageInto(container, event) {
    calls.push(`usage:${event.outputTokens || 0}`);
    return { container, event };
  },
  renderUnknownEventInto(container, event) {
    calls.push(`unknown:${event.type}`);
    return { container, event };
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    renderHiddenBlockEventsIntoSource,
    'globalThis.renderHiddenBlockEventsInto = renderHiddenBlockEventsInto;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

context.renderHiddenBlockEventsInto({}, [
  { type: 'message', role: 'assistant', content: 'draft' },
  { type: 'status', content: 'Preparing environment' },
  { type: 'reasoning', content: 'Inspecting files' },
  { type: 'manager_context', content: 'Manager note: keep replies in prose.' },
  { type: 'tool_use', toolName: 'bash' },
  { type: 'tool_result', toolName: 'bash' },
  { type: 'file_change', filePath: 'src/app.js' },
  { type: 'usage', outputTokens: 42 },
  { type: 'context_barrier', content: 'Older messages above this marker are no longer in live context.' },
  { type: 'template_context', content: 'internal note' },
]);

assert.deepEqual(calls, [
  'message:assistant',
  'status:Preparing environment',
  'reasoning:Inspecting files',
  'manager_context:Manager note: keep replies in prose.',
  'tool_use:bash',
  'tool_result:bash',
  'file_change:src/app.js',
  'usage:42',
  'context_barrier:Older messages above this marker are no longer in live context.',
  'unknown:template_context',
], 'expanded folded blocks should render all folded event kinds and fall back safely for unknown ones');

console.log('test-chat-event-block-dispatch: ok');
