#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const composerStoreSource = readFileSync(join(repoRoot, 'static/chat/composer-store.js'), 'utf8');
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
  const document = {
    body: {
      classList: makeClassList(),
    },
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
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
    sessionTemplateSelect: makeEventTarget(),
    saveTemplateBtn: makeEventTarget(),
    tabSessions: makeEventTarget(),
    tabSettings: makeEventTarget(),
    sessionListFooter: makeEventTarget(),
    sortSessionListBtn: makeEventTarget(),
    newSessionBtn: makeEventTarget(),
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

function loadComposeContext(context) {
  vm.runInNewContext(composerStoreSource, context, { filename: 'static/chat/composer-store.js' });
  vm.runInNewContext(composeSource, context, { filename: 'static/chat/compose.js' });
  return context;
}

const context = createContext();
loadComposeContext(context);

assert.equal(context.msgInput.style.height, '72px', 'composer should default to a 3-line height');
assert.equal(context.layoutSubscribers.length, 1, 'composer should subscribe to the shared layout controller');
assert.equal(context.windowResizeListeners.length, 0, 'composer should not attach its own window resize listener when the shared layout controller exists');
assert.equal(context.visualViewportResizeListeners.length, 0, 'composer should not attach its own visual viewport resize listener when the shared layout controller exists');

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
loadComposeContext(manualContext);
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
loadComposeContext(legacyContext);
assert.equal(legacyContext.msgInput.style.height, '192px', 'legacy container height should migrate into a textarea height');
assert.equal(legacyContext.localStorage.getItem('msgInputHeight'), '192', 'legacy height should be migrated into the new textarea storage key');
assert.equal(legacyContext.localStorage.getItem('inputAreaHeight'), null, 'legacy height storage should be cleared after migration');

const standaloneViewportContext = createContext({
  windowInnerHeight: 500,
  visualViewportHeight: 260,
});
loadComposeContext(standaloneViewportContext);
standaloneViewportContext.setManualInputHeight(220);
standaloneViewportContext.syncInputHeightForLayout();
assert.equal(standaloneViewportContext.msgInput.style.height, '139px', 'manual composer height should clamp against visualViewport height when available');

const failedSendFocusContext = createContext();
loadComposeContext(failedSendFocusContext);
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
loadComposeContext(canonicalSendContext);
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
loadComposeContext(reloadedPendingSendContext);
reloadedPendingSendContext.restoreDraft();
assert.equal(reloadedPendingSendContext.msgInput.value, '', 'reloading the page should not resurrect a stale sending draft after the durable draft has been cleared');

const attachmentSendContext = createContext();
const attachmentSendCalls = [];
const revokedAttachmentUrls = [];
attachmentSendContext.URL.revokeObjectURL = (value) => {
  revokedAttachmentUrls.push(value);
};
attachmentSendContext.dispatchAction = async (payload) => {
  attachmentSendCalls.push(payload);
  return true;
};
loadComposeContext(attachmentSendContext);
attachmentSendContext.replaceComposerAttachmentsState(
  [{ objectUrl: 'blob:attachment-1', originalName: 'shot-1.png', mimeType: 'image/png' }],
  { sessionId: 'session-a' },
);
attachmentSendContext.sendMessage();
await Promise.resolve();
assert.equal(attachmentSendCalls[0]?.images?.length, 1, 'attachment-only sends should forward queued attachments through the canonical send payload');
assert.equal(attachmentSendContext.getComposerAttachmentsState('session-a').length, 1, 'attachment-only sends should keep queued attachments visible until canonical confirmation');
attachmentSendContext.reconcileComposerPendingSendWithEvent({
  type: 'message',
  role: 'user',
  requestId: 'req_test',
});
assert.equal(attachmentSendContext.getComposerAttachmentsState('session-a').length, 0, 'confirmed attachment sends should clear queued attachments from the composer slice');
assert.deepEqual(revokedAttachmentUrls, ['blob:attachment-1'], 'confirmed attachment sends should release local preview URLs after canonical confirmation');

const attachmentClickSendContext = createContext();
const attachmentClickSendCalls = [];
attachmentClickSendContext.dispatchAction = async (payload) => {
  attachmentClickSendCalls.push(payload);
  return true;
};
loadComposeContext(attachmentClickSendContext);
attachmentClickSendContext.replaceComposerAttachmentsState(
  [{ objectUrl: 'blob:attachment-click', originalName: 'shot-click.png', mimeType: 'image/png' }],
  { sessionId: 'session-a' },
);
attachmentClickSendContext.sendMessage({ isTrusted: true });
await Promise.resolve();
assert.equal(attachmentClickSendCalls.length, 1, 'attachment sends triggered from a button click should still dispatch');
assert.equal(attachmentClickSendCalls[0]?.requestId, 'req_test', 'button-click sends should ignore DOM event objects and generate a real request id');
assert.equal(attachmentClickSendCalls[0]?.images?.length, 1, 'button-click attachment sends should preserve queued attachments');

canonicalSendContext.reconcileComposerPendingSendWithEvent({
  type: 'message',
  role: 'user',
  requestId: 'req_test',
});
assert.equal(canonicalSendContext.msgInput.value, '', 'confirmed sends should clear the composer only after the canonical user event arrives');
assert.equal(canonicalSendContext.msgInput.readOnly, false, 'confirmed sends should restore the composer input state');
assert.equal(canonicalSendContext.inputArea.classList.contains('is-pending-send'), false, 'confirmed sends should remove the pending composer styling');
assert.equal(canonicalSendContext.localStorage.getItem('draft_session-a'), null, 'confirmed sends should clear the stored draft');

const queuedSendContext = createContext();
queuedSendContext.dispatchAction = async () => true;
loadComposeContext(queuedSendContext);
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
loadComposeContext(runningTakeoverContext);
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
loadComposeContext(runningBaselineContext);
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
loadComposeContext(failedSendContext);
failedSendContext.msgInput.value = 'retry this request';
failedSendContext.saveDraft();
failedSendContext.sendMessage();
await Promise.resolve();
assert.equal(failedSendContext.localStorage.getItem('draft_session-a'), null, 'pending sends should clear the stored draft before the request is confirmed');
failedSendContext.restoreFailedSendState('session-a', 'retry this request', [], 'req_test');
assert.equal(failedSendContext.msgInput.readOnly, false, 'failed sends should restore the composer input state');
assert.equal(failedSendContext.localStorage.getItem('draft_session-a'), 'retry this request', 'failed sends should put the draft back into durable storage for retry');
assert.equal(failedSendContext.getComposerDraftTextState('session-a'), 'retry this request', 'failed sends should also restore the composer store draft for retry');

const directUploadSendContext = createContext();
const directUploadSendCalls = [];
const directUploadFetchJsonCalls = [];
directUploadSendContext.getBootstrapAssetUploads = () => ({
  enabled: true,
  directUpload: true,
  provider: 'tos',
});
directUploadSendContext.fetch = async (url, options = {}) => {
  if (url !== 'https://tos.example/upload') {
    throw new Error(`Unexpected upload url: ${url}`);
  }
  assert.equal(options.method, 'PUT', 'direct upload should use PUT');
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'etag' ? 'etag-direct-upload' : '';
      },
    },
  };
};
directUploadSendContext.fetchJsonOrRedirect = async (url, options = {}) => {
  directUploadFetchJsonCalls.push({ url, options });
  if (url === '/api/assets/upload-intents') {
    return {
      asset: {
        id: 'fasset_uploaded',
        originalName: 'large-video.mov',
        mimeType: 'video/quicktime',
        sizeBytes: 18,
        downloadUrl: '/api/assets/fasset_uploaded/download',
      },
      upload: {
        method: 'PUT',
        url: 'https://tos.example/upload',
        headers: {
          'Content-Type': 'video/quicktime',
        },
      },
    };
  }
  if (url === '/api/assets/fasset_uploaded/finalize') {
    return {
      asset: {
        id: 'fasset_uploaded',
        originalName: 'large-video.mov',
        mimeType: 'video/quicktime',
        sizeBytes: 18,
        downloadUrl: '/api/assets/fasset_uploaded/download',
      },
    };
  }
  throw new Error(`Unexpected fetchJsonOrRedirect call: ${url}`);
};
directUploadSendContext.dispatchAction = async (payload) => {
  directUploadSendCalls.push(payload);
  return true;
};
loadComposeContext(directUploadSendContext);
directUploadSendContext.replaceComposerAttachmentsState(
  [{
    localId: 'cattach_test',
    file: {
      name: 'large-video.mov',
      type: 'video/quicktime',
      size: 18,
      async arrayBuffer() {
        return Buffer.from('direct-upload-body');
      },
    },
    objectUrl: 'blob:large-video',
    originalName: 'large-video.mov',
    mimeType: 'video/quicktime',
    sizeBytes: 18,
    uploadState: 'queued',
  }],
  { sessionId: 'session-a' },
);
directUploadSendContext.sendMessage();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(directUploadFetchJsonCalls.length, 2, 'direct-upload send should create an upload intent and finalize the uploaded asset');
assert.equal(directUploadSendCalls.length, 1, 'direct-upload send should still dispatch exactly one message');
assert.equal(directUploadSendCalls[0]?.images?.length, 1, 'direct-upload send should forward the uploaded attachment');
assert.equal(directUploadSendCalls[0]?.images?.[0]?.assetId, 'fasset_uploaded', 'direct-upload send should submit the finalized asset id');
assert.equal(Boolean(directUploadSendCalls[0]?.images?.[0]?.file), false, 'direct-upload send should not fall back to multipart file bytes');
assert.equal(directUploadSendContext.getComposerAttachmentsState('session-a')[0]?.uploadState, 'uploaded', 'direct-upload send should persist the uploaded attachment state in the composer');

console.log('test-chat-compose-draft: ok');
