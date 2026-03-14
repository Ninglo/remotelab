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

const createNewAppShortcutSource = extractFunctionSource(uiSource, 'createNewAppShortcut');

function createHarness({ app = { id: 'app_create_app', name: 'Create App' }, createResult = true } = {}) {
  const state = {
    userPersists: [],
    appPersists: [],
    refreshCalls: 0,
    renderCalls: 0,
    createCalls: [],
    activeUserFilter: 'user_old',
    activeSessionAppFilter: 'app_old',
  };
  const context = {
    console,
    CREATE_APP_TEMPLATE_APP_ID: 'app_create_app',
    ADMIN_USER_FILTER_VALUE: 'admin',
    activeUserFilter: state.activeUserFilter,
    activeSessionAppFilter: state.activeSessionAppFilter,
    getAppRecordById(appId) {
      state.requestedAppId = appId;
      return app;
    },
    getAdminSessionPrincipal() {
      return { kind: 'owner', id: 'admin', name: 'Admin' };
    },
    normalizeUserFilter(value) {
      return `user:${value}`;
    },
    persistActiveUserFilter(value) {
      state.userPersists.push(value);
    },
    normalizeSessionAppFilter(value) {
      return `app:${value}`;
    },
    persistActiveSessionAppFilter(value) {
      state.appPersists.push(value);
    },
    refreshAppCatalog() {
      state.refreshCalls += 1;
    },
    renderSessionList() {
      state.renderCalls += 1;
    },
    createSessionForApp(nextApp, options) {
      state.createCalls.push({ app: nextApp, options });
      return createResult;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(`${createNewAppShortcutSource}
globalThis.createNewAppShortcut = createNewAppShortcut;`, context, {
    filename: 'static/chat/ui.js',
  });
  return { context, state };
}

const successHarness = createHarness();
const successResult = successHarness.context.createNewAppShortcut();
assert.equal(successResult, true, 'new app shortcut should return the created session result');
assert.equal(successHarness.state.requestedAppId, 'app_create_app', 'new app shortcut should target the built-in Create App starter');
assert.equal(successHarness.context.activeUserFilter, 'user:admin', 'new app shortcut should switch back to the owner/admin scope');
assert.equal(successHarness.context.activeSessionAppFilter, 'app:app_create_app', 'new app shortcut should switch the app filter to Create App');
assert.deepEqual(successHarness.state.userPersists, ['user:admin'], 'new app shortcut should persist the owner filter');
assert.deepEqual(successHarness.state.appPersists, ['app:app_create_app'], 'new app shortcut should persist the Create App filter');
assert.equal(successHarness.state.refreshCalls, 1, 'new app shortcut should refresh the app catalog before creating the session');
assert.equal(successHarness.state.renderCalls, 1, 'new app shortcut should rerender the session list before creating the session');
assert.equal(successHarness.state.createCalls.length, 1, 'new app shortcut should create exactly one session');
assert.equal(
  JSON.stringify(successHarness.state.createCalls[0]),
  JSON.stringify({
    app: { id: 'app_create_app', name: 'Create App' },
    options: {
      closeSidebar: true,
      principal: { kind: 'owner', id: 'admin', name: 'Admin' },
    },
  }),
  'new app shortcut should behave like a normal Create App owner session launch',
);

const missingHarness = createHarness({ app: null, createResult: false });
const missingResult = missingHarness.context.createNewAppShortcut();
assert.equal(missingResult, false, 'new app shortcut should fail cleanly when the starter app is unavailable');
assert.equal(missingHarness.state.createCalls.length, 0, 'missing starter app should not attempt to create a session');
assert.deepEqual(missingHarness.state.userPersists, [], 'missing starter app should not mutate filters');
assert.deepEqual(missingHarness.state.appPersists, [], 'missing starter app should not mutate the app filter');

console.log('test-chat-new-app-shortcut: ok');
