#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(
  join(repoRoot, 'static', 'chat', 'bootstrap-session-catalog.js'),
  'utf8',
);

function extractFunctionSource(functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const functionSources = [
  'normalizeAccountFilter',
  'getSessionAccountId',
  'isAdminAccountFilterAvailable',
  'isAdminOwnedSession',
  'matchesAccountFilter',
  'getAccountFilterDefinitions',
  'getSessionCountForAccountFilter',
  'isSidebarFilterControlVisible',
  'syncSidebarFiltersVisibility',
  'renderAccountFilterOptions',
].map(extractFunctionSource).join('\n\n');

function createSelect(display = '') {
  let innerHTML = '';
  const select = {
    hidden: false,
    style: { display },
    value: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
  Object.defineProperty(select, 'innerHTML', {
    get() {
      return innerHTML;
    },
    set(value) {
      innerHTML = value;
      this.children = [];
      this.value = '';
    },
  });
  return select;
}

function createHarness({ enabled = true, canManage = true } = {}) {
  const state = { persisted: [], toggles: [] };
  const sessions = [
    { id: 'admin-legacy', name: 'Legacy', archived: false },
    { id: 'admin-owned', name: 'Owner', userId: 'owner', userName: 'Owner', archived: false },
    { id: 'member-a-1', userId: 'member-a', userName: '视频团队', archived: false },
    { id: 'member-a-2', userId: 'member-a', userName: '视频团队', archived: false },
    { id: 'member-b-archive', userId: 'member-b', userName: '内容团队', archived: true },
    { id: 'internal', userId: 'internal', userName: 'Internal', internalRole: 'summary', archived: false },
  ];
  const context = {
    console,
    FILTER_ALL_VALUE: '__all__',
    ACCOUNT_FILTER_ADMIN_VALUE: '__admin__',
    activeAccountFilter: '__all__',
    activeTab: 'sessions',
    visitorMode: false,
    sessions,
    teamSessionView: {
      enabled,
      canManage,
      currentAccount: { id: 'owner', name: 'Owner', kind: 'admin' },
    },
    canManageTeamSessionView() {
      return canManage;
    },
    getActiveSessions() {
      return sessions.filter((session) => !session.archived && !session.internalRole);
    },
    accountFilterSelect: createSelect(''),
    sourceFilterSelect: createSelect('none'),
    sidebarFilters: {
      classList: {
        toggle(className, force) {
          state.toggles.push({ className, force });
        },
      },
    },
    document: {
      createElement(tagName) {
        return { tagName, value: '', textContent: '', style: {}, hidden: false };
      },
    },
    t(key, values = {}) {
      if (key === 'sidebar.filter.allUsers') return `全部账号 (${values.count})`;
      if (key === 'sidebar.filter.mine') return `我的会话 (${values.count})`;
      if (key === 'sidebar.filter.userCount') return `${values.name} (${values.count})`;
      return key;
    },
    persistActiveAccountFilter(value) {
      state.persisted.push(value);
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${functionSources}\nObject.assign(globalThis, { matchesAccountFilter, getAccountFilterDefinitions, getSessionCountForAccountFilter, renderAccountFilterOptions });`,
    context,
    { filename: 'static/chat/bootstrap-session-catalog.js' },
  );
  return { context, state };
}

{
  const { context } = createHarness();
  assert.equal(context.matchesAccountFilter(context.sessions[0], '__admin__'), true, 'legacy unowned sessions should count as the admin\'s sessions');
  assert.equal(context.matchesAccountFilter(context.sessions[1], '__admin__'), true, 'explicit owner sessions should count as the admin\'s sessions');
  assert.equal(context.matchesAccountFilter(context.sessions[2], '__admin__'), false, 'member sessions should not appear in the admin-only view');
  assert.equal(context.matchesAccountFilter(context.sessions[2], 'member-a'), true);
  assert.equal(context.matchesAccountFilter(context.sessions[4], 'member-a'), false);
  assert.equal(context.getSessionCountForAccountFilter('__all__'), 4);
  assert.equal(context.getSessionCountForAccountFilter('__admin__'), 2);
  assert.equal(context.getSessionCountForAccountFilter('member-a'), 2);

  const definitions = Array.from(context.getAccountFilterDefinitions(), (account) => ({ ...account }));
  assert.deepEqual(
    definitions,
    [
      { value: 'member-b', name: '内容团队' },
      { value: 'member-a', name: '视频团队' },
    ],
    'account choices should include member identities found in active or archived sessions',
  );

  context.renderAccountFilterOptions();
  assert.equal(context.accountFilterSelect.style.display, '');
  assert.deepEqual(
    context.accountFilterSelect.children.map((option) => option.value),
    ['__all__', '__admin__', 'member-b', 'member-a'],
  );
  assert.deepEqual(
    context.accountFilterSelect.children.map((option) => option.textContent),
    ['全部账号 (4)', '我的会话 (2)', '内容团队 (0)', '视频团队 (2)'],
  );
}

{
  const { context } = createHarness({ enabled: false });
  assert.equal(context.matchesAccountFilter(context.sessions[2], '__admin__'), true, 'the account filter should have no effect while team view is off');
  context.renderAccountFilterOptions();
  assert.equal(context.accountFilterSelect.style.display, 'none', 'the account filter should be hidden while team view is off');
}

console.log('test-chat-account-filter: ok');
