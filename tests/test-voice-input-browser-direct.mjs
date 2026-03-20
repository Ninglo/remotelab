#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

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

function createElement(id = '') {
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    title: '',
    files: null,
    className: '',
    style: {},
    classList: createClassList(),
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(name, value) {
      this[name] = value;
    },
    focus() {},
    dispatchEvent() {},
  };
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

class MockRecognition {
  constructor() {
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 1;
    this.started = false;
    MockRecognition.instance = this;
  }

  start() {
    this.started = true;
  }

  stop() {
    this.started = false;
    queueMicrotask(() => this.onend?.());
  }
}

const elements = new Map();
for (const id of ['voiceInputBtn', 'voiceFileInput', 'voiceInputStatus', 'voiceSettingsMount', 'msgInput']) {
  elements.set(id, createElement(id));
}

const document = {
  getElementById(id) {
    return elements.get(id) || null;
  },
  createElement(tagName) {
    return createElement(tagName);
  },
};

const fetchCalls = [];
const localStorage = createStorage();
localStorage.setItem('voiceInputPrefs', JSON.stringify({
  captureMode: 'browser-direct',
  attachOriginalAudio: false,
  autoSend: true,
  rewriteWithContext: true,
  version: 4,
}));
let voiceInputConfig = {
  enabled: true,
  configured: false,
  language: 'zh-CN',
};
const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval() {
    return 0;
  },
  clearInterval() {},
  Event: class Event {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
    }
  },
  document,
  window: {
    SpeechRecognition: MockRecognition,
    setTimeout,
    clearTimeout,
    setInterval() {
      return 0;
    },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    location: {
      protocol: 'https:',
      host: 'example.com',
    },
    __REMOTELAB_BUILD__: { assetVersion: 'test-build' },
    __REMOTELAB_BOOTSTRAP__: { auth: { role: 'owner' } },
  },
  localStorage,
  pageBootstrap: { auth: { role: 'owner' } },
  currentSessionId: 'session-voice-browser-direct',
  shareSnapshotMode: false,
  msgInput: elements.get('msgInput'),
  pendingImages: [],
  renderImagePreviews() {},
  focusComposer() {},
  hasPendingComposerSend() {
    return false;
  },
  sendMessageCalls: 0,
  sendMessage() {
    context.sendMessageCalls += 1;
  },
  switchTab() {},
  fetchJsonOrRedirect: async (path, options = {}) => {
    fetchCalls.push({ path, options });
    if (path === '/api/voice-input/config') {
      return { config: voiceInputConfig };
    }
    return {
      transcript: '洗过的一句话',
      rewriteApplied: true,
      attachment: null,
    };
  },
  navigator: {},
};

context.globalThis = context;
context.self = context.window;
context.window.window = context.window;
context.window.document = document;
context.window.localStorage = context.localStorage;
context.window.navigator = context.navigator;
context.window.pageBootstrap = context.pageBootstrap;
context.window.msgInput = context.msgInput;

vm.runInNewContext(
  readFileSync(join(repoRoot, 'static', 'chat', 'voice-input.js'), 'utf8'),
  context,
  { filename: 'static/chat/voice-input.js' },
);

await new Promise((resolve) => setTimeout(resolve, 0));

await context.handleVoiceInputClick();
assert.equal(MockRecognition.instance.started, true, 'browser direct recognition should start');

MockRecognition.instance.onresult?.({
  results: [
    { isFinal: false, 0: { transcript: '实时字幕测试' } },
  ],
});

assert.match(context.msgInput.value, /实时字幕测试/, 'interim transcript should appear in the composer');
assert.equal(context.msgInput.classList.contains('is-voice-live'), true, 'composer should show the in-progress voice style');

await context.handleVoiceInputClick();
await new Promise((resolve) => setTimeout(resolve, 0));

const submitCall = fetchCalls.find((entry) => /voice-transcriptions/.test(entry.path));
assert.ok(submitCall, 'stopping browser direct capture should submit the final transcript');
assert.equal(submitCall.options.method, 'POST');
assert.equal(submitCall.options.headers['Content-Type'], 'application/json');
assert.equal(JSON.parse(submitCall.options.body).providedTranscript, '实时字幕测试');
assert.equal(context.sendMessageCalls, 1, 'empty composer + auto-send should trigger sendMessage');

voiceInputConfig = {
  enabled: true,
  configured: true,
  providerLabel: 'Volcengine',
  modelLabel: 'Mock Voice Model',
  language: 'zh-CN',
};
localStorage.setItem('voiceInputPrefs', JSON.stringify({
  captureMode: 'browser-direct',
  attachOriginalAudio: false,
  autoSend: true,
  rewriteWithContext: false,
  version: 3,
}));
await context.loadVoiceInputConfig();

const migratedPrefs = context.readVoiceInputPrefs();
assert.equal(migratedPrefs.captureMode, 'server-relay', 'legacy browser-direct default should migrate back to server relay');
assert.equal(migratedPrefs.rewriteWithContext, false, 'legacy prefs should preserve the other toggles');
assert.equal(context.resolveVoiceCaptureMode(migratedPrefs), 'server-relay', 'configured relay should become the active capture mode after migration');

const storedPrefs = JSON.parse(localStorage.getItem('voiceInputPrefs'));
assert.equal(storedPrefs.version, 4, 'migrated prefs should be rewritten at the latest version');
assert.equal(storedPrefs.captureMode, 'server-relay', 'migrated prefs should persist the repaired default');

console.log('test-voice-input-browser-direct: ok');
