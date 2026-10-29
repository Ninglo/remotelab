import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectMemberSync, normalizeProjectMemberSync } from '../connectors/feishu/project-member-sync.mjs';
import { normalizeFeishuProjectLinks } from '../connectors/feishu/linked-project-context.mjs';

const ADDED = 'im.chat.member.user.added_v1', DELETED = 'im.chat.member.user.deleted_v1';
const time = 1793280000000;
async function fixture(t, { initial = false, groups = { a: ['one'], b: [], c: [] } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'project-member-sync-'));
  const roster = new Map(Object.entries(groups).map(([id, users]) => [id, new Set(users)]));
  const writes = [], errors = [];
  const runtime = { config: { storageDir: directory, projectMemberSync: {
    notBefore: new Date(time - 1000).toISOString(), initialSyncId: initial ? 'migration-1' : '',
  }, projectLinks: normalizeFeishuProjectLinks([{ projectId: 'project', chatIds: Object.keys(groups), memberSync: true }]) },
  botIdentity: { openId: 'bot' } };
  const behavior = {};
  const request = async args => {
    const chat = args.url.split('/').at(-2);
    if (args.method === 'GET') {
      if (behavior.read) return behavior.read(chat, args);
      return { code: 0, data: { items: [...roster.get(chat)].map(member_id => ({ member_id, member_id_type: 'open_id' })), has_more: false } };
    }
    assert.equal(args.method, 'POST', 'synchronizer must never remove people');
    writes.push({ chat, ids: args.data.id_list });
    if (behavior.write) return behavior.write(chat, args);
    for (const id of args.data.id_list) roster.get(chat).add(id);
    return { code: 0, data: {} };
  };
  let sync = createProjectMemberSync(runtime, { request, onError: e => errors.push(e), now: () => time });
  t.after(async () => { sync.stop(); await sync.idle(); await rm(directory, { recursive: true, force: true }); });
  const raw = (chat, id, at = time, operator = 'human', users = ['one']) => ({
    header: { event_id: id, create_time: String(at) },
    event: { chat_id: chat, operator_id: { open_id: operator }, users: users.map(open_id => ({ user_id: { open_id } })) },
  });
  return { runtime, roster, writes, errors, behavior, raw,
    get sync() { return sync; },
    async restart() { sync.stop(); await sync.idle(); sync = createProjectMemberSync(runtime, { request, onError: e => errors.push(e) }); await sync.start(); await sync.idle(); },
    async event(type, event) { await sync.handlers[type](event); await sync.idle(); },
  };
}

test('multi-group registry validates bindings and preserves paired context roles', () => {
  const links = normalizeFeishuProjectLinks([{ projectId: 'p', discussionChatId: 'a', workChatId: 'b', chatIds: ['c'], memberSync: true }]);
  assert.deepEqual(links[0].chatIds, ['a', 'b', 'c']);
  assert.throws(() => normalizeFeishuProjectLinks([...links, { projectId: 'q', chatIds: ['c', 'd'] }]), /multiple/);
  assert.throws(() => normalizeFeishuProjectLinks([{ projectId: 'p', chatIds: ['a'] }]), /distinct/);
  assert.throws(() => normalizeProjectMemberSync({ notBefore: 'invalid' }), /notBefore/);
});

test('new join fills all project groups; duplicate and Bot echoes do not propagate', async t => {
  const f = await fixture(t); await f.sync.start();
  await f.event(ADDED, f.raw('a', 'join'));
  assert.deepEqual(f.writes.map(x => x.chat), ['b', 'c']);
  await f.event(ADDED, f.raw('a', 'join'));
  f.roster.get('c').delete('one');
  await f.event(ADDED, f.raw('b', 'echo', time + 100, 'bot'));
  assert.equal(f.writes.length, 2);
  assert.equal(f.roster.get('c').has('one'), false);
  await f.event(ADDED, f.raw('outside', 'unbound'));
  assert.equal(f.writes.length, 2);
});

test('departures fence delayed joins; a later genuine join starts a new addition', async t => {
  const f = await fixture(t); await f.sync.start();
  await f.event(DELETED, f.raw('b', 'left', time + 100));
  await f.event(ADDED, f.raw('a', 'old-join', time));
  assert.equal(f.roster.get('b').has('one'), false);
  assert.equal(f.roster.get('c').has('one'), true);
  await f.event(ADDED, f.raw('a', 'new-join', time + 200));
  assert.equal(f.roster.get('b').has('one'), true);
  f.roster.get('a').delete('one');
  f.roster.get('c').delete('one');
  await f.event(ADDED, f.raw('a', 'late-delivery', time + 300));
  assert.equal(f.roster.get('c').has('one'), false, 'verify source still contains the joining person');
});

test('SDK-flattened events and independent invitations by the same Bot also propagate', async t => {
  const f = await fixture(t); await f.sync.start();
  const raw = f.raw('a', 'bot-manual-join', time, 'bot');
  await f.event(ADDED, { ...raw.header, ...raw.event });
  assert.deepEqual(f.writes.map(x => x.chat), ['b', 'c']);
  f.roster.get('b').delete('one');
  await f.event(DELETED, f.raw('b', 'left-b', time + 100));
  f.roster.get('b').add('one');
  f.roster.get('c').delete('one');
  await f.event(ADDED, f.raw('b', 'bot-rejoin-b', time + 200, 'bot'));
  assert.equal(f.roster.get('c').has('one'), true);
});

test('initial union is frozen and runs once across restart, including after someone leaves', async t => {
  const f = await fixture(t, { initial: true, groups: { a: ['one'], b: ['two'], c: [] } });
  await f.sync.start(); await f.sync.idle();
  for (const users of f.roster.values()) assert.deepEqual([...users].sort(), ['one', 'two']);
  const count = f.writes.length;
  f.roster.get('b').delete('one');
  await f.event(DELETED, f.raw('b', 'left'));
  await f.restart();
  assert.equal(f.writes.length, count);
  assert.equal(f.roster.get('b').has('one'), false);
});

test('initial union respects a persisted departure even with a newly requested migration', async t => {
  const f = await fixture(t); await f.sync.start();
  await f.event(DELETED, f.raw('b', 'left'));
  f.runtime.config.projectMemberSync.initialSyncId = 'later-migration';
  await f.restart();
  assert.equal(f.roster.get('b').has('one'), false);
  assert.equal(f.roster.get('c').has('one'), true);
});

test('ambiguous and pending writes remain visible, and restart never re-invites', async t => {
  const f = await fixture(t); await f.sync.start();
  f.behavior.write = async chat => {
    if (chat === 'b') throw new Error('connection lost after write');
    return { code: 0, data: { pending_approval_id_list: ['one'] } };
  };
  await f.event(ADDED, f.raw('a', 'join'));
  assert.equal(f.writes.length, 2);
  assert.equal(f.errors.length, 1);
  await f.restart();
  await f.event(ADDED, f.raw('a', 'join'));
  assert.equal(f.writes.length, 2);
});

test('departure received during an addition prevents the subsequent target invitation', async t => {
  const f = await fixture(t); await f.sync.start();
  f.behavior.write = async (chat, args) => {
    for (const id of args.data.id_list) f.roster.get(chat).add(id);
    if (chat === 'b') await f.sync.handlers[DELETED](f.raw('c', 'left-during-write', time + 100));
    return { code: 0, data: {} };
  };
  await f.event(ADDED, f.raw('a', 'join'));
  assert.deepEqual(f.writes.map(x => x.chat), ['b']);
});

test('incomplete pagination never seeds a union and batching honors the provider limit', async t => {
  const f = await fixture(t);
  f.behavior.read = async () => ({ code: 0, data: { items: [], has_more: true, page_token: 'repeated' } });
  await assert.rejects(f.sync.list('a'), /pagination/);
  assert.equal(f.writes.length, 0);
  delete f.behavior.read;
  const users = Array.from({ length: 101 }, (_, i) => `user-${i}`);
  f.roster.set('a', new Set(users));
  await f.sync.start(); await f.event(ADDED, f.raw('a', 'batch', time, 'human', users));
  assert.deepEqual(f.writes.map(x => x.ids.length), [50, 50, 1, 50, 50, 1]);
});
