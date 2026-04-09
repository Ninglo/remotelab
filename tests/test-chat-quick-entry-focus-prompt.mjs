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
      if (typeof force === 'boolean') {
        if (force) values.add(token);
        else values.delete(token);
        return force;
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
  const listeners = new Map();
  const focusCalls = [];
  return {
    style: {},
    dataset: {},
    classList: createClassList(),
    disabled: false,
    hidden: false,
    textContent: '',
    title: '',
    placeholder: '',
    value: '',
    focusCalls,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    appendChild() {},
    remove() {},
    focus(options) {
      focusCalls.push(options ?? null);
    },
    click() {
      const handlers = listeners.get('click');
      if (!handlers) return;
      for (const handler of handlers) {
        handler({
          currentTarget: this,
          target: this,
          preventDefault() {},
        });
      }
    },
    setSelectionRange(start, end) {
      this.selectionRange = [start, end];
    },
  };
}

function createTimers() {
  let nextId = 1;
  const timers = [];
  return {
    setTimeout(fn, delay = 0) {
      const id = nextId += 1;
      timers.push({ id, fn, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
    runNextTimer() {
      let nextIndex = -1;
      let nextDelay = Number.POSITIVE_INFINITY;
      for (let index = 0; index < timers.length; index += 1) {
        const timer = timers[index];
        if (timer.cleared) continue;
        if (timer.delay < nextDelay) {
          nextDelay = timer.delay;
          nextIndex = index;
        }
      }
      if (nextIndex === -1) return false;
      const [timer] = timers.splice(nextIndex, 1);
      if (!timer.cleared) timer.fn();
      return true;
    },
    runAll() {
      while (this.runNextTimer()) {}
    },
  };
}

function flushAsync(turns = 6) {
  let chain = Promise.resolve();
  for (let index = 0; index < turns; index += 1) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return chain;
}

function createHarness() {
  const timers = createTimers();
  const layoutSubscribers = [];
  const layoutState = {
    isDesktop: false,
    keyboardOpen: false,
  };
  const createCalls = [];
  const focusComposerCalls = [];
  const virtualKeyboardCalls = [];
  const quickEntryFocusPrompt = createElement();
  const quickEntryFocusBtn = createElement();
  const msgInput = createElement();
  const location = {
    href: 'https://chat.example.com/?intent=new-session',
    pathname: '/',
    search: '?intent=new-session',
    hash: '',
    replace() {},
    assign() {},
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
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    history: {
      replaceState() {},
    },
    localStorage: createStorage(),
    navigator: {
      userAgent: 'Android',
      standalone: false,
      serviceWorker: null,
      virtualKeyboard: {
        show() {
          virtualKeyboardCalls.push(true);
        },
      },
    },
    window: {
      location,
      addEventListener() {},
      matchMedia(query) {
        return {
          matches: query === '(display-mode: standalone)',
          addEventListener() {},
        };
      },
      remotelabResolveProductPath(path) {
        return path;
      },
      RemoteLabLayout: {
        syncNow() {
          return { ...layoutState };
        },
        getState() {
          return { ...layoutState };
        },
        subscribe(listener) {
          layoutSubscribers.push(listener);
          return () => {
            const index = layoutSubscribers.indexOf(listener);
            if (index >= 0) layoutSubscribers.splice(index, 1);
          };
        },
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
      getElementById(id) {
        if (id === 'quickEntryFocusPrompt') return quickEntryFocusPrompt;
        if (id === 'quickEntryFocusBtn') return quickEntryFocusBtn;
        return null;
      },
      addEventListener() {},
      removeEventListener() {},
    },
    msgInput,
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
      return Promise.resolve();
    },
    restoreOwnerSessionSelection() {},
    connect() {},
    setupForegroundRefreshHandlers() {},
    loadModelsForCurrentTool() {
      return Promise.resolve();
    },
    focusComposer(options) {
      focusComposerCalls.push(options ?? null);
      msgInput.focus(options);
      return true;
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
    timers,
    layoutState,
    createCalls,
    focusComposerCalls,
    virtualKeyboardCalls,
    quickEntryFocusPrompt,
    quickEntryFocusBtn,
    msgInput,
  };
}

async function runInit(harness) {
  vm.runInNewContext(initSource, harness.context, { filename: 'static/chat/init.js' });
  await flushAsync();
}

const harness = createHarness();
await runInit(harness);

assert.equal(harness.createCalls.length, 1, 'quick-entry launch should still create a fresh session');
assert.equal(harness.focusComposerCalls.length, 1, 'quick-entry recovery should immediately attempt forced composer focus');
assert.equal(harness.focusComposerCalls[0]?.force, true, 'quick-entry recovery should use forced focus on mobile');
assert.equal(harness.virtualKeyboardCalls.length, 1, 'quick-entry recovery should ask supported browsers to show the virtual keyboard');
assert.equal(harness.quickEntryFocusPrompt.hidden, true, 'quick-entry prompt should stay hidden until the fallback timer fires');

harness.timers.runNextTimer();
assert.equal(harness.quickEntryFocusPrompt.hidden, false, 'quick-entry prompt should appear when the keyboard still has not opened');

harness.layoutState.keyboardOpen = true;
harness.quickEntryFocusBtn.click();
harness.timers.runAll();

assert.equal(harness.focusComposerCalls.length, 2, 'retrying from the prompt should focus the composer again inside the tap gesture');
assert.equal(harness.virtualKeyboardCalls.length, 2, 'retrying from the prompt should re-request the virtual keyboard');
assert.equal(harness.quickEntryFocusPrompt.hidden, true, 'prompt should dismiss once the layout reports an open keyboard');

console.log('test-chat-quick-entry-focus-prompt: ok');
