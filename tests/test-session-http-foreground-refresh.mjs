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

function createFakeDate(startTime) {
  let now = startTime;
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super(now);
        return;
      }
      super(...args);
    }

    static now() {
      return now;
    }
  }
  return {
    Date: FakeDate,
    advance(ms) {
      now += ms;
    },
  };
}

function createFetchResponse(body, { status = 200, etag = '"etag-foreground-refresh"', url = 'http://127.0.0.1/' } = {}) {
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
  state = 'idle',
  status = 'idle',
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

function createContext({ fetchImpl, pendingNavigationState = null } = {}) {
  const fakeClock = createFakeDate(Date.parse('2026-03-12T10:00:00.000Z'));
  const fetchCalls = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const serviceWorkerListeners = new Map();
  const applyNavigationStateCalls = [];
  const attachCalls = [];
  let focusCount = 0;

  const context = {
    console,
    URL,
    Headers,
    Map,
    Set,
    Math,
    Date: fakeClock.Date,
    JSON,
    fetchCalls,
    documentListeners,
    windowListeners,
    serviceWorkerListeners,
    applyNavigationStateCalls,
    attachCalls,
    navigator: {
      serviceWorker: {
        addEventListener(type, handler) {
          serviceWorkerListeners.set(type, handler);
        },
      },
    },
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
      focus() {
        focusCount += 1;
      },
      addEventListener(type, handler) {
        windowListeners.set(type, handler);
      },
      crypto: {
        randomUUID() {
          return 'req_test';
        },
      },
    },
    document: {
      visibilityState: 'visible',
      addEventListener(type, handler) {
        documentListeners.set(type, handler);
      },
      getElementById() {
        return null;
      },
      createElement() {
        return makeElement();
      },
    },
    pendingNavigationState,
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
    sessions: [
      buildSession({
        id: 'current-session',
        name: 'Current session',
        state: 'running',
        status: 'running',
        updatedAt: '2026-03-12T09:00:00.000Z',
        latestSeq: 1,
      }),
    ],
    jsonResponseCache: new Map(),
    renderedEventState: {
      sessionId: 'current-session',
      latestSeq: 0,
      eventCount: 0,
      eventBaseKeys: [],
      eventKeys: [],
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
    renderSessionList() {},
    clearMessages() {
      context.messagesInner.children = [];
      context.emptyState.parentNode = null;
    },
    showEmpty() {
      context.emptyState.parentNode = context.messagesInner;
    },
    scrollToBottom() {},
    renderEvent() {},
    applyFinishedTurnCollapseState() {
      return null;
    },
    scrollNodeToTop() {},
    checkPendingMessage() {},
    getPendingMessage() {
      return null;
    },
    clearPendingMessage() {},
    persistActiveSessionId() {},
    switchTab() {},
    resolveRestoreTargetSession() {
      if (!context.pendingNavigationState?.sessionId) return null;
      return context.sessions.find((session) => session.id === context.pendingNavigationState.sessionId) || null;
    },
    attachSession(id, session) {
      attachCalls.push({ id, session });
      context.currentSessionId = id;
      context.hasAttachedSession = true;
    },
    applyNavigationState(state) {
      applyNavigationStateCalls.push(state);
    },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), options });
      return fetchImpl(String(url), options, context);
    },
  };

  Object.defineProperty(context, 'focusCount', {
    get() {
      return focusCount;
    },
  });
  context.advanceTime = fakeClock.advance;
  context.globalThis = context;
  context.self = context;
  return context;
}

const firstContext = createContext({
  fetchImpl(url) {
    if (url === '/api/sessions') {
      return createFetchResponse({
        sessions: [
          buildSession({
            id: 'current-session',
            name: 'Current session',
            state: 'completed',
            status: 'completed',
            updatedAt: '2026-03-12T10:10:00.000Z',
            latestSeq: 5,
          }),
        ],
        archivedCount: 0,
      }, { url: 'http://127.0.0.1/api/sessions' });
    }
    if (url === '/api/sessions/current-session') {
      return createFetchResponse({
        session: buildSession({
          id: 'current-session',
          name: 'Current session',
          state: 'completed',
          status: 'completed',
          updatedAt: '2026-03-12T10:10:00.000Z',
          latestSeq: 5,
        }),
      }, { url: 'http://127.0.0.1/api/sessions/current-session' });
    }
    if (url === '/api/sessions/current-session/events?filter=visible') {
      return createFetchResponse({
        events: [
          {
            seq: 5,
            type: 'message',
            role: 'assistant',
            content: 'Done.',
          },
        ],
      }, { url: 'http://127.0.0.1/api/sessions/current-session/events?filter=visible' });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  },
});

vm.runInNewContext(sessionHttpSource, firstContext, { filename: 'static/chat/session-http.js' });

firstContext.setupForegroundRefreshHandlers();

assert.equal(firstContext.documentListeners.has('visibilitychange'), true, 'foreground setup should register a visibilitychange handler');
assert.equal(firstContext.windowListeners.has('focus'), true, 'foreground setup should register a focus handler');
assert.equal(firstContext.windowListeners.has('pageshow'), true, 'foreground setup should register a pageshow handler');
assert.equal(firstContext.serviceWorkerListeners.has('message'), true, 'notification routing should keep a service worker message handler');

await firstContext.documentListeners.get('visibilitychange')();

assert.deepEqual(
  firstContext.fetchCalls.map((entry) => entry.url),
  [
    '/api/sessions',
    '/api/sessions/current-session',
    '/api/sessions/current-session/events?filter=visible',
  ],
  'returning to the foreground should refresh the session list, current session, and visible transcript once',
);
assert.equal(
  firstContext.fetchCalls.every((entry) => entry.options.cache !== 'no-store'),
  true,
  'foreground recovery should rely on normal revalidation instead of forcing a full no-store refetch every time',
);

await firstContext.windowListeners.get('focus')();

assert.equal(
  firstContext.fetchCalls.length,
  3,
  'foreground recovery should throttle duplicate focus-based refreshes fired right after visibilitychange',
);

const targetedContext = createContext({
  fetchImpl(url) {
    if (url === '/api/sessions') {
      return createFetchResponse({
        sessions: [
          buildSession({
            id: 'current-session',
            name: 'Current session',
            state: 'running',
            status: 'running',
            updatedAt: '2026-03-12T10:10:00.000Z',
            latestSeq: 5,
          }),
        ],
        archivedCount: 0,
      }, { url: 'http://127.0.0.1/api/sessions' });
    }
    if (url === '/api/sessions/current-session') {
      return createFetchResponse({
        session: buildSession({
          id: 'current-session',
          name: 'Current session',
          state: 'running',
          status: 'running',
          updatedAt: '2026-03-12T10:10:00.000Z',
          latestSeq: 5,
        }),
      }, { url: 'http://127.0.0.1/api/sessions/current-session' });
    }
    if (url === '/api/sessions/current-session/events?filter=visible') {
      return createFetchResponse({
        events: [
          {
            seq: 5,
            type: 'message',
            role: 'assistant',
            content: 'Still running.',
          },
        ],
      }, { url: 'http://127.0.0.1/api/sessions/current-session/events?filter=visible' });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  },
});

vm.runInNewContext(sessionHttpSource, targetedContext, { filename: 'static/chat/session-http.js' });

await targetedContext.fetchSessionsList();
targetedContext.fetchCalls.length = 0;
targetedContext.setupForegroundRefreshHandlers();
await targetedContext.documentListeners.get('visibilitychange')();

assert.deepEqual(
  targetedContext.fetchCalls.map((entry) => entry.url),
  [
    '/api/sessions/current-session',
    '/api/sessions/current-session/events?filter=visible',
  ],
  'foreground recovery should skip a freshly hydrated session list and only refresh the visible running session',
);

firstContext.advanceTime(3000);
await firstContext.serviceWorkerListeners.get('message')({
  data: {
    type: 'remotelab:open-session',
    sessionId: 'current-session',
    tab: 'sessions',
  },
});

assert.equal(firstContext.applyNavigationStateCalls.length, 1, 'notification navigation should still flow through the normal session router');
assert.equal(firstContext.focusCount, 1, 'notification navigation should focus the existing chat window');
assert.equal(
  firstContext.fetchCalls.length,
  6,
  'notification-opened sessions should trigger another fresh recovery sync when the tab comes back',
);

const secondContext = createContext({
  pendingNavigationState: {
    sessionId: 'fresh-session',
    tab: 'sessions',
  },
  fetchImpl(url) {
    if (url === '/api/sessions') {
      return createFetchResponse({
        sessions: [
          buildSession({
            id: 'fresh-session',
            name: 'Fresh session',
            state: 'completed',
            status: 'completed',
            updatedAt: '2026-03-12T10:20:00.000Z',
            latestSeq: 3,
          }),
          buildSession({
            id: 'current-session',
            name: 'Current session',
            state: 'idle',
            status: 'idle',
            updatedAt: '2026-03-12T09:00:00.000Z',
            latestSeq: 1,
          }),
        ],
        archivedCount: 0,
      }, { url: 'http://127.0.0.1/api/sessions' });
    }
    if (url === '/api/sessions/fresh-session') {
      return createFetchResponse({
        session: buildSession({
          id: 'fresh-session',
          name: 'Fresh session',
          state: 'completed',
          status: 'completed',
          updatedAt: '2026-03-12T10:20:00.000Z',
          latestSeq: 3,
        }),
      }, { url: 'http://127.0.0.1/api/sessions/fresh-session' });
    }
    if (url === '/api/sessions/fresh-session/events?filter=visible') {
      return createFetchResponse({
        events: [
          {
            seq: 3,
            type: 'message',
            role: 'assistant',
            content: 'Freshly completed.',
          },
        ],
      }, { url: 'http://127.0.0.1/api/sessions/fresh-session/events?filter=visible' });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  },
});

vm.runInNewContext(sessionHttpSource, secondContext, { filename: 'static/chat/session-http.js' });

await secondContext.refreshRealtimeViews({ forceFresh: true, viewportIntent: 'session_entry' });

assert.equal(secondContext.attachCalls.length, 1, 'recovery refresh should restore a pending notification target once the latest session list arrives');
assert.equal(secondContext.attachCalls[0]?.id, 'fresh-session', 'recovery refresh should attach the newly available notification target session');
assert.equal(secondContext.currentSessionId, 'fresh-session', 'recovery refresh should leave the fresh target as the active session');

console.log('test-session-http-foreground-refresh: ok');
