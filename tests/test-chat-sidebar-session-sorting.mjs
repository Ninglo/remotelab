#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const bootstrapSource = readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap-session-catalog.js'), 'utf8');
const sessionListUiSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-list-ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
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
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const getSessionSortTimeSource = extractFunctionSource(bootstrapSource, 'getSessionSortTime');
const getSessionPinSortRankSource = extractFunctionSource(bootstrapSource, 'getSessionPinSortRank');
const compareSessionListSessionsSource = extractFunctionSource(bootstrapSource, 'compareSessionListSessions');
const sortSessionsInPlaceSource = extractFunctionSource(bootstrapSource, 'sortSessionsInPlace');
const matchesSearchQuerySource = extractFunctionSource(bootstrapSource, 'matchesSearchQuery');
const getSessionSpaceValueSource = extractFunctionSource(bootstrapSource, 'getSessionSpaceValue');
const matchesSessionSpaceSource = extractFunctionSource(bootstrapSource, 'matchesSessionSpace');
const getActiveSessionsSource = extractFunctionSource(bootstrapSource, 'getActiveSessions');
const getProjectGroupSessionSortTimeSource = extractFunctionSource(sessionListUiSource, 'getProjectGroupSessionSortTime');
const getProjectGroupRunningRankSource = extractFunctionSource(sessionListUiSource, 'getProjectGroupRunningRank');
const getProjectGroupAttentionRankSource = extractFunctionSource(sessionListUiSource, 'getProjectGroupAttentionRank');
const getProjectGroupLatestActivityTimeSource = extractFunctionSource(sessionListUiSource, 'getProjectGroupLatestActivityTime');
const getProjectGroupOrganizerOrderSource = extractFunctionSource(sessionListUiSource, 'getProjectGroupOrganizerOrder');
const compareProjectGroupsByLatestActivitySource = extractFunctionSource(sessionListUiSource, 'compareProjectGroupsByLatestActivity');
const sortProjectGroupsByLatestActivitySource = extractFunctionSource(sessionListUiSource, 'sortProjectGroupsByLatestActivity');
const renderProjectsViewSource = extractFunctionSource(sessionListUiSource, 'renderProjectsView');

const context = {
  console,
  Date,
  sessionStateModel: {
    getSessionSortTime(session) {
      return Date.parse(session.lastEventAt || session.updatedAt || session.created || '') || 0;
    },
    compareSessionListSessions(a, b) {
      return (b.rank || 0) - (a.rank || 0)
        || (Date.parse(b.lastEventAt || b.updatedAt || b.created || '') || 0)
          - (Date.parse(a.lastEventAt || a.updatedAt || a.created || '') || 0);
    },
  },
  getSessionActivity(session) {
    return {
      run: {
        state: session?.activity?.run?.state === 'running' ? 'running' : 'idle',
      },
    };
  },
  getInboxBandForSession(session) {
    return Number.isInteger(session?.attentionBand) ? session.attentionBand : 3;
  },
  SESSION_SPACE_ALL_VALUE: '__all_spaces__',
  SESSION_SPACE_LOOSE_VALUE: '__loose_space__',
  activeSessionSpace: '__all_spaces__',
  sessionSearchQuery: '',
  sessions: [
    {
      id: 'metadata-only-newer',
      rank: 1,
      updatedAt: '2026-03-12T12:00:00.000Z',
      lastEventAt: '2026-03-12T08:00:00.000Z',
    },
    {
      id: 'actual-activity-newer',
      rank: 5,
      updatedAt: '2026-03-12T09:00:00.000Z',
      lastEventAt: '2026-03-12T11:00:00.000Z',
    },
    {
      id: 'pinned-session',
      pinned: true,
      updatedAt: '2026-03-12T07:00:00.000Z',
      lastEventAt: '2026-03-12T07:00:00.000Z',
    },
  ],
};
context.globalThis = context;

vm.runInNewContext(
  `${getSessionSortTimeSource}\n${getSessionPinSortRankSource}\n${compareSessionListSessionsSource}\n${sortSessionsInPlaceSource}\n${matchesSearchQuerySource}\n${getSessionSpaceValueSource}\n${matchesSessionSpaceSource}\n${getActiveSessionsSource}`,
  context,
  { filename: 'static/chat/bootstrap-session-catalog.js' },
);

context.sortSessionsInPlace();

assert.deepEqual(
  context.sessions.map((session) => session.id),
  ['pinned-session', 'actual-activity-newer', 'metadata-only-newer'],
  'sidebar sorting should follow pinning first and then the delegated attention comparator',
);

assert.equal(context.getSessionSpaceValue({ space: 'Product' }), 'Product');
assert.equal(context.getSessionSpaceValue({ space: 'Loose' }), '__loose_space__');
assert.equal(context.getSessionSpaceValue({}), '__loose_space__');
assert.equal(context.matchesSessionSpace({ space: 'Product' }, 'Product'), true);
assert.equal(context.matchesSessionSpace({ space: 'Content' }, 'Product'), false);
assert.equal(context.matchesSessionSpace({ space: 'Content' }, '__all_spaces__'), true);
context.sessionSearchQuery = 'product';
assert.equal(
  context.matchesSearchQuery({ name: 'Unrelated', space: 'Product', group: '', description: '' }),
  true,
  'session search should include AI-assigned Space names',
);
context.sessionSearchQuery = '';

context.sessions.push(
  { id: 'hidden-organizer', internalRole: 'session_list_organizer' },
  { id: 'archived-session', archived: true },
);
assert.deepEqual(
  context.getActiveSessions().map((session) => session.id),
  ['pinned-session', 'actual-activity-newer', 'metadata-only-newer'],
  'user-facing session lists should exclude hidden internal and archived sessions',
);

vm.runInNewContext(
  [
    getProjectGroupSessionSortTimeSource,
    getProjectGroupRunningRankSource,
    getProjectGroupAttentionRankSource,
    getProjectGroupLatestActivityTimeSource,
    getProjectGroupOrganizerOrderSource,
    compareProjectGroupsByLatestActivitySource,
    sortProjectGroupsByLatestActivitySource,
    renderProjectsViewSource,
  ].join('\n'),
  context,
  { filename: 'static/chat/session-list-ui.js' },
);

const projectGroups = [
  {
    key: 'june-01',
    label: 'June 1 project',
    sessions: [
      { id: 'june-01', lastEventAt: '2026-06-01T10:00:00.000Z' },
    ],
  },
  {
    key: 'june-05',
    label: 'June 5 project',
    sessions: [
      { id: 'june-05-old', lastEventAt: '2026-06-04T10:00:00.000Z' },
      { id: 'june-05', lastEventAt: '2026-06-05T10:00:00.000Z' },
    ],
  },
  {
    key: 'running',
    label: 'Running project',
    sessions: [
      {
        id: 'running',
        lastEventAt: '2026-06-02T10:00:00.000Z',
        activity: { run: { state: 'running' } },
      },
    ],
  },
  {
    key: 'june-10',
    label: 'June 10 project',
    sessions: [
      { id: 'june-10', lastEventAt: '2026-06-10T10:00:00.000Z' },
    ],
  },
];

assert.deepEqual(
  context.sortProjectGroupsByLatestActivity(projectGroups).map((group) => group.key),
  ['running', 'june-10', 'june-05', 'june-01'],
  'Projects view should sort unorganized project groups by current running state first and then latest activity descending',
);

const organizedGroups = [
  {
    key: 'organized-later',
    label: 'Organized later',
    sessions: [
      { id: 'organized-later', sidebarOrder: 8, lastEventAt: '2026-06-10T10:00:00.000Z' },
    ],
  },
  {
    key: 'organized-first',
    label: 'Organized first',
    sessions: [
      { id: 'organized-first', sidebarOrder: 2, lastEventAt: '2026-06-01T10:00:00.000Z' },
    ],
  },
];

assert.deepEqual(
  context.sortProjectGroupsByLatestActivity(organizedGroups).map((group) => group.key),
  ['organized-first', 'organized-later'],
  'Projects view should honor organizer sidebar order across groups when both groups have explicit order',
);

const attentionGroups = [
  {
    key: 'organized-first',
    label: 'Organized first',
    sessions: [
      { id: 'organized-first', sidebarOrder: 1, attentionBand: 3, lastEventAt: '2026-06-10T10:00:00.000Z' },
    ],
  },
  {
    key: 'needs-attention',
    label: 'Needs attention',
    sessions: [
      { id: 'needs-attention', sidebarOrder: 9, attentionBand: 1, lastEventAt: '2026-06-01T10:00:00.000Z' },
    ],
  },
];

assert.deepEqual(
  context.sortProjectGroupsByLatestActivity(attentionGroups).map((group) => group.key),
  ['needs-attention', 'organized-first'],
  'Projects view should raise groups needing attention before organized order',
);

function createElement() {
  return {
    className: '',
    innerHTML: '',
    children: [],
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
    },
  };
}

context.document = { createElement };
context.collapsedFolders = {};
context.localStorage = { setItem() {} };
context.renderUiIcon = () => '';
context.esc = (value) => String(value);
context.getSessionGroupInfo = () => ({ key: 'content', label: 'Content', title: 'Content' });
context.createActiveSessionItem = (session) => ({ session });
context.sessionList = createElement();
context.renderProjectsView([
  { id: 'needs-attention', attentionBand: 1 },
  { id: 'active', attentionBand: 3 },
]);

const projectHeader = context.sessionList.children[0]?.children[0];
assert.match(projectHeader?.innerHTML || '', /class="folder-count">2<\/span>/, 'Projects view should keep the group total');
assert.doesNotMatch(projectHeader?.innerHTML || '', /folder-attention-count/, 'Projects view should not render an extra attention count badge');

console.log('test-chat-sidebar-session-sorting: ok');
