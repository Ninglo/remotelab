#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8')
  + '\n'
  + readFileSync(join(repoRoot, 'static/chat/session-http-list-state.js'), 'utf8')
  + '\n'
  + readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

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

function createFetchResponse(body, { status = 200, etag = '"etag-noop-refresh"', url = 'http://127.0.0.1/' } = {}) {
  const headers = new Map([
    ['content-type', 'application/json; charset=utf-8'],
    ['etag', etag],
  ]);
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: false,
    url,
    headers: {
      get(name) {
        return headers.get(String(name).toLowerCase()) || null;
      },
    },
    async json() {
      return body;
    },
  };
}

function buildSession({
  id,
  name,
  status = 'idle',
  state = 'idle',
  updatedAt,
  latestSeq = 0,
}) {
  return {
    id,
    name,
    status,
    updatedAt,
    latestSeq,
    sourceId: 'chat',
    sourceName: 'Chat',
    activity: {
      run: { state },
      queue: { state: 'idle', count: 0 },
      compact: { state: 'idle' },
    },
  };
}

function createContext() {
  const renderCalls = [];
  let restoreDraftCalls = 0;
  const currentSession = buildSession({
    id: 'current-session',
    name: 'Current session',
    status: 'idle',
    state: 'idle',
    updatedAt: '2026-03-12T10:00:00.000Z',
    latestSeq: 1,
  });
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
      title: 'RemoteLab',
    },
    pendingNavigationState: null,
    activeTab: 'sessions',
    visitorMode: false,
    visitorSessionId: null,
    currentSessionId: 'current-session',
    hasAttachedSession: true,
    hasLoadedSessions: true,
    archivedSessionCount: 0,
    archivedSessionsLoaded: false,
    archivedSessionsLoading: false,
    archivedSessionsRefreshPromise: null,
    sessions: [currentSession],
    jsonResponseCache: new Map(),
    renderedEventState: {
      sessionId: 'current-session',
      latestSeq: 1,
      eventCount: 1,
      eventBaseKeys: ['1:message'],
      eventKeys: ['1:message'],
      runState: 'idle',
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
    restoreDraft() {
      restoreDraftCalls += 1;
    },
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
    getEffectiveSessionSourceId(session) {
      return session?.sourceId || 'chat';
    },
    normalizeSessionStatus(status) {
      return status || 'idle';
    },
    sortSessionsInPlace() {
      context.sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    },
    refreshAppCatalog() {},
    renderSessionList() {
      renderCalls.push(context.sessions.map((session) => session.id));
    },
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
    fetch: async (url) => {
      if (String(url) === '/api/sessions') {
        return createFetchResponse({
          sessions: [buildSession({
            id: 'current-session',
            name: 'Current session',
            status: 'idle',
            state: 'idle',
            updatedAt: '2026-03-12T10:00:00.000Z',
            latestSeq: 1,
          })],
          archivedCount: 0,
        }, { url: 'http://127.0.0.1/api/sessions' });
      }
      if (String(url) === '/api/sessions/current-session') {
        return createFetchResponse({
          session: buildSession({
            id: 'current-session',
            name: 'Current session',
            status: 'idle',
            state: 'idle',
            updatedAt: '2026-03-12T10:00:00.000Z',
            latestSeq: 1,
          }),
        }, { url: 'http://127.0.0.1/api/sessions/current-session' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  };

  Object.defineProperty(context, 'renderCalls', {
    get() {
      return renderCalls;
    },
  });
  Object.defineProperty(context, 'restoreDraftCalls', {
    get() {
      return restoreDraftCalls;
    },
    set(value) {
      restoreDraftCalls = value;
    },
  });
  context.globalThis = context;
  context.self = context;
  return context;
}

const context = createContext();
vm.runInNewContext(sessionHttpSource, context, { filename: 'static/chat/session-http.js' });

context.applyAttachedSessionState('current-session', context.sessions[0]);
context.renderCalls.length = 0;
context.restoreDraftCalls = 0;

await context.fetchSessionsList();

assert.equal(
  context.renderCalls.length,
  0,
  'identical session list payloads should not rerender the sidebar',
);

await context.fetchSessionState('current-session');

assert.equal(
  context.restoreDraftCalls,
  0,
  'identical attached session payloads should not rerun draft restoration',
);
assert.equal(
  context.renderCalls.length,
  0,
  'identical attached session payloads should not rerender the sidebar',
);

console.log('test-session-http-noop-refresh: ok');
