#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http-list-state.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

function makeElement() {
  return {
    style: {},
    disabled: false,
    textContent: '',
    innerHTML: '',
    children: [],
    className: '',
    value: '',
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    remove() {
      if (this.parentNode?.children) {
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      }
      this.parentNode = null;
    },
    addEventListener() {},
    focus() {},
    scrollIntoView() {},
    querySelector() {
      return null;
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
  };
}

function createContext({ shareSnapshotMode = false } = {}) {
  const metrics = {
    scrollToBottomCalls: 0,
    scrollNodeToTopCalls: 0,
  };
  const messagesInner = makeElement();
  const emptyState = makeElement();
  const context = {
    console,
    URL,
    Headers,
    Map,
    Set,
    Math,
    Date,
    JSON,
    navigator: {},
    Notification: function Notification() {},
    atob(value) {
      return Buffer.from(String(value), 'base64').toString('binary');
    },
    window: {
      location: {
        origin: 'http://127.0.0.1',
        href: 'http://127.0.0.1/',
        pathname: '/',
      },
      focus() {},
      crypto: {
        randomUUID() {
          return 'req_test';
        },
      },
    },
    document: {
      visibilityState: 'visible',
      getElementById() {
        return null;
      },
      createElement() {
        return makeElement();
      },
    },
    pendingNavigationState: null,
    activeTab: 'sessions',
    visitorMode: false,
    visitorSessionId: null,
    currentSessionId: shareSnapshotMode ? 'share_snapshot:snap_test' : 'session_regular',
    hasAttachedSession: true,
    hasLoadedSessions: true,
    archivedSessionCount: 0,
    sessions: [],
    jsonResponseCache: new Map(),
    renderedEventState: {
      sessionId: null,
      latestSeq: 0,
      eventCount: 0,
      eventBaseKeys: [],
      eventKeys: [],
      runState: 'idle',
      runningBlockExpanded: false,
    },
    emptyState,
    messagesInner,
    messagesEl: {
      scrollHeight: 1200,
      scrollTop: 680,
      clientHeight: 400,
    },
    sidebarSessionRefreshPromises: new Map(),
    pendingSidebarSessionRefreshes: new Set(),
    pendingCurrentSessionRefresh: false,
    currentSessionRefreshPromise: null,
    contextTokens: makeElement(),
    compactBtn: makeElement(),
    dropToolsBtn: makeElement(),
    resumeBtn: makeElement(),
    headerTitle: makeElement(),
    inlineToolSelect: makeElement(),
    toolsList: [],
    selectedTool: '',
    sessionStatus: 'idle',
    inThinkingBlock: false,
    shareSnapshotMode,
    shareSnapshotPayload: shareSnapshotMode
      ? {
        id: 'snap_test',
        session: { name: 'Shared session', tool: 'codex' },
        view: {},
        displayEvents: [
          { seq: 1, type: 'message', role: 'user', content: 'first' },
          { seq: 2, type: 'message', role: 'assistant', content: 'second' },
        ],
      }
      : null,
    loadModelsForCurrentTool() {},
    restoreDraft() {},
    updateStatus() {},
    renderQueuedMessagePanel() {},
    updateResumeButton() {},
    syncBrowserState() {},
    syncForkButton() {},
    syncShareButton() {},
    finishedUnread: new Set(),
    getSessionDisplayName(session) {
      return session?.name || '';
    },
    getEffectiveSessionAppId(session) {
      return session?.appId || 'chat';
    },
    normalizeSessionStatus(status) {
      return status || 'idle';
    },
    sortSessionsInPlace() {},
    refreshAppCatalog() {},
    renderSessionList() {},
    clearMessages() {
      messagesInner.children = [];
    },
    showEmpty() {},
    scrollToBottom() {
      metrics.scrollToBottomCalls += 1;
    },
    applyFinishedTurnCollapseState() {
      return { id: 'latest-user-turn' };
    },
    shouldFocusLatestTurnStart() {
      return true;
    },
    scrollNodeToTop() {
      metrics.scrollNodeToTopCalls += 1;
    },
    checkPendingMessage() {},
    getPendingMessage() {
      return null;
    },
    clearPendingMessage() {},
    attachSession() {},
    persistActiveSessionId() {},
    resolveRestoreTargetSession() {
      return null;
    },
    switchTab() {},
    applyNavigationState() {},
    fetch: async () => ({
      ok: true,
      status: 200,
      redirected: false,
      url: 'http://127.0.0.1/api/sessions/session_regular/events?filter=visible',
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'content-type'
            ? 'application/json; charset=utf-8'
            : null;
        },
      },
      async json() {
        return {
          events: [
            { seq: 1, type: 'message', role: 'user', content: 'first' },
            { seq: 2, type: 'message', role: 'assistant', content: 'second' },
          ],
        };
      },
    }),
    getEventBoundarySeq(event) {
      return Number.isInteger(event?.seq) ? event.seq : 0;
    },
    getEventRenderBaseKey(event) {
      return `${event?.seq || 0}:${event?.type || 'unknown'}`;
    },
    getEventRenderKey(event) {
      return `${event?.seq || 0}:${event?.type || 'unknown'}`;
    },
    isRunningThinkingBlockEvent() {
      return false;
    },
    renderEvent(event) {
      messagesInner.children.push({ event });
    },
    reconcileComposerPendingSendWithEvent() {},
  };

  context.globalThis = context;
  context.self = context;
  context.__metrics = metrics;
  return context;
}

const shareContext = createContext({ shareSnapshotMode: true });
vm.runInNewContext(sessionHttpSource, shareContext, { filename: 'static/chat/session-http.js' });

await shareContext.fetchSessionEvents(shareContext.currentSessionId, { runState: 'idle' });

assert.equal(shareContext.messagesEl.scrollTop, 0, 'share snapshots should open from the top of the transcript');
assert.equal(shareContext.__metrics.scrollNodeToTopCalls, 0, 'share snapshots should not jump to the latest user turn');
assert.equal(shareContext.__metrics.scrollToBottomCalls, 0, 'share snapshots should not stick to the bottom on load');

const regularContext = createContext({ shareSnapshotMode: false });
vm.runInNewContext(sessionHttpSource, regularContext, { filename: 'static/chat/session-http.js' });

await regularContext.fetchSessionEvents(regularContext.currentSessionId, {
  runState: 'idle',
  viewportIntent: 'session_entry',
});

assert.equal(regularContext.__metrics.scrollNodeToTopCalls, 1, 'regular sessions should keep focusing the latest user turn');
assert.equal(regularContext.messagesEl.scrollTop, 680, 'regular sessions should not be forced back to the top');

await regularContext.fetchSessionEvents(regularContext.currentSessionId, {
  runState: 'idle',
  viewportIntent: 'session_entry',
});

assert.equal(
  regularContext.__metrics.scrollNodeToTopCalls,
  1,
  'regular sessions should only focus the latest user turn once while that session stays open',
);

regularContext.currentSessionId = 'session_other';
await regularContext.fetchSessionEvents(regularContext.currentSessionId, {
  runState: 'idle',
  viewportIntent: 'session_entry',
});

assert.equal(
  regularContext.__metrics.scrollNodeToTopCalls,
  2,
  'switching to another session should allow the one-time latest-turn focus again',
);

const reconnectContext = createContext({ shareSnapshotMode: false });
vm.runInNewContext(sessionHttpSource, reconnectContext, { filename: 'static/chat/session-http.js' });

await reconnectContext.fetchSessionEvents(reconnectContext.currentSessionId, { runState: 'idle' });

assert.equal(
  reconnectContext.__metrics.scrollNodeToTopCalls,
  0,
  'background refreshes should preserve the viewport instead of refocusing the latest user turn',
);
assert.equal(
  reconnectContext.messagesEl.scrollTop,
  680,
  'background refreshes should keep the current reading position',
);

console.log('test-session-http-share-snapshot-scroll: ok');
