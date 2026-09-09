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
const compareClientSessionsSource = extractFunctionSource(bootstrapSource, 'compareClientSessions');
const sortSessionsInPlaceSource = extractFunctionSource(bootstrapSource, 'sortSessionsInPlace');
const matchesSearchQuerySource = extractFunctionSource(bootstrapSource, 'matchesSearchQuery');
const getSessionSpaceValueSource = extractFunctionSource(bootstrapSource, 'getSessionSpaceValue');
const matchesSessionSpaceSource = extractFunctionSource(bootstrapSource, 'matchesSessionSpace');
const getActiveSessionsSource = extractFunctionSource(bootstrapSource, 'getActiveSessions');
const getProjectGroupSessionSortTimeSource = extractFunctionSource(sessionListUiSource, 'getProjectGroupSessionSortTime');
const getProjectGroupLatestActivityTimeSource = extractFunctionSource(sessionListUiSource, 'getProjectGroupLatestActivityTime');
const compareProjectGroupsByLatestActivitySource = extractFunctionSource(sessionListUiSource, 'compareProjectGroupsByLatestActivity');
const sortProjectGroupsByLatestActivitySource = extractFunctionSource(sessionListUiSource, 'sortProjectGroupsByLatestActivity');
const renderProjectsViewSource = extractFunctionSource(sessionListUiSource, 'renderProjectsView');

const context = {
  console,
  Date,
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
context.window = context;
vm.runInNewContext(readFileSync(join(repoRoot, 'static/chat/session-state-model.js'), 'utf8'), context);
context.sessionStateModel = context.RemoteLabSessionStateModel;

vm.runInNewContext(
  `${getSessionSortTimeSource}\n${getSessionPinSortRankSource}\n${compareSessionListSessionsSource}\n${compareClientSessionsSource}\n${sortSessionsInPlaceSource}\n${matchesSearchQuerySource}\n${getSessionSpaceValueSource}\n${matchesSessionSpaceSource}\n${getActiveSessionsSource}`,
  context,
  { filename: 'static/chat/bootstrap-session-catalog.js' },
);

context.sortSessionsInPlace();

assert.deepEqual(
  context.sessions.map((session) => session.id),
  ['pinned-session', 'actual-activity-newer', 'metadata-only-newer'],
  'sidebar should keep the explicit pinned section and sort regular rows by activity',
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
    getProjectGroupLatestActivityTimeSource,
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
  ['june-10', 'june-05', 'running', 'june-01'],
  'Project groups should sort by latest activity even when an older group is running',
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
  ['organized-later', 'organized-first'],
  'Project groups should ignore legacy organizer order',
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
  ['organized-first', 'needs-attention'],
  'Project groups should ignore attention state',
);

const beforeReview = context.sortProjectGroupsByLatestActivity(attentionGroups).map(group => group.key);
Object.assign(attentionGroups[1].sessions[0], {
  lastAssistantMessageAt: '2026-06-01T10:00:00Z',
  lastReviewedAt: '2026-06-01T11:00:00Z', localReviewedAt: '2026-06-01T11:00:00Z',
  attentionBand: 6, workflowState: 'done',
});
assert.deepEqual(context.sortProjectGroupsByLatestActivity(attentionGroups).map(group => group.key),
  beforeReview, 'reading a session must leave its group in the same position');
attentionGroups[1].sessions[0].lastEventAt = '2026-06-11T10:00:00Z';
assert.deepEqual(context.sortProjectGroupsByLatestActivity(attentionGroups).map(group => group.key),
  ['needs-attention', 'organized-first'], 'new activity should raise the group');

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

const organizerSource = readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');
assert.match(organizerSource, /Only writable API fields for this task are `space` and `group`/);
assert.doesNotMatch(organizerSource, /`sidebarOrder`|existingSidebarOrder/, 'organizer must not assign row order');
console.log('test-chat-sidebar-session-sorting: ok');
