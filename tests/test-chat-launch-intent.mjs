#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const initSource = readFileSync(join(repoRoot, 'static/chat/init.js'), 'utf8');

function createClassList() {
  const values = new Set();
  return {
    add(...tokens) {
      tokens.forEach((token) => values.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => values.delete(token));
    },
    toggle(token, force) {
      if (force === true) {
        values.add(token);
        return true;
      }
      if (force === false) {
        values.delete(token);
        return false;
      }
      if (values.has(token)) {
        values.delete(token);
        return false;
      }
      values.add(token);
      return true;
    },
    contains(token) {
      return values.has(token);
    },
  };
}

function createStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function createElement() {
  return {
    style: {},
    dataset: {},
    classList: createClassList(),
    disabled: false,
    hidden: false,
    textContent: '',
    title: '',
    placeholder: '',
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    focus() {},
  };
}

function flushAsync(turns = 6) {
  let chain = Promise.resolve();
  for (let index = 0; index < turns; index += 1) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return chain;
}

function createHarness({ href, search, isStandalone = true } = {}) {
  const historyCalls = [];
  const bootstrapCalls = [];
  const createCalls = [];
  const restoreCalls = [];
  const connectCalls = [];
  const modelLoads = [];
  const location = {
    href,
    pathname: '/',
    search,
    hash: '',
    replace() {},
  };
  const context = {
    console: {
      info() {},
      log() {},
      warn() {},
      error(...args) {
        throw new Error(args.map((value) => String(value)).join(' '));
      },
    },
    Promise,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    history: {
      replaceState(_state, _title, url) {
        historyCalls.push(url);
      },
    },
    localStorage: createStorage(),
    navigator: {
      userAgent: 'Android',
      standalone: false,
      serviceWorker: null,
    },
    window: {
      location,
      matchMedia(query) {
        return {
          matches: query === '(display-mode: standalone)' ? isStandalone : false,
          addEventListener() {},
        };
      },
      remotelabResolveProductPath(path) {
        return path;
      },
    },
    document: {
      body: {
        classList: createClassList(),
        appendChild() {},
      },
      createElement() {
        return createElement();
      },
      getElementById() {
        return null;
      },
      addEventListener() {},
      removeEventListener() {},
    },
    menuBtn: createElement(),
    sortSessionListBtn: createElement(),
    newSessionBtn: createElement(),
    inlineAgentSelect: createElement(),
    inlineToolSelect: createElement(),
    inlineModelSelect: createElement(),
    effortSelect: createElement(),
    thinkingToggle: createElement(),
    compactBtn: createElement(),
    dropToolsBtn: createElement(),
    contextTokens: createElement(),
    saveTemplateBtn: createElement(),
    sessionTemplateRow: createElement(),
    tabAgents: createElement(),
    agentsPanel: createElement(),
    settingsPanel: createElement(),
    statusText: createElement(),
    msgInput: createElement(),
    currentSessionId: 'persisted-session',
    hasAttachedSession: true,
    visitorMode: false,
    shareSnapshotMode: false,
    pendingNavigationState: { sessionId: 'url-session', tab: 'settings' },
    initResponsiveLayout() {},
    syncAddToolModal() {},
    syncForkButton() {},
    syncShareButton() {},
    requestLayoutPass() {},
    syncInputHeightForLayout() {},
    initializePushNotifications() {},
    shouldPromptForInstalledNotifications() {
      return false;
    },
    ensureServiceWorkerRegistration() {
      return Promise.resolve(null);
    },
    loadInlineTools() {
      return Promise.resolve();
    },
    bootstrapViaHttp() {
      bootstrapCalls.push({
        currentSessionId: context.currentSessionId,
        pendingNavigationState: context.pendingNavigationState,
      });
      return Promise.resolve();
    },
    restoreOwnerSessionSelection() {
      restoreCalls.push(true);
    },
    connect() {
      connectCalls.push(true);
    },
    setupForegroundRefreshHandlers() {},
    loadModelsForCurrentTool() {
      modelLoads.push(true);
      return Promise.resolve();
    },
    createNewSessionShortcut(options) {
      createCalls.push(options);
      return Promise.resolve(true);
    },
    getBootstrapShareSnapshot() {
      return null;
    },
    getBootstrapAuthInfo() {
      return {
        role: 'owner',
        surfaceMode: 'owner',
        capabilities: {
          createSession: true,
        },
      };
    },
    isAgentScopedMode() {
      return false;
    },
    canChangeRuntimeSelection() {
      return true;
    },
    hasAuthCapability() {
      return true;
    },
    setChatCurrentSession(sessionId, { hasAttachedSession = false } = {}) {
      context.currentSessionId = sessionId;
      context.hasAttachedSession = hasAttachedSession;
    },
  };
  context.globalThis = context;
  return {
    context,
    historyCalls,
    bootstrapCalls,
    createCalls,
    restoreCalls,
    connectCalls,
    modelLoads,
  };
}

async function runInit(harness) {
  vm.runInNewContext(initSource, harness.context, { filename: 'static/chat/init.js' });
  await flushAsync();
}

const quickEntryHarness = createHarness({
  href: 'https://chat.example.com/?intent=new-session',
  search: '?intent=new-session',
});
await runInit(quickEntryHarness);

assert.deepEqual(
  quickEntryHarness.historyCalls,
  ['/'],
  'quick-entry launch should consume the intent from the visible URL exactly once',
);
assert.equal(quickEntryHarness.bootstrapCalls.length, 1, 'quick-entry launch should still bootstrap session data once');
assert.equal(
  quickEntryHarness.bootstrapCalls[0]?.currentSessionId,
  null,
  'quick-entry launch should suppress stale current-session restore before bootstrap',
);
assert.equal(
  quickEntryHarness.bootstrapCalls[0]?.pendingNavigationState,
  null,
  'quick-entry launch should clear the pending navigation restore target before bootstrap',
);
assert.equal(quickEntryHarness.createCalls.length, 1, 'quick-entry launch should create a fresh session once');
assert.equal(quickEntryHarness.createCalls[0]?.forceComposerFocus, true, 'quick-entry launch should request forced composer focus');
assert.equal(
  quickEntryHarness.createCalls[0]?.sourceContext?.shortcutId,
  'new_session',
  'quick-entry launch should tag the created session with the shortcut metadata',
);
assert.equal(quickEntryHarness.restoreCalls.length, 0, 'quick-entry launch should not restore the prior session selection');
assert.equal(quickEntryHarness.connectCalls.length, 1, 'quick-entry launch should still connect realtime once');
assert.equal(quickEntryHarness.modelLoads.length, 1, 'quick-entry launch should still refresh models once');

const defaultHarness = createHarness({
  href: 'https://chat.example.com/',
  search: '',
});
await runInit(defaultHarness);

assert.equal(defaultHarness.createCalls.length, 0, 'normal launches should not auto-create a session');
assert.equal(defaultHarness.restoreCalls.length, 1, 'normal launches should keep the existing restore path');
assert.deepEqual(defaultHarness.historyCalls, [], 'normal launches should not rewrite the URL');

console.log('test-chat-launch-intent: ok');
