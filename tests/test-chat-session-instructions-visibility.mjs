#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { createSessionDetail } from '../chat/session-api-shapes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const template = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');
const css = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const surfaceSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-surface-ui.js'), 'utf8');
const sessionHttpSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-http.js'), 'utf8');

assert.match(template, /id="sessionInstructionsPanel"/, 'chat UI should include a Session instructions disclosure');
assert.match(template, /id="sessionInstructionsText"/, 'chat UI should expose the exact instruction text');
assert.match(css, /\.session-instructions-panel/, 'Session instructions disclosure should have bounded styling');
assert.match(
  sessionHttpSource,
  /systemPrompt: typeof session\.systemPrompt === "string" \? session\.systemPrompt : null/,
  'attached-session refresh should react when Session instructions change',
);

const detail = createSessionDetail({
  id: 'session_prompt',
  name: 'Prompt visibility',
  systemPrompt: 'Persist every transcript for the daily review.',
  sourceContext: { secretProjection: 'not returned' },
});
assert.equal(detail.systemPrompt, 'Persist every transcript for the daily review.');
assert.equal(detail.sourceContext, undefined, 'raw per-message source context remains excluded from the Session shape');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
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

const panel = { hidden: true, dataset: {} };
const details = { open: false };
const text = { textContent: '' };
const elements = {
  sessionInstructionsPanel: panel,
  sessionInstructionsDetails: details,
  sessionInstructionsText: text,
};
const context = {
  document: {
    getElementById(id) {
      return elements[id] || null;
    },
  },
};
context.globalThis = context;
vm.runInNewContext(
  `${extractFunctionSource(surfaceSource, 'renderSessionInstructions')}\n`
    + 'globalThis.renderSessionInstructions = renderSessionInstructions;',
  context,
  { filename: 'static/chat/session-surface-ui.js' },
);

context.renderSessionInstructions({ id: 'session_prompt', systemPrompt: 'Line one\nLine two' });
assert.equal(panel.hidden, false, 'nonempty instructions should reveal the disclosure');
assert.equal(text.textContent, 'Line one\nLine two', 'the disclosure should show the exact stored prompt');

details.open = true;
context.renderSessionInstructions({ id: 'session_prompt', systemPrompt: 'Updated prompt' });
assert.equal(details.open, true, 'refreshing one Session should preserve the user-expanded state');
assert.equal(text.textContent, 'Updated prompt', 'prompt updates should replace the visible content');

context.renderSessionInstructions({ id: 'session_without_prompt', systemPrompt: '' });
assert.equal(panel.hidden, true, 'Sessions without custom instructions should not show an empty disclosure');
assert.equal(text.textContent, '');

console.log('test-chat-session-instructions-visibility: ok');
