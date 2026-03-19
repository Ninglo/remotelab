#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const bootstrapSource = readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap-session-catalog.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
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

const syncSidebarFiltersVisibilitySource = extractFunctionSource(
  bootstrapSource,
  'syncSidebarFiltersVisibility',
);

function createHarness({ activeTab = 'sessions', visitorMode = false } = {}) {
  const state = { toggles: [] };
  const context = {
    console,
    activeTab,
    visitorMode,
    sidebarFilters: {
      classList: {
        toggle(className, force) {
          state.toggles.push({ className, force });
        },
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${syncSidebarFiltersVisibilitySource}\nglobalThis.syncSidebarFiltersVisibility = syncSidebarFiltersVisibility;`,
    context,
    { filename: 'static/chat/bootstrap-session-catalog.js' },
  );
  return { context, state };
}

const settingsHarness = createHarness({ activeTab: 'settings' });
settingsHarness.context.syncSidebarFiltersVisibility();
assert.deepEqual(
  settingsHarness.state.toggles,
  [{ className: 'hidden', force: true }],
  'settings tab should keep sidebar filters hidden even when refresh paths rerender them',
);

const sessionsHarness = createHarness({ activeTab: 'sessions' });
sessionsHarness.context.syncSidebarFiltersVisibility();
assert.deepEqual(
  sessionsHarness.state.toggles,
  [{ className: 'hidden', force: false }],
  'sessions tab should show sidebar filters by default',
);

const visitorHarness = createHarness({ activeTab: 'sessions', visitorMode: true });
visitorHarness.context.syncSidebarFiltersVisibility();
assert.deepEqual(
  visitorHarness.state.toggles,
  [{ className: 'hidden', force: true }],
  'visitor mode should always hide owner-only sidebar filters',
);

console.log('test-chat-sidebar-filters-visibility: ok');
