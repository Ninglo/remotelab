#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sidebarUiSource = readFileSync(join(repoRoot, 'static', 'chat', 'sidebar-ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist in sidebar-ui.js`);
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

const createNewAppShortcutSource = extractFunctionSource(sidebarUiSource, 'createNewAppShortcut');

function createHarness({ focusResult = true } = {}) {
  const state = {
    focusCalls: [],
  };
  const context = {
    console,
    focusNewAppComposer(options) {
      state.focusCalls.push(options);
      return focusResult;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(`${createNewAppShortcutSource}
globalThis.createNewAppShortcut = createNewAppShortcut;`, context, {
    filename: 'static/chat/sidebar-ui.js',
  });
  return { context, state };
}

const successHarness = createHarness();
const successResult = successHarness.context.createNewAppShortcut();
assert.equal(successResult, true, 'new app shortcut should return the settings focus result');
assert.equal(
  JSON.stringify(successHarness.state.focusCalls),
  JSON.stringify([{ closeSidebar: true }]),
  'new app shortcut should open the settings-side app composer instead of creating a chat session',
);

const missingHarness = createHarness({ focusResult: false });
const missingResult = missingHarness.context.createNewAppShortcut();
assert.equal(missingResult, false, 'new app shortcut should fail cleanly when the settings focus fails');
assert.equal(
  JSON.stringify(missingHarness.state.focusCalls),
  JSON.stringify([{ closeSidebar: true }]),
  'new app shortcut should delegate to the settings composer even on failure',
);

console.log('test-chat-new-app-shortcut: ok');
