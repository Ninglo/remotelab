#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sidebarUiSource = readFileSync(join(repoRoot, 'static', 'chat', 'sidebar-ui.js'), 'utf8');
const sessionHttpSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-http.js'), 'utf8');

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

const createSortSessionListShortcutSource = extractFunctionSource(sidebarUiSource, 'createSortSessionListShortcut');

function createHarness({ organizeResult = true } = {}) {
  const state = {
    organizeCalls: [],
  };
  const context = {
    console,
    organizeSessionListWithAgent(options) {
      state.organizeCalls.push(options);
      return organizeResult;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(`${createSortSessionListShortcutSource}
globalThis.createSortSessionListShortcut = createSortSessionListShortcut;`, context, {
    filename: 'static/chat/sidebar-ui.js',
  });
  return { context, state };
}

const successHarness = createHarness();
const successResult = successHarness.context.createSortSessionListShortcut();
assert.equal(successResult, true, 'sort list shortcut should return the organizer trigger result');
assert.equal(
  JSON.stringify(successHarness.state.organizeCalls),
  JSON.stringify([{ closeSidebar: false }]),
  'sort list shortcut should trigger the hidden organizer flow without closing the sidebar',
);

const missingHarness = createHarness({ organizeResult: false });
const missingResult = missingHarness.context.createSortSessionListShortcut();
assert.equal(missingResult, false, 'sort list shortcut should fail cleanly when the organizer trigger fails');
assert.equal(
  JSON.stringify(missingHarness.state.organizeCalls),
  JSON.stringify([{ closeSidebar: false }]),
  'sort list shortcut should still delegate to the organizer helper on failure',
);

assert.doesNotMatch(
  sessionHttpSource,
  /\/api\/session-list\/organize/,
  'sort list helper should no longer call the dedicated organizer endpoint',
);

console.log('test-chat-sort-list-shortcut: ok');
