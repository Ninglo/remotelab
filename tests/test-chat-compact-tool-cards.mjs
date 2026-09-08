#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const cssSource = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

assert.match(
  uiSource,
  /function summarizeToolInput\(/,
  'tool cards should summarize tool input into the compact header',
);

const context = {};
context.globalThis = context;
vm.runInNewContext(
  `${extractFunctionSource(uiSource, 'summarizeToolInput')}\nthis.summarizeToolInput = summarizeToolInput;`,
  context,
  { filename: 'static/chat/ui.js' },
);
assert.equal(
  context.summarizeToolInput('{"cmd":"npm test","workdir":"/tmp/project"}'),
  'npm test',
  'structured calls should surface their useful command instead of raw JSON',
);
assert.equal(
  context.summarizeToolInput('first line\nsecond line'),
  'first line second line',
  'multi-line inputs should collapse into one quiet activity row',
);
assert.equal(
  context.summarizeToolInput('x'.repeat(140)).length,
  120,
  'long tool inputs should be clipped to protect the transcript layout',
);
assert.match(
  uiSource,
  /targetCard\.classList\.add\("is-complete"\)/,
  'a completed tool call should update its existing card instead of rendering a second result row',
);
assert.match(
  uiSource,
  /body\.replaceChildren\(pre\)/,
  'the result should replace expanded input detail so input and output are not stacked redundantly',
);
assert.doesNotMatch(
  uiSource,
  /label\.className = "tool-result-label"/,
  'compact tool cards should not repeat a separate result heading',
);
assert.match(
  cssSource,
  /\.tool-card\.is-running \.tool-status/,
  'running tool calls should have a visible status treatment',
);
assert.match(
  cssSource,
  /\.tool-card\.is-failed \.tool-status/,
  'failed tool calls should have a visible status treatment',
);

console.log('test-chat-compact-tool-cards: ok');
