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

function makeClassList(initial = []) {
  const values = new Set(initial);
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

function makeEventTarget() {
  return {
    style: {},
    disabled: false,
    title: '',
    textContent: '',
    addEventListener() {},
    focus() {},
    click() {},
    setAttribute(name, value) {
      this[name] = value;
    },
    classList: makeClassList(),
  };
}

function createContext({
  storageSeed = {},
  chromeHeight = 48,
  windowInnerHeight = 900,
  visualViewportHeight = null,
} = {}) {
  const localStorage = new StorageMock();
  Object.entries(storageSeed).forEach(([key, value]) => {
    localStorage.setItem(key, value);
  });

  const inputAreaClassList = makeClassList();
  const msgInput = {
    value: '',
    scrollHeight: 12,
    style: { height: '' },
    readOnly: false,
    addEventListener() {},
    focus() {},
    getBoundingClientRect() {
      return { height: parseFloat(this.style.height) || 72 };
    },
  };
  const inputArea = {
    style: {},
    classList: inputAreaClassList,
    getBoundingClientRect() {
      return {
        height: (parseFloat(msgInput.style.height) || 72) + chromeHeight,
      };
    },
  };
  const voiceCleanupToggle = makeEventTarget();
  const document = {
    body: {
      classList: makeClassList(),
    },
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
      if (id === 'voiceCleanupToggle') return voiceCleanupToggle;
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
  };
  const windowResizeListeners = [];
  const visualViewportResizeListeners = [];
  const layoutSubscribers = [];
  const windowTarget = {
    innerHeight: windowInnerHeight,
    addEventListener(type, listener) {
      if (type === 'resize') windowResizeListeners.push(listener);
    },
    visualViewport: {
      height: visualViewportHeight,
      addEventListener(type, listener) {
        if (type === 'resize') visualViewportResizeListeners.push(listener);
      },
    },
  };
  const focusComposerCalls = [];
  const consoleMock = { ...console, warn() {} };
  const remoteLabLayout = {
    getViewportHeight() {
      const managedHeight = windowTarget.visualViewport?.height;
      if (Number.isFinite(managedHeight) && managedHeight > 0) {
        return managedHeight;
      }
      return windowTarget.innerHeight || 0;
    },
    subscribe(listener) {
      layoutSubscribers.push(listener);
      return () => {};
    },
  };
  windowTarget.RemoteLabLayout = remoteLabLayout;
  const context = {
    console: consoleMock,
    msgInput,
    inputArea,
    inputResizeHandle: makeEventTarget(),
    focusComposerCalls,
    layoutSubscribers,
    windowResizeListeners,
    visualViewportResizeListeners,
    currentSessionId: 'session-a',
    localStorage,
    window: windowTarget,
    getComputedStyle() {
      return { lineHeight: '24' };
    },
    requestAnimationFrame(callback) {
      callback();
    },
    cancelBtn: makeEventTarget(),
    compactBtn: makeEventTarget(),
    dropToolsBtn: makeEventTarget(),
    sendBtn: makeEventTarget(),
    composerPendingState: makeEventTarget(),
    voiceCleanupToggle,
    sessionTemplateSelect: makeEventTarget(),
    saveTemplateBtn: makeEventTarget(),
    tabSessions: makeEventTarget(),
    tabBoard: makeEventTarget(),
    tabSettings: makeEventTarget(),
    sessionListFooter: makeEventTarget(),
    newAppBtn: makeEventTarget(),
    newSessionBtn: makeEventTarget(),
    boardPanel: {
      classList: {
        toggle() {},
      },
    },
    settingsPanel: {
      classList: {
        toggle() {},
      },
    },
    sessionList: { style: {} },
    sidebarOverlay: makeEventTarget(),
    sidebarFilters: {
      classList: {
        toggle() {},
      },
    },
    pendingNavigationState: {},
    ACTIVE_SIDEBAR_TAB_STORAGE_KEY: 'activeSidebarTab',
    normalizeSidebarTab(value) {
      return value === 'settings' || value === 'progress' ? 'settings' : 'sessions';
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
    isDesktop: true,
    selectedTool: null,
    selectedModel: null,
    currentToolReasoningKind: 'toggle',
    selectedEffort: null,
    thinkingEnabled: true,
    renderImagePreviews() {},
    fetchJsonOrRedirect() {
      throw new Error('Unexpected fetchJsonOrRedirect call');
    },
    dispatchAction() {},
    emptyState: { parentNode: null, remove() {} },
    messagesInner: { appendChild() {}, innerHTML: '', children: [] },
    appendMessageTimestamp() {},
    scrollToBottom() {},
    focusComposer(options) {
      focusComposerCalls.push(options ?? null);
      msgInput.focus(options);
      return true;
    },
    URL: {
      revokeObjectURL() {},
    },
    document,
  };
  context.globalThis = context;
  return context;
}

const context = createContext();
vm.runInNewContext(composeSource, context, { filename: 'static/chat/compose.js' });

assert.equal(context.msgInput.style.height, '72px', 'composer should default to a 3-line height');
assert.equal(context.layoutSubscribers.length, 1, 'composer should subscribe to the shared layout controller');
assert.equal(context.windowResizeListeners.length, 0, 'composer should not attach its own window resize listener when the shared layout controller exists');
assert.equal(context.visualViewportResizeListeners.length, 0, 'composer should not attach its own visual viewport resize listener when the shared layout controller exists');
assert.equal(context.isComposerVoiceCleanupEnabled(), true, 'voice cleanup should default to enabled when no explicit preference has been stored');
assert.equal(context.voiceCleanupToggle['aria-pressed'], 'true', 'the voice cleanup toggle should render as enabled by default');
assert.equal(context.voiceCleanupToggle.classList.contains('active'), true, 'the voice cleanup toggle should surface its enabled styling by default');

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

const manualContext = createContext();
vm.runInNewContext(composeSource, manualContext, { filename: 'static/chat/compose.js' });
manualContext.setManualInputHeight(220);
assert.equal(manualContext.msgInput.style.height, '220px', 'manual resize should write to the textarea height directly');
assert.equal(manualContext.localStorage.getItem('msgInputHeight'), '220', 'manual resize should persist textarea height');
assert.equal(manualContext.inputArea.classList.contains('is-resized'), true, 'manual resize should mark the composer as manually sized');

manualContext.window.innerHeight = 180;
manualContext.syncInputHeightForLayout();
assert.equal(manualContext.msgInput.style.height, '100px', 'manual resize should clamp against the current viewport instead of leaving stale oversized UI');

const legacyContext = createContext({
  storageSeed: {
    inputAreaHeight: '240',
  },
});
vm.runInNewContext(composeSource, legacyContext, { filename: 'static/chat/compose.js' });
assert.equal(legacyContext.msgInput.style.height, '192px', 'legacy container height should migrate into a textarea height');
assert.equal(legacyContext.localStorage.getItem('msgInputHeight'), '192', 'legacy height should be migrated into the new textarea storage key');
assert.equal(legacyContext.localStorage.getItem('inputAreaHeight'), null, 'legacy height storage should be cleared after migration');

const standaloneViewportContext = createContext({
  windowInnerHeight: 500,
  visualViewportHeight: 260,
});
vm.runInNewContext(composeSource, standaloneViewportContext, { filename: 'static/chat/compose.js' });
standaloneViewportContext.setManualInputHeight(220);
standaloneViewportContext.syncInputHeightForLayout();
assert.equal(standaloneViewportContext.msgInput.style.height, '139px', 'manual composer height should clamp against visualViewport height when available');

const failedSendFocusContext = createContext();
vm.runInNewContext(composeSource, failedSendFocusContext, { filename: 'static/chat/compose.js' });
failedSendFocusContext.restoreFailedSendState('session-a', 'retry me', []);
assert.equal(failedSendFocusContext.focusComposerCalls.length, 1, 'failed-send recovery should invoke the shared focus helper once');
assert.equal(failedSendFocusContext.focusComposerCalls[0]?.force, true, 'failed-send recovery should force composer focus when rehydrating the draft');
assert.equal(failedSendFocusContext.focusComposerCalls[0]?.preventScroll, true, 'failed-send recovery should keep the viewport from jumping during draft recovery');

const canonicalSendContext = createContext();
const canonicalSendCalls = [];
canonicalSendContext.dispatchAction = async (payload) => {
  canonicalSendCalls.push(payload);
  return true;
};
vm.runInNewContext(composeSource, canonicalSendContext, { filename: 'static/chat/compose.js' });
canonicalSendContext.msgInput.value = 'hold the draft until confirmed';
canonicalSendContext.saveDraft();
canonicalSendContext.sendMessage();
await Promise.resolve();
assert.equal(canonicalSendCalls.length, 1, 'send should still dispatch exactly one message request');
assert.equal(canonicalSendContext.msgInput.value, 'hold the draft until confirmed', 'send should keep the composer text visible until canonical state confirms it');
assert.equal(canonicalSendContext.msgInput.readOnly, true, 'composer should become read-only while the send is pending');
assert.equal(canonicalSendContext.inputArea.classList.contains('is-pending-send'), true, 'pending sends should gray the composer instead of injecting an optimistic chat bubble');
assert.equal(canonicalSendContext.localStorage.getItem('draft_session-a'), null, 'pending sends should not leave a durable draft behind once the outbound request is in flight');
assert.equal(canonicalSendContext.composerPendingState.classList.contains('visible'), true, 'pending sends should surface a lightweight sending indicator in the composer');
canonicalSendContext.msgInput.value = '';
canonicalSendContext.restoreDraft();
assert.equal(canonicalSendContext.msgInput.value, 'hold the draft until confirmed', 'the active page should still rehydrate the pending send from memory while it is in flight');

const reloadedPendingSendContext = createContext({
  storageSeed: Object.fromEntries(canonicalSendContext.localStorage.store),
});
vm.runInNewContext(composeSource, reloadedPendingSendContext, { filename: 'static/chat/compose.js' });
reloadedPendingSendContext.restoreDraft();
assert.equal(reloadedPendingSendContext.msgInput.value, '', 'reloading the page should not resurrect a stale sending draft after the durable draft has been cleared');

canonicalSendContext.reconcileComposerPendingSendWithEvent({
  type: 'message',
  role: 'user',
  requestId: 'req_test',
});
assert.equal(canonicalSendContext.msgInput.value, '', 'confirmed sends should clear the composer only after the canonical user event arrives');
assert.equal(canonicalSendContext.msgInput.readOnly, false, 'confirmed sends should restore the composer input state');
assert.equal(canonicalSendContext.inputArea.classList.contains('is-pending-send'), false, 'confirmed sends should remove the pending composer styling');
assert.equal(canonicalSendContext.localStorage.getItem('draft_session-a'), null, 'confirmed sends should clear the stored draft');

const cleanupSendContext = createContext({
  storageSeed: {
    composerVoiceCleanupBeforeSend: '1',
  },
});
const cleanupRequests = [];
const cleanupDispatchCalls = [];
let resolveCleanupRequest = null;
cleanupSendContext.fetchJsonOrRedirect = (url, options) => {
  cleanupRequests.push({ url, options });
  return new Promise((resolve) => {
    resolveCleanupRequest = () => resolve({ transcript: 'cleaned transcript', rewriteApplied: true });
  });
};
cleanupSendContext.dispatchAction = async (payload) => {
  cleanupDispatchCalls.push(payload);
  return true;
};
vm.runInNewContext(composeSource, cleanupSendContext, { filename: 'static/chat/compose.js' });
cleanupSendContext.msgInput.value = 'rough transcript';
cleanupSendContext.sendMessage();
assert.equal(cleanupSendContext.composerPendingState.textContent, 'Cleaning transcript…', 'voice-cleanup sends should surface a cleanup stage before dispatching the message');
assert.equal(cleanupRequests.length, 1, 'voice-cleanup sends should call the hidden cleanup endpoint first');
assert.equal(cleanupDispatchCalls.length, 0, 'voice-cleanup sends should wait for cleanup before dispatching the message');
resolveCleanupRequest();
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(cleanupDispatchCalls.length, 1, 'voice-cleanup sends should dispatch once cleanup resolves');
assert.equal(cleanupDispatchCalls[0].text, 'cleaned transcript', 'voice-cleanup sends should forward the cleaned transcript to the normal send path');
assert.equal(cleanupRequests[0].url, '/api/sessions/session-a/voice-transcriptions', 'voice-cleanup sends should reuse the hidden transcript cleanup endpoint');
assert.deepEqual(JSON.parse(cleanupRequests[0].options.body), {
  persistAudio: false,
  rewriteWithContext: true,
  providedTranscript: 'rough transcript',
}, 'voice-cleanup sends should request a transcript-only cleanup pass');

const cleanupFallbackContext = createContext({
  storageSeed: {
    composerVoiceCleanupBeforeSend: '1',
  },
});
const cleanupFallbackDispatchCalls = [];
cleanupFallbackContext.fetchJsonOrRedirect = async () => {
  throw new Error('cleanup unavailable');
};
cleanupFallbackContext.dispatchAction = async (payload) => {
  cleanupFallbackDispatchCalls.push(payload);
  return true;
};
vm.runInNewContext(composeSource, cleanupFallbackContext, { filename: 'static/chat/compose.js' });
cleanupFallbackContext.msgInput.value = 'keep original text';
cleanupFallbackContext.sendMessage();
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(cleanupFallbackDispatchCalls.length, 1, 'failed voice cleanup should still fall back to a normal send');
assert.equal(cleanupFallbackDispatchCalls[0].text, 'keep original text', 'failed voice cleanup should send the original text unchanged');
assert.equal(cleanupFallbackContext.composerPendingState.textContent, 'Sending…', 'cleanup fallback should advance the composer back into the normal sending state');

const queuedSendContext = createContext();
queuedSendContext.dispatchAction = async () => true;
vm.runInNewContext(composeSource, queuedSendContext, { filename: 'static/chat/compose.js' });
queuedSendContext.msgInput.value = 'queue this follow-up';
queuedSendContext.saveDraft();
queuedSendContext.sendMessage();
await Promise.resolve();
queuedSendContext.reconcileComposerPendingSendWithSession({
  id: 'session-a',
  queuedMessages: [{ requestId: 'req_test' }],
});
assert.equal(queuedSendContext.msgInput.value, '', 'queued sends should clear the composer once the server reflects the queued request');
assert.equal(queuedSendContext.localStorage.getItem('draft_session-a'), null, 'queued sends should also clear the stored draft after server confirmation');

const runningTakeoverContext = createContext();
runningTakeoverContext.dispatchAction = async () => true;
runningTakeoverContext.getCurrentSession = () => ({
  archived: false,
  activity: {
    run: { state: 'idle', phase: null, runId: null },
    queue: { state: 'idle', count: 0 },
  },
});
vm.runInNewContext(composeSource, runningTakeoverContext, { filename: 'static/chat/compose.js' });
runningTakeoverContext.msgInput.value = 'turn this into a real run';
runningTakeoverContext.saveDraft();
runningTakeoverContext.sendMessage();
await Promise.resolve();
assert.equal(runningTakeoverContext.msgInput.readOnly, true, 'composer should briefly lock before the server confirms acceptance');
runningTakeoverContext.reconcileComposerPendingSendWithSession({
  id: 'session-a',
  activity: {
    run: { state: 'running', phase: 'running', runId: 'run_1' },
    queue: { state: 'idle', count: 0 },
  },
});
assert.equal(runningTakeoverContext.msgInput.value, '', 'server running state should immediately clear the local sending draft');
assert.equal(runningTakeoverContext.msgInput.readOnly, false, 'server running state should immediately unlock the composer');
assert.equal(runningTakeoverContext.inputArea.classList.contains('is-pending-send'), false, 'server running state should remove pending-send styling');

const runningBaselineContext = createContext();
runningBaselineContext.dispatchAction = async () => true;
runningBaselineContext.getCurrentSession = () => ({
  archived: false,
  activity: {
    run: { state: 'running', phase: 'running', runId: 'run_existing' },
    queue: { state: 'idle', count: 0 },
  },
});
vm.runInNewContext(composeSource, runningBaselineContext, { filename: 'static/chat/compose.js' });
runningBaselineContext.msgInput.value = 'queue behind the current run';
runningBaselineContext.saveDraft();
runningBaselineContext.sendMessage();
await Promise.resolve();
runningBaselineContext.reconcileComposerPendingSendWithSession({
  id: 'session-a',
  activity: {
    run: { state: 'running', phase: 'running', runId: 'run_existing' },
    queue: { state: 'idle', count: 0 },
  },
});
assert.equal(runningBaselineContext.msgInput.readOnly, true, 'an already-running session should not clear a new pending send until the queue confirmation arrives');
runningBaselineContext.reconcileComposerPendingSendWithSession({
  id: 'session-a',
  activity: {
    run: { state: 'running', phase: 'running', runId: 'run_existing' },
    queue: { state: 'queued', count: 1 },
  },
});
assert.equal(runningBaselineContext.msgInput.value, '', 'queue confirmation should clear the pending composer state for follow-up sends');
assert.equal(runningBaselineContext.msgInput.readOnly, false, 'queue confirmation should unlock the composer for another follow-up');

const failedSendContext = createContext();
failedSendContext.dispatchAction = async () => true;
vm.runInNewContext(composeSource, failedSendContext, { filename: 'static/chat/compose.js' });
failedSendContext.msgInput.value = 'retry this request';
failedSendContext.saveDraft();
failedSendContext.sendMessage();
await Promise.resolve();
assert.equal(failedSendContext.localStorage.getItem('draft_session-a'), null, 'pending sends should clear the stored draft before the request is confirmed');
failedSendContext.restoreFailedSendState('session-a', 'retry this request', [], 'req_test');
assert.equal(failedSendContext.msgInput.readOnly, false, 'failed sends should restore the composer input state');
assert.equal(failedSendContext.localStorage.getItem('draft_session-a'), 'retry this request', 'failed sends should put the draft back into durable storage for retry');

console.log('test-chat-compose-draft: ok');
