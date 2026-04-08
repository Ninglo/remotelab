#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const filesToParse = [
  join(repoRoot, 'static', 'chat.js'),
  join(repoRoot, 'static', 'chat', 'i18n.js'),
  join(repoRoot, 'static', 'chat', 'session-store.js'),
  join(repoRoot, 'static', 'chat', 'composer-store.js'),
  join(repoRoot, 'static', 'chat', 'bootstrap.js'),
  join(repoRoot, 'static', 'chat', 'bootstrap-session-catalog.js'),
  join(repoRoot, 'static', 'chat', 'layout-tooling.js'),
  join(repoRoot, 'static', 'chat', 'tooling.js'),
  join(repoRoot, 'static', 'chat', 'realtime.js'),
  join(repoRoot, 'static', 'chat', 'session-list-ui.js'),
  join(repoRoot, 'static', 'chat', 'settings-ui.js'),
  join(repoRoot, 'static', 'chat', 'sidebar-ui.js'),
  join(repoRoot, 'static', 'chat', 'compose.js'),
  join(repoRoot, 'static', 'chat', 'init.js'),
];

for (const filePath of filesToParse) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `${filePath} should parse cleanly.\n${result.stderr || result.stdout}`,
  );
}

function createClassList() {
  const classes = new Set();
  return {
    add(...tokens) {
      tokens.forEach((token) => classes.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => classes.delete(token));
    },
    toggle(token, force) {
      if (force === true) {
        classes.add(token);
        return true;
      }
      if (force === false) {
        classes.delete(token);
        return false;
      }
      if (classes.has(token)) {
        classes.delete(token);
        return false;
      }
      classes.add(token);
      return true;
    },
    contains(token) {
      return classes.has(token);
    },
  };
}

function createStyle() {
  const values = new Map();
  return {
    setProperty(name, value) {
      values.set(name, value);
    },
    getPropertyValue(name) {
      return values.get(name) || '';
    },
  };
}

function createElement(tagName = 'div') {
  return {
    tagName: String(tagName || 'div').toUpperCase(),
    value: '',
    checked: false,
    disabled: false,
    readOnly: false,
    hidden: false,
    textContent: '',
    innerHTML: '',
    title: '',
    dataset: {},
    style: createStyle(),
    classList: createClassList(),
    children: [],
    files: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name] || null;
    },
    removeAttribute(name) {
      delete this[name];
    },
    focus() {},
    blur() {},
    click() {},
    select() {},
    remove() {},
    closest() { return null; },
    matches() { return false; },
    contains() { return false; },
    querySelector() { return createElement('div'); },
    querySelectorAll() { return []; },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    scrollIntoView() {},
    setPointerCapture() {},
    releasePointerCapture() {},
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

const elements = new Map();
function getElementById(id) {
  if (!elements.has(id)) {
    elements.set(id, createElement('div'));
  }
  return elements.get(id);
}

const documentElement = createElement('html');
const body = createElement('body');

const context = {
  console: {
    info() {},
    log() {},
    warn() {},
    error(...args) {
      throw new Error(args.map((value) => String(value)).join(' '));
    },
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  URL,
  URLSearchParams,
  Date,
  Map,
  Set,
  WeakMap,
  Promise,
  JSON,
  Math,
  Intl,
  getComputedStyle() {
    return {
      lineHeight: '24px',
      paddingTop: '0px',
      paddingBottom: '0px',
      borderTopWidth: '0px',
      borderBottomWidth: '0px',
    };
  },
  fetch: async () => ({
    ok: true,
    status: 200,
    async json() { return {}; },
    async text() { return ''; },
  }),
  history: {
    replaceState() {},
    pushState() {},
  },
  localStorage: createStorage(),
  sessionStorage: createStorage(),
  navigator: {
    clipboard: {
      async writeText() {},
    },
    serviceWorker: null,
  },
  Notification: {
    permission: 'denied',
    requestPermission: async () => 'denied',
  },
  performance: {
    now: () => 0,
  },
  requestAnimationFrame(callback) {
    return setTimeout(() => callback(0), 0);
  },
  cancelAnimationFrame(handle) {
    clearTimeout(handle);
  },
  marked: {
    use() {},
  },
  copyText: async () => {},
  crypto: {
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
  },
  document: {
    documentElement,
    body,
    currentScript: { nonce: '' },
    getElementById,
    createElement,
    querySelector() { return createElement('div'); },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  },
  window: {
    location: {
      href: 'http://127.0.0.1:7690/',
      origin: 'http://127.0.0.1:7690',
      search: '',
      pathname: '/',
      reload() {},
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame(callback) {
      return setTimeout(() => callback(0), 0);
    },
    cancelAnimationFrame(handle) {
      clearTimeout(handle);
    },
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      };
    },
    visualViewport: {
      height: 800,
      addEventListener() {},
      removeEventListener() {},
    },
    RemoteLabSessionStateModel: {
      createEmptyStatus() {
        return {};
      },
      normalizeSessionActivity(session) {
        return session?.activity || null;
      },
      isSessionBusy() {
        return false;
      },
      getSessionStatusSummary() {
        return { primary: { label: 'Idle', tone: 'idle' } };
      },
    },
    __REMOTELAB_BUILD__: { assetVersion: 'test-build', title: 'test build' },
    __REMOTELAB_BOOTSTRAP__: { auth: { role: 'owner' } },
  },
};

context.globalThis = context;
context.self = context.window;
context.window.window = context.window;
context.window.document = context.document;
context.window.localStorage = context.localStorage;
context.window.sessionStorage = context.sessionStorage;
context.window.history = context.history;
context.window.navigator = context.navigator;
context.window.Notification = context.Notification;
context.window.performance = context.performance;
context.window.URL = URL;
context.window.URLSearchParams = URLSearchParams;
context.window.fetch = context.fetch;
context.window.marked = context.marked;
context.window.crypto = context.crypto;
context.window.getComputedStyle = context.getComputedStyle;

const orderedFiles = [
  'i18n.js',
  'session-store.js',
  'composer-store.js',
  'bootstrap.js',
  'bootstrap-session-catalog.js',
  'layout-tooling.js',
  'tooling.js',
  'settings-ui.js',
  'sidebar-ui.js',
  'compose.js',
];

for (const fileName of orderedFiles) {
  const source = readFileSync(join(repoRoot, 'static', 'chat', fileName), 'utf8');
  vm.runInNewContext(source, context, { filename: `static/chat/${fileName}` });
}

await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(typeof context.readNavigationStateFromLocation, 'function');
assert.equal(typeof context.createNewSessionShortcut, 'function');
assert.equal(typeof context.createSortSessionListShortcut, 'function');
assert.equal(typeof context.switchTab, 'function');

console.log('test-chat-split-frontend-smoke: ok');
process.exit(0);
