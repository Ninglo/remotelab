#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = name => readFileSync(join(root, 'static/chat', name), 'utf8');
const bootstrap = source('bootstrap.js');
const fixtures = [
  { id: 'chat', sourceId: 'chat', name: 'Chat task', space: 'Product' },
  { id: 'pin', sourceId: 'chat', name: 'Pinned task', pinned: true, space: 'Product' },
  { id: 'feishu', sourceId: 'feishu', name: 'Feishu task', space: 'Research' },
  { id: 'email', sourceId: 'feishu-mail', name: 'Email task', space: 'Research' },
  { id: 'archived', sourceId: 'chat', archived: true, name: 'Archived task' },
  { id: 'internal', sourceId: 'chat', internalRole: 'classifier' },
];

function harness({ origin = '__all__' } = {}) {
  let context;
  function element(tag = 'div') {
    const listeners = new Map();
    let html = '', value = '';
    const el = {
      tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, hidden: false,
      className: '', textContent: '', parentNode: null,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      get innerHTML() { return html; },
      set innerHTML(next) { html = next; this.children = []; value = ''; },
      get value() { return value; },
      set value(next) { value = String(next); },
      get options() { return this.children; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); },
      setAttribute() {}, querySelector() { return element(); },
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      dispatch(type) { for (const fn of listeners.get(type) || []) fn({ target: this }); },
      focus() { context.document.activeElement = this; this.dispatch('focus'); },
      blur() { context.document.activeElement = null; this.dispatch('blur'); },
    };
    return el;
  }
  const storage = new Map([['activeSourceFilter', origin]]);
  context = vm.createContext({
    console, setTimeout, clearTimeout,
    document: { activeElement: null, createElement: element, getElementById() { return null; } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    marked: { use() {} },
    sessions: fixtures.map(s => ({ ...s })), currentSessionId: 'feishu', hasAttachedSession: true,
    hasLoadedSessions: true, archivedSessionCount: 1, archivedSessionsLoaded: true, archivedSessionsLoading: false,
    sessionStatus: 'idle', activeTab: 'sessions', visitorMode: false, pendingNavigationState: {},
    sidebarFilters: element(), sourceFilterSelect: element('select'), sessionList: element(), sidebarSpaceSwitcher: element(),
    ACTIVE_SESSION_STORAGE_KEY: 'activeSessionId', ACTIVE_SIDEBAR_TAB_STORAGE_KEY: 'activeSidebarTab',
    ACTIVE_SOURCE_FILTER_STORAGE_KEY: 'activeSourceFilter', LEGACY_ACTIVE_SOURCE_FILTER_STORAGE_KEY: 'activeAppFilter',
    ACTIVE_SESSION_SPACE_STORAGE_KEY: 'activeSessionSpace', COLLAPSED_GROUPS_STORAGE_KEY: 'collapsed',
    SESSION_SPACE_ALL_VALUE: '__all_spaces__', SESSION_SPACE_LOOSE_VALUE: '__loose_space__',
    activeSessionSpace: '__all_spaces__', sessionSearchQuery: '', collapsedFolders: {},
    normalizeSidebarTab: value => value || 'sessions',
    normalizeSessionRecord: value => value, getComparableSessionStateSignature: JSON.stringify,
    esc: value => String(value ?? ''), renderUiIcon: () => '', getShortFolder: value => value,
    getSessionDisplayName: s => s.name, getFilteredSessionEmptyText: () => 'No matching sessions',
    getSessionGroupInfo: s => ({ key: s.space || 'Loose', title: s.space || 'Loose', label: s.space || 'Loose' }),
  });
  context.window = context;
  context.remotelabT = (key, vars) => vars?.count === undefined ? key : `${key} (${vars.count})`;
  for (const file of ['session-store.js', 'session-state-model.js']) vm.runInContext(source(file), context);
  context.chatStoreModel = context.RemoteLabChatStore;
  context.sessionStateModel = context.RemoteLabSessionStateModel;
  vm.runInContext(bootstrap.slice(bootstrap.indexOf('const FILTER_ALL_VALUE'), bootstrap.indexOf('const THINKING_BLOCK_DISPLAY_STORAGE_KEY')), context);
  // Use the real Store wrappers, catalog listeners, HTTP refresh path and list rendering.
  vm.runInContext(bootstrap.slice(bootstrap.indexOf('const chatStore ='), bootstrap.indexOf('function getChatStoreSession')), context);
  for (const file of ['bootstrap-session-catalog.js', 'session-list-ui.js', 'session-http-list-state.js']) {
    vm.runInContext(source(file), context, { filename: file });
  }
  // Row decoration/actions are outside this test; selection, grouping and filtering remain real.
  context.createActiveSessionItem = s => {
    const row = element(); row.dataset.sessionId = s.id; return row;
  };
  context.renderSessionList();
  const rows = () => {
    const ids = [];
    function walk(el) { if (el.dataset.sessionId) ids.push(el.dataset.sessionId); el.children.forEach(walk); }
    walk(context.sessionList);
    return ids.sort();
  };
  const select = context.sourceFilterSelect;
  const choose = value => { select.focus(); select.value = value; select.dispatch('input'); select.dispatch('change'); };
  const refresh = () => context.applySessionListState(context.sessions.filter(s => !s.archived));
  return { context, select, rows, choose, refresh, storage };
}

test('selection updates actual rows, pinned rows and archives without changing the open session', () => {
  const h = harness();
  h.choose('chat_ui');
  assert.deepEqual(h.rows(), ['chat', 'pin']);
  assert.deepEqual(Array.from(h.context.getVisibleArchivedSessions(), s => s.id), ['archived']);
  assert.equal(h.context.currentSessionId, 'feishu');
  h.choose('feishu');
  assert.deepEqual(h.rows(), ['feishu']);
  h.choose('email');
  assert.deepEqual(h.rows(), ['email']);
  h.choose('__all__');
  assert.deepEqual(h.rows(), ['chat', 'email', 'feishu', 'pin']);
});

test('refresh between native input and change must not discard the choice', () => {
  const h = harness();
  h.select.focus(); h.select.value = 'chat_ui'; h.select.dispatch('input');
  h.refresh();
  h.select.dispatch('change');
  assert.equal(h.context.getActiveSourceFilterValue(), 'chat_ui');
  assert.equal(h.storage.get('activeSourceFilter'), 'chat_ui');
  assert.deepEqual(h.rows(), ['chat', 'pin']);
});

test('no-op refresh preserves option nodes and a focused pending native selection', () => {
  const h = harness();
  const options = [...h.select.children];
  h.refresh();
  assert.ok(options.every((node, i) => node === h.select.children[i]), 'no-op refresh must preserve options');
  h.select.focus(); h.select.value = 'feishu';
  h.refresh();
  assert.equal(h.select.value, 'feishu', 'refresh must not overwrite a native value before its events');
  assert.ok(options.every((node, i) => node === h.select.children[i]));
});

test('count changes are deferred while focused and appear after blur', async () => {
  const h = harness();
  const option = h.select.children.find(x => x.value === 'chat_ui');
  const label = option.textContent;
  h.select.focus();
  h.context.applySessionListState([...h.context.sessions.filter(s => !s.archived), { id: 'new', sourceId: 'chat' }]);
  assert.ok(h.select.children.includes(option), 'open picker must keep its option nodes');
  assert.equal(option.textContent, label);
  h.select.blur();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(h.select.children.find(x => x.value === 'chat_ui').textContent, /\(3\)/);
});

test('selected zero-count origin stays selected, recoverable, and filters archived rows', () => {
  const h = harness();
  h.choose('chat_ui'); h.select.blur();
  h.context.applySessionListState([{ id: 'feishu', sourceId: 'feishu' }]);
  assert.equal(h.context.getActiveSourceFilterValue(), 'chat_ui');
  assert.deepEqual(h.rows(), []);
  assert.equal(h.select.style.display, '');
  assert.ok(h.select.children.some(x => x.value === '__all__'));
  assert.deepEqual(Array.from(h.context.getVisibleArchivedSessions(), s => s.id), ['archived']);
});

test('Store is the source of truth for list filtering; Space and search compose with it', () => {
  const h = harness();
  h.context.setChatActiveSourceFilter('chat_ui');
  h.context.renderSessionList();
  assert.deepEqual(h.rows(), ['chat', 'pin'], 'Store updates must not leave a stale global filter');
  h.context.activeSessionSpace = 'Product'; h.context.sessionSearchQuery = 'Pinned';
  h.context.renderSessionList();
  assert.deepEqual(h.rows(), ['pin']);
  h.context.sessionSearchQuery = '';
  h.choose('feishu');
  assert.equal(h.context.activeSessionSpace, '__all_spaces__', 'invalid Space resets under new origin');
  assert.deepEqual(h.rows(), ['feishu']);
});


test('change-only browsers work and duplicate input/change events do not rerender twice', () => {
  const h = harness();
  h.select.focus(); h.select.value = 'feishu'; h.select.dispatch('change');
  assert.deepEqual(h.rows(), ['feishu']);
  h.select.value = 'chat_ui'; h.select.dispatch('input');
  const firstNode = h.context.sessionList.children[0];
  h.select.dispatch('change');
  assert.equal(h.context.sessionList.children[0], firstNode);
  assert.deepEqual(h.rows(), ['chat', 'pin']);
});

test('startup restores valid stored origins and normalizes retired values to All', () => {
  const restored = harness({ origin: 'feishu' });
  assert.deepEqual(restored.rows(), ['feishu']);
  assert.equal(restored.select.value, 'feishu');
  const retired = harness({ origin: 'retired-origin' });
  assert.equal(retired.context.getActiveSourceFilterValue(), '__all__');
  assert.equal(retired.select.value, '__all__');
  assert.deepEqual(retired.rows(), ['chat', 'email', 'feishu', 'pin']);
});
