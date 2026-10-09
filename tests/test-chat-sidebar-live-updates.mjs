import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (name) => readFileSync(new URL(`../static/chat/${name}`, import.meta.url), 'utf8');
const source = read('session-list-ui.js');
function extract(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  return text.slice(start, text.indexOf('\n}', start) + 2);
}

class Node {
  constructor(className = '', dataset = {}) {
    this.className = className;
    this.dataset = dataset;
    this.children = [];
    this.parentNode = null;
    this.classList = { contains: (name) => this.className.split(' ').includes(name) };
  }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  insertBefore(node, cursor) {
    if (node === cursor) return;
    if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
    const index = cursor ? this.children.indexOf(cursor) : this.children.length;
    assert.ok(index >= 0, 'insertion cursor must belong to the parent');
    this.children.splice(index, 0, node);
    node.parentNode = this;
  }
  append(node) { this.insertBefore(node, null); }
  replaceWith(node) {
    const parent = this.parentNode;
    parent.children.splice(parent.children.indexOf(this), 1, node);
    node.parentNode = parent;
    this.parentNode = null;
  }
  querySelector(selector) {
    const id = selector.match(/data-session-id="([^"]+)"/)?.[1];
    for (const child of this.children) {
      if (child.dataset.sessionId === id) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

const root = new Node();
const frames = [];
let fullRenders = 0;
let createdRows = 0;
let records = [
  { id: 'a', group: 'R', lastEventAt: '2026-10-09T10:00:00Z' },
  { id: 'b', group: 'R', lastEventAt: '2026-10-09T09:00:00Z' },
  { id: 'c', group: 'S', lastEventAt: '2026-10-09T08:00:00Z' },
  { id: 'hidden', group: 'H', hidden: true, lastEventAt: '2026-10-09T07:00:00Z' },
];
const makeRow = (session) => {
  const node = new Node('session-item', { sessionId: session.id });
  node.session = session;
  return node;
};
const groups = new Map();
for (const key of ['R', 'S']) {
  const group = new Node('folder-group', { groupKey: key });
  const items = new Node('folder-group-items');
  for (const session of records.filter((entry) => entry.group === key)) items.append(makeRow(session));
  group.append(items);
  groups.set(key, group);
  root.append(group);
}
const archive = new Node('archived-section');
root.append(archive);
const context = vm.createContext({
  console, Map, Set, Date, CSS: { escape: (value) => value }, sessionList: root,
  activeSessionSpace: 'all',
  requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
  getVisibleActiveSessions: () => records.filter((entry) => !entry.hidden && !entry.pinned && !entry.archived)
    .sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt)),
  getVisiblePinnedSessions: () => records.filter((entry) => !entry.hidden && entry.pinned && !entry.archived),
  getSessionGroupInfo: (session) => ({ key: session.group, label: session.group }),
  getComparableSessionStateSignature: JSON.stringify,
  createActiveSessionItem: (session) => { createdRows += 1; return makeRow(session); },
  renderSessionSpaceSwitcher() {}, refocusActiveSessionRenameInput() {},
  renderSessionList() {
    fullRenders += 1;
    vm.runInContext('sessionSidebarRenderRevision += 1; pendingSessionSidebarUpdates.clear();', context);
  },
});
vm.runInContext(source.slice(source.indexOf('let activeSessionRename'), source.indexOf('function getProjectGroupSessionSortTime'))
  + ['getProjectGroupSessionSortTime', 'getProjectGroupLatestActivityTime', 'compareProjectGroupsByLatestActivity', 'sortProjectGroupsByLatestActivity']
    .map((name) => extract(source, name)).join('\n'), context);
const row = (id) => root.querySelector(`.session-item[data-session-id="${id}"]`);
const a = row('a');
a.renameInput = { value: 'draft name', composing: true };
const b = row('b');
function update(id, fields) {
  const previous = records.find((entry) => entry.id === id);
  const next = { ...previous, ...fields };
  records = records.map((entry) => entry.id === id ? next : entry);
  context.queueSessionSidebarUpdate(next, previous);
}

update('b', { name: 'intermediate', lastEventAt: '2026-10-09T11:00:00Z' });
update('b', { name: 'latest', status: 'running' });
update('c', { lastEventAt: '2026-10-09T12:00:00Z' });
assert.equal(frames.length, 1, 'a burst should schedule one browser frame');
frames.shift()();
assert.equal(fullRenders, 0, 'ordinary background activity must not rebuild the list');
assert.equal(createdRows, 2, 'one row per changed session, including the latest burst update');
assert.equal(row('b').session.name, 'latest');
assert.equal(row('b').session.status, 'running');
assert.notEqual(row('b'), b);
assert.equal(row('a'), a, 'unrelated row nodes and rename inputs must remain attached');
assert.deepEqual(a.renameInput, { value: 'draft name', composing: true });
assert.deepEqual(groups.get('R').firstElementChild.children.map((node) => node.dataset.sessionId), ['b', 'a']);
assert.deepEqual(root.children, [groups.get('S'), groups.get('R'), archive], 'activity reorders existing groups and retains the archive');

update('hidden', { status: 'running' });
frames.shift()();
assert.equal(fullRenders, 0, 'activity outside the selected filters should not rebuild visible rows');
assert.equal(createdRows, 2);
update('b', { pinned: true });
update('c', { name: 'another update' });
frames.shift()();
assert.equal(fullRenders, 1, 'a structural change should rebuild once from all current metadata');
assert.equal(createdRows, 2, 'a complete render supersedes the rest of the pending row patches');

update('c', { name: 'stale queued patch' });
context.renderSessionList();
frames.shift()();
assert.equal(createdRows, 2, 'a synchronous filter/selection render must discard queued patches');

context.activeSessionSpace = 'removed-space';
context.renderSessionSpaceSwitcher = () => { context.activeSessionSpace = 'all'; };
update('hidden', { status: 'idle' });
const rendersBeforeSpaceFallback = fullRenders;
frames.shift()();
assert.equal(fullRenders, rendersBeforeSpaceFallback + 1,
  'removing the selected Space must refresh rows for the fallback All selection');

// Identity lookup must avoid copying the directory once per session, and a
// refreshed directory must invalidate the index rather than retain old owners.
const bootstrap = read('bootstrap.js');
const personContext = vm.createContext({
  Map, peopleDirectory: [{ id: 'person-a', identities: [{ id: 'identity' }] }],
  normalizeBootstrapPeople: (raw) => raw,
  window: {}, getPeopleDirectory: () => { throw new Error('directory copies are unnecessary'); },
});
vm.runInContext('let identityPersonIndex = null;\n'
  + extract(bootstrap, 'getPersonIdForSessionIdentity') + '\n'
  + extract(bootstrap, 'replacePeopleDirectory'), personContext);
assert.equal(personContext.getPersonIdForSessionIdentity('identity'), 'person-a');
assert.equal(personContext.getPersonIdForSessionIdentity('missing'), '');
personContext.getPeopleDirectory = () => [];
personContext.replacePeopleDirectory([{ id: 'person-b', identities: [{ id: 'identity' }] }]);
assert.equal(personContext.getPersonIdForSessionIdentity('identity'), 'person-b');
console.log('test-chat-sidebar-live-updates: ok');
