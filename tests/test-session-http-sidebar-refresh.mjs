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

function createFetchResponse(body, { status = 200, etag = '"etag-sidebar-refresh"' } = {}) {
  const headers = new Map([
    ['content-type', 'application/json; charset=utf-8'],
    ['etag', etag],
  ]);
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: false,
    url: 'http://127.0.0.1/api/sessions/sidebar-target?view=sidebar',
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
  const renderCalls = [];
  const fetchCalls = [];
  const context = {
    console,
    URL,
    Headers,
    Map,
    Set,
    Math,
    Date,
    JSON,
    renderCalls,
    fetchCalls,
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
    currentSessionId: 'current-session',
    hasAttachedSession: true,
    sessions: [
      {
        id: 'current-session',
        name: 'Current session',
        status: 'idle',
        updatedAt: '2026-03-12T09:00:00.000Z',
        appId: 'chat',
      },
      {
        id: 'sidebar-target',
        name: 'Old sidebar name',
        status: 'idle',
        updatedAt: '2026-03-12T08:00:00.000Z',
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
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), headers: options.headers });
      if (String(url) === '/api/sessions/sidebar-target?view=sidebar') {
        return createFetchResponse({
          session: {
            id: 'sidebar-target',
            name: 'Fresh sidebar name',
            status: 'running',
            updatedAt: '2026-03-12T10:00:00.000Z',
            appId: 'chat',
          },
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

await context.refreshSidebarSession('sidebar-target');

assert.equal(context.fetchCalls.length, 1, 'sidebar refresh should fetch session sidebar once');
assert.equal(context.renderCalls.length, 1, 'sidebar refresh should rerender the session list for non-current sessions');
assert.equal(context.sessions[0].id, 'sidebar-target', 'sidebar refresh should allow updated sessions to move to the top');
assert.equal(context.sessions[0].name, 'Fresh sidebar name', 'sidebar refresh should replace stale session metadata');
assert.equal(context.sessions[0].status, 'running', 'sidebar refresh should expose the refreshed status immediately');

console.log('test-session-http-sidebar-refresh: ok');
