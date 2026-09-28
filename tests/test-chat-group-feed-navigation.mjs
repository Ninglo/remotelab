#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = readFileSync(join(root, 'static/chat/bootstrap-session-catalog.js'), 'utf8');
const list = readFileSync(join(root, 'static/chat/session-list-ui.js'), 'utf8');
const template = readFileSync(join(root, 'templates/chat.html'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let bodyStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === '(') paramsDepth += 1;
    if (source[index] === ')' && --paramsDepth === 0) {
      bodyStart = source.indexOf('{', index);
      break;
    }
  }
  assert.notEqual(bodyStart, -1, `${name} has a body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Cannot extract ${name}`);
}

for (const id of ['groupChatsNavBtn', 'backToMineNavBtn', 'headerReturnToMineBtn']) {
  assert.match(template, new RegExp(`id="${id}"`));
}

const personal = { id: 'mine', initiatedByIdentityId: 'identity_mine' };
const other = { id: 'other', initiatedByIdentityId: 'identity_other' };
const group = { id: 'group', initiatedByIdentityId: 'identity_system', groupFeed: true };
const active = [group, personal, other];
let scope = 'person_mine';
let current = personal;
let attached = personal.id;
const rendered = [];
const navButton = () => ({ hidden: false, classList: { toggle() {} } });
const context = vm.createContext({
  GROUP_FEED_FILTER_VALUE: '__group_feed__',
  FILTER_ALL_VALUE: '__all__',
  PERSON_FILTER_UNASSIGNED_VALUE: '__unassigned__',
  ACTIVE_PERSON_FILTER_STORAGE_KEY: 'person-filter',
  activeTab: 'sessions',
  activeSessionSpace: '__all__',
  currentPerson: { id: 'person_mine' },
  currentSessionId: attached,
  groupChatsNavBtn: navButton(),
  backToMineNavBtn: navButton(),
  headerReturnToMineBtn: navButton(),
  sortSessionListBtn: navButton(),
  sidebarSpaceSwitcher: { hidden: false },
  sessionList: { innerHTML: '' },
  sessionSearchQuery: '',
  sessionSearchInput: { value: '' },
  sessionListRenderDepth: 0,
  isDesktop: true,
  archivedSessionsLoaded: false,
  localStorage: { setItem() {} },
  getCurrentPersonFilter: () => scope,
  setChatActivePersonFilter: (value) => { scope = value; },
  getSessionPersonId: (session) => session === personal ? 'person_mine'
    : session === other ? 'person_other' : '__unassigned__',
  getActiveSessions: () => active,
  getCurrentSession: () => current,
  getActiveSidebarTabValue: () => 'sessions',
  matchesSourceFilter: () => true,
  matchesSearchQuery: () => true,
  matchesSessionSpace: () => true,
  renderPersonFilterOptions() {},
  renderSourceFilterOptions() {},
  renderSessionSpaceSwitcher() {},
  getVisiblePinnedSessions: () => [],
  getVisibleActiveSessions: () => scope === '__group_feed__' ? []
    : active.filter((session) => session.groupFeed !== true && (scope === '__all__'
      || (scope === 'person_mine' ? session === personal : session === other))),
  renderGroupFeedSection: (sessions) => rendered.push(['group', sessions.map((s) => s.id)]),
  renderProjectsView: (sessions) => rendered.push(['personal', sessions.map((s) => s.id)]),
  renderArchivedSection: () => rendered.push(['archive']),
  refocusActiveSessionRenameInput() {},
  switchTab() {},
  attachSession: (id, session) => { attached = id; current = session; context.currentSessionId = id; },
  closeSidebarFn() {},
  showEmpty() {},
  renderHeaderSessionTitle() {},
  syncBrowserState() {},
});

const names = [
  'getFilteredActiveSessions', 'matchesPersonFilter', 'matchesCurrentFilters',
  'getSessionCountForSourceFilter', 'getSessionCountForPersonFilter',
  'setGroupChatScope', 'syncGroupChatNavigation', 'openGroupChats',
  'returnToMineFromGroupChats',
];
vm.runInContext([
  'let lastMineSessionId = null;',
  ...names.map((name) => extractFunction(catalog, name)),
  extractFunction(list, 'renderSessionList'),
].join('\n'), context);

assert.equal(vm.runInContext('getSessionCountForPersonFilter("person_mine")', context), 1);
assert.equal(vm.runInContext('getSessionCountForPersonFilter("__all__")', context), 2);
assert.equal(vm.runInContext('getSessionCountForPersonFilter("__unassigned__")', context), 0);
assert.equal(vm.runInContext('getSessionCountForSourceFilter("__all__")', context), 1);
assert.equal(vm.runInContext('matchesPersonFilter(getActiveSessions()[0])', context), false);
vm.runInContext('renderSessionList()', context);
assert.deepEqual(rendered, [['personal', ['mine']], ['archive']]);

rendered.length = 0;
vm.runInContext('openGroupChats()', context);
assert.equal(scope, '__group_feed__');
assert.equal(attached, 'group');
assert.equal(context.backToMineNavBtn.hidden, false);
assert.equal(context.headerReturnToMineBtn.hidden, false);
assert.equal(context.groupChatsNavBtn.hidden, true);
assert.deepEqual(rendered.at(-1), ['group', ['group']]);
assert.equal(vm.runInContext('matchesPersonFilter(getActiveSessions()[0])', context), true);
assert.equal(vm.runInContext('matchesCurrentFilters(getActiveSessions()[1])', context), false);

vm.runInContext('returnToMineFromGroupChats()', context);
assert.equal(scope, 'person_mine');
assert.equal(attached, 'mine');
assert.equal(context.groupChatsNavBtn.hidden, false);
assert.equal(context.headerReturnToMineBtn.hidden, true);
console.log('test-chat-group-feed-navigation: ok');
