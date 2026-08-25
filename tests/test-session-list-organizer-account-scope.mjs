#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(repoRoot, 'static', 'chat', 'session-http.js'), 'utf8');

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
  'getSessionListOrganizerTargetProjectCount',
  'getSessionListOrganizerTargetSpaceCount',
  'getSessionListOrganizerSourceLabel',
  'getSessionListOrganizerAccountScope',
  'matchesSessionListOrganizerAccountScope',
  'getSessionListOrganizerScope',
].map(extractFunctionSource).join('\n\n');

const sessions = [
  { id: 'owner-chat', sourceId: 'chat' },
  { id: 'owner-feishu', sourceId: 'feishu' },
  { id: 'member-a-chat', userId: 'member-a', sourceId: 'chat' },
  { id: 'member-b-chat', userId: 'member-b', sourceId: 'chat' },
];

function createHarness({ accountFilter = '__all__', memberId = '', adminFilterAvailable = true } = {}) {
  const isMember = !!memberId;
  const context = {
    console,
    FILTER_ALL_VALUE: '__all__',
    ACCOUNT_FILTER_ADMIN_VALUE: '__admin__',
    SESSION_HTTP_FILTER_ALL_VALUE: '__all__',
    SESSION_HTTP_SOURCE_FILTER_CHAT_VALUE: 'chat_ui',
    SESSION_LIST_ORGANIZER_SOURCE_LABELS: { chat_ui: 'Chat UI', __all__: 'All origins' },
    activeAccountFilter: accountFilter,
    activeSourceFilter: '__all__',
    teamSessionView: {
      enabled: true,
      currentAccount: isMember
        ? { id: memberId, name: `Name ${memberId}`, kind: 'member' }
        : { id: 'owner', name: 'Owner', kind: 'admin' },
    },
    normalizeAccountFilter(value) {
      return value || '__all__';
    },
    normalizeSourceFilter(value) {
      return value || '__all__';
    },
    getActiveSourceFilterValue() {
      return '__all__';
    },
    isTeamMemberSessionView() {
      return isMember;
    },
    isAdminAccountFilterAvailable() {
      return !isMember && adminFilterAvailable;
    },
    getAccountFilterDefinitions() {
      return [
        { value: 'member-a', name: 'Member A' },
        { value: 'member-b', name: 'Member B' },
      ];
    },
    getSessionAccountId(session) {
      return session.userId || '';
    },
    getActiveSessions() {
      return sessions;
    },
    matchesSourceFilter(session, filter) {
      if (filter === '__all__') return true;
      if (filter === 'chat_ui') return session.sourceId === 'chat';
      return session.sourceId === filter;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${functionSources}\nObject.assign(globalThis, { getSessionListOrganizerAccountScope, getSessionListOrganizerScope });`,
    context,
    { filename: 'static/chat/session-http.js' },
  );
  return context;
}

{
  const context = createHarness();
  const scope = context.getSessionListOrganizerScope();
  assert.equal(scope.accountId, 'owner');
  assert.equal(scope.defaultedToCurrentAccount, true);
  assert.deepEqual(Array.from(scope.sessions, (session) => session.id), ['owner-chat']);
}

{
  const context = createHarness({ accountFilter: 'member-a' });
  const scope = context.getSessionListOrganizerScope();
  assert.equal(scope.accountId, 'member-a');
  assert.equal(scope.accountLabel, 'Member A');
  assert.deepEqual(Array.from(scope.sessions, (session) => session.id), ['member-a-chat']);
}

{
  const context = createHarness({ memberId: 'member-b' });
  const scope = context.getSessionListOrganizerScope();
  assert.equal(scope.accountId, 'member-b');
  assert.deepEqual(Array.from(scope.sessions, (session) => session.id), ['member-b-chat']);
}

{
  const context = createHarness({ adminFilterAvailable: false });
  const scope = context.getSessionListOrganizerScope();
  assert.equal(scope.accountId, 'owner');
  assert.deepEqual(
    Array.from(scope.sessions, (session) => session.id),
    ['owner-chat'],
    'legacy single-account mode should still avoid account-tagged member sessions',
  );
}

console.log('test-session-list-organizer-account-scope: ok');
