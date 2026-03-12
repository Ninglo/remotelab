#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const composeSource = readFileSync(join(repoRoot, 'static/chat/compose.js'), 'utf8');

class StorageMock {
  constructor() {
    this.store = new Map();
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

function makeEventTarget() {
  return {
    style: {},
    disabled: false,
    title: '',
    textContent: '',
    addEventListener() {},
    focus() {},
    click() {},
    classList: {
      toggle() {},
      contains() {
        return false;
      },
    },
  };
}

function createContext() {
  const msgInput = {
    value: '',
    scrollHeight: 12,
    style: { height: '' },
    addEventListener() {},
    focus() {},
  };
  const context = {
    console,
    msgInput,
    inputArea: {
      classList: {
        contains() {
          return false;
        },
      },
    },
    currentSessionId: 'session-a',
    localStorage: new StorageMock(),
    getComputedStyle() {
      return { lineHeight: '24' };
    },
    requestAnimationFrame(callback) {
      callback();
    },
    cancelBtn: makeEventTarget(),
    resumeBtn: makeEventTarget(),
    compactBtn: makeEventTarget(),
    dropToolsBtn: makeEventTarget(),
    sendBtn: makeEventTarget(),
    tabSessions: makeEventTarget(),
    tabProgress: makeEventTarget(),
    sessionListFooter: makeEventTarget(),
    newSessionBtn: makeEventTarget(),
    progressPanel: {
      textContent: '',
      classList: {
        toggle() {},
      },
    },
    sessionList: { style: {} },
    sidebarFilters: {
      classList: {
        toggle() {},
      },
    },
    pendingNavigationState: {},
    ACTIVE_SIDEBAR_TAB_STORAGE_KEY: 'activeSidebarTab',
    normalizeSidebarTab(value) {
      return value || 'sessions';
    },
    syncBrowserState() {},
    pendingImages: [],
    getCurrentSession() {
      return { archived: false };
    },
    createRequestId() {
      return 'req_test';
    },
    visitorMode: false,
    selectedTool: null,
    selectedModel: null,
    currentToolReasoningKind: 'toggle',
    selectedEffort: null,
    thinkingEnabled: true,
    renderImagePreviews() {},
    dispatchAction() {},
    emptyState: { parentNode: null, remove() {} },
    messagesInner: { appendChild() {}, innerHTML: '', children: [] },
    appendMessageTimestamp() {},
    scrollToBottom() {},
    URL: {
      revokeObjectURL() {},
    },
    document: {
      getElementById() {
        return null;
      },
      createElement() {
        return {
          appendChild() {},
          remove() {},
          className: '',
          id: '',
          textContent: '',
          innerHTML: '',
          style: {},
        };
      },
    },
  };
  context.globalThis = context;
  return context;
}

const context = createContext();
vm.runInNewContext(composeSource, context, { filename: 'static/chat/compose.js' });

context.msgInput.value = 'draft for A';
context.saveDraft();
assert.equal(context.localStorage.getItem('draft_session-a'), 'draft for A');

context.currentSessionId = 'session-b';
context.msgInput.value = 'stale text';
context.msgInput.style.height = '240px';
context.restoreDraft();
assert.equal(context.msgInput.value, '', 'switching to a session without a draft should clear the input');
assert.equal(context.msgInput.style.height, '72px', 'restoring an empty draft should still reset textarea height');

context.msgInput.value = 'draft for B';
context.saveDraft();
assert.equal(context.localStorage.getItem('draft_session-b'), 'draft for B');

context.currentSessionId = 'session-a';
context.restoreDraft();
assert.equal(context.msgInput.value, 'draft for A', 'switching back should restore that session draft only');

context.msgInput.value = '';
context.saveDraft();
assert.equal(context.localStorage.getItem('draft_session-a'), null, 'empty drafts should not leave stale storage behind');

context.currentSessionId = null;
context.msgInput.value = 'orphaned text';
context.restoreDraft();
assert.equal(context.msgInput.value, '', 'no attached session should present an empty composer');
