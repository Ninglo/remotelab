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

function createContext() {
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
    currentSessionId: 'current-session',
    hasAttachedSession: true,
    hasLoadedSessions: true,
    archivedSessionCount: 0,
    sessions: [
      {
        id: 'current-session',
        name: 'Current session',
        status: 'running',
        updatedAt: '2026-03-12T09:30:00.000Z',
        appId: 'chat',
      },
    ],
    jsonResponseCache: new Map(),
    renderedEventState: {
      sessionId: 'current-session',
      latestSeq: 42,
      eventCount: 3,
      eventBaseKeys: ['1:message', '2:thinking_block:running'],
      eventKeys: ['1:message', '2:thinking_block:running'],
      runState: 'running',
      runningBlockExpanded: false,
    },
    emptyState: makeElement(),
    messagesInner: makeElement(),
    messagesEl: {
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
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
    clearMessages() {},
    showEmpty() {},
    scrollToBottom() {},
    applyFinishedTurnCollapseState() {
      return null;
    },
    shouldFocusLatestTurnStart() {
      return false;
    },
    scrollNodeToTop() {},
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
    fetch: async () => {
      throw new Error('Unexpected fetch');
    },
  };

  context.globalThis = context;
  context.self = context;
  return context;
}

const context = createContext();
vm.runInNewContext(sessionHttpSource, context, { filename: 'static/chat/session-http.js' });

const runningSession = {
  activity: {
    run: { state: 'running' },
  },
};

assert.equal(
  context.shouldFetchSessionEventsForRefresh('current-session', runningSession),
  false,
  'collapsed running sessions should skip event refreshes when a rendered snapshot already exists',
);

context.renderedEventState.runningBlockExpanded = true;
assert.equal(
  context.shouldFetchSessionEventsForRefresh('current-session', runningSession),
  true,
  'expanding the running hidden block should re-enable event refreshes',
);

context.renderedEventState.runState = 'idle';
context.renderedEventState.runningBlockExpanded = false;
assert.equal(
  context.shouldFetchSessionEventsForRefresh('current-session', runningSession),
  true,
  'the first refresh after entering running should fetch once to install the collapsed running snapshot',
);

assert.equal(
  context.shouldFetchSessionEventsForRefresh('current-session', {
    activity: {
      run: { state: 'completed' },
    },
  }),
  true,
  'completed sessions should always refresh events to reveal the final visible summary',
);

context.renderedEventState = {
  sessionId: 'current-session',
  latestSeq: 6,
  eventCount: 2,
  eventBaseKeys: ['1:message', '2:thinking_block:running'],
  eventKeys: ['1:message', '2:thinking_block:running:6'],
  runState: 'running',
  runningBlockExpanded: true,
};

const inPlaceRefreshPlan = context.getEventRenderPlan('current-session', [
  { seq: 1, type: 'message', role: 'user', content: 'Please inspect this run.' },
  {
    seq: 2,
    type: 'thinking_block',
    state: 'running',
    blockStartSeq: 2,
    blockEndSeq: 7,
    label: 'Thinking · using bash',
  },
]);

assert.equal(
  inPlaceRefreshPlan.mode,
  'refresh_running_block',
  'expanded running blocks should refresh in place instead of resetting the whole transcript when only the hidden range grows',
);
assert.equal(
  inPlaceRefreshPlan.events.length,
  1,
  'the in-place refresh plan should target exactly one running block',
);
assert.equal(
  inPlaceRefreshPlan.events[0]?.blockEndSeq,
  7,
  'the in-place refresh plan should target the newest running block boundary',
);

console.log('test-session-http-running-refresh: ok');
