#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http-list-state.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

function sliceBetween(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  if (start === -1) {
    throw new Error(`Missing start token: ${startToken}`);
  }
  const end = source.indexOf(endToken, start);
  if (end === -1) {
    throw new Error(`Missing end token: ${endToken}`);
  }
  return source.slice(start, end);
}

const applyAttachedSessionStateSnippet = sliceBetween(
  sessionHttpSource,
  'function applyAttachedSessionState',
  'async function fetchSessionState',
);

const bootstrapSnippet = sliceBetween(
  sessionHttpSource,
  'function startParallelCurrentSessionBootstrap',
  'async function setupPushNotifications',
);

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

function createFetchResponse(body, { status = 200, etag = '"etag-default"', url = 'http://127.0.0.1/' } = {}) {
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

function createContext() {
  const fetchCalls = [];
  const renderCalls = [];
  const context = {
    console,
    URL,
    Headers,
    Map,
    Set,
    Math,
    Date,
    JSON,
    fetchCalls,
    renderCalls,
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
        status: 'idle',
        updatedAt: '2026-03-12T09:30:00.000Z',
        appId: 'chat',
        model: 'gpt-5',
        effort: 'high',
        thinking: true,
        queuedMessages: [{ id: 'queued-1', text: 'follow up' }],
      },
      {
        id: 'changed-session',
        name: 'Old changed session',
        status: 'idle',
        updatedAt: '2026-03-12T08:30:00.000Z',
        appId: 'chat',
      },
      {
        id: 'unchanged-session',
        name: 'Stable session',
        status: 'idle',
        updatedAt: '2026-03-12T07:30:00.000Z',
        appId: 'chat',
      },
    ],
    jsonResponseCache: new Map(),
    renderedEventState: {
      sessionId: null,
      latestSeq: 0,
      eventCount: 0,
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
      fetchCalls.push(String(url));
      if (String(url) === '/api/sessions?includeVisitor=1') {
        return createFetchResponse({
          sessions: [
            {
              id: 'changed-session',
              name: 'Fresh changed session',
              status: 'running',
              updatedAt: '2026-03-12T10:00:00.000Z',
              appId: 'chat',
            },
            {
              id: 'current-session',
              name: 'Current session refreshed',
              status: 'running',
              updatedAt: '2026-03-12T09:45:00.000Z',
              appId: 'chat',
              activity: { queue: { count: 1 } },
            },
            {
              id: 'unchanged-session',
              name: 'Stable session',
              status: 'idle',
              updatedAt: '2026-03-12T07:30:00.000Z',
              appId: 'chat',
            },
          ],
          archivedCount: 0,
        }, {
          etag: '"etag-session-list"',
          url: 'http://127.0.0.1/api/sessions?includeVisitor=1',
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  };

  context.globalThis = context;
  context.self = context;
  return context;
}

const context = createContext();
vm.runInNewContext(sessionHttpSource, context, { filename: 'static/chat/session-http.js' });

await context.fetchSessionsList();

assert.deepEqual(
  context.fetchCalls,
  ['/api/sessions?includeVisitor=1'],
  'session list refresh should hydrate from the default list endpoint',
);
assert.equal(context.renderCalls.length, 1, 'session list refresh should rerender the sidebar once');
assert.equal(context.sessions[0].id, 'changed-session', 'changed session should resort to the top after hydration');
assert.equal(context.sessions[0].name, 'Fresh changed session', 'changed session metadata should replace stale values');

const currentSession = context.sessions.find((session) => session.id === 'current-session');
assert.equal(currentSession?.name, 'Current session refreshed', 'current session metadata should refresh from the list payload');
assert.equal(currentSession?.status, 'running', 'current session status should refresh from the list payload');
assert.deepEqual(
  currentSession?.queuedMessages,
  [{ id: 'queued-1', text: 'follow up' }],
  'list hydration should preserve queuedMessages when the lightweight list omits them',
);
assert.equal(currentSession?.model, 'gpt-5', 'list hydration should preserve the selected model when the lightweight list omits it');
assert.equal(currentSession?.effort, 'high', 'list hydration should preserve the selected effort when the lightweight list omits it');
assert.equal(currentSession?.thinking, true, 'list hydration should preserve thinking mode when the lightweight list omits it');
assert.equal(
  context.sessions.find((session) => session.id === 'unchanged-session')?.name,
  'Stable session',
  'unchanged sessions should remain intact after list hydration',
);

let preToolModelLoads = 0;
const preToolAttachContext = {
  console,
  Promise,
  currentSessionId: null,
  hasAttachedSession: false,
  currentTokens: 42,
  contextTokens: makeElement(),
  compactBtn: makeElement(),
  dropToolsBtn: makeElement(),
  headerTitle: makeElement(),
  inlineToolSelect: makeElement(),
  selectedTool: 'claude',
  toolsList: [],
  getSessionDisplayName(session) {
    return session?.name || '';
  },
  updateStatus() {},
  renderQueuedMessagePanel() {},
  loadModelsForCurrentTool() {
    preToolModelLoads += 1;
  },
  restoreDraft() {},
  renderSessionList() {},
  syncBrowserState() {},
  syncForkButton() {},
  syncShareButton() {},
};
preToolAttachContext.globalThis = preToolAttachContext;

vm.runInNewContext(applyAttachedSessionStateSnippet, preToolAttachContext, {
  filename: 'chat-apply-attached-session-state-pretools-runtime.js',
});

preToolAttachContext.applyAttachedSessionState('session-pretools', {
  id: 'session-pretools',
  name: 'Current session refreshed',
  tool: 'codex',
});

assert.equal(
  preToolAttachContext.selectedTool,
  'codex',
  'attaching a session before tools load should still retain the backend-selected tool',
);
assert.equal(
  preToolAttachContext.inlineToolSelect.value,
  'codex',
  'attaching a session before tools load should keep the inline tool picker aligned for later hydration',
);
assert.equal(
  preToolModelLoads,
  0,
  'attaching a session before tools load should not try to load models until the tool catalog exists',
);

let refreshStartedBeforeList = false;
let listResolved = false;
let resolveList = null;
let restoreCalls = 0;

const bootstrapContext = {
  console,
  visitorMode: false,
  visitorSessionId: null,
  currentSessionId: 'session-bootstrap',
  attachSession() {
    throw new Error('owner deferred bootstrap should not attach a placeholder session');
  },
  refreshCurrentSession() {
    refreshStartedBeforeList = !listResolved;
    return new Promise(() => {});
  },
  fetchSessionsList() {
    return new Promise((resolve) => {
      resolveList = () => {
        listResolved = true;
        resolve([]);
      };
    });
  },
  restoreOwnerSessionSelection() {
    restoreCalls += 1;
  },
};
bootstrapContext.globalThis = bootstrapContext;

vm.runInNewContext(bootstrapSnippet, bootstrapContext, {
  filename: 'chat-bootstrap-parallel-runtime.js',
});

const bootstrapPromise = bootstrapContext.bootstrapViaHttp({ deferOwnerRestore: true });

assert.equal(
  refreshStartedBeforeList,
  true,
  'deferred owner bootstrap should start refreshing the current session before the session list finishes loading',
);
assert.equal(typeof resolveList, 'function', 'deferred owner bootstrap should still start the session list request');

resolveList();
await bootstrapPromise;

assert.equal(
  restoreCalls,
  0,
  'deferred owner bootstrap should leave final session selection to the later restore pass',
);

console.log('test-session-http-ref-hydration: ok');
