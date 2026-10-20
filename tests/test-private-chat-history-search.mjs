import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'private-chat-history-'));
setIsolatedTestHome(home);
try {
  const { createSessionLogSearch } = await import('../chat/session-log-search.mjs');
  const historyDir = join(home, 'history');
  const indexDir = join(home, 'index');
  const ids = Array.from({ length: 8 }, (_, i) => String(i + 1).repeat(32));
  const source = { connector: 'feishu', sourceRouteId: 'bot-a', chatType: 'p2p',
    chatId: 'private-a', sender: { tenantKey: 'tenant-a' } };
  const sessions = [
    { id: ids[0], name: 'Old conversation', sourceContext: source, conversation: null, archived: true },
    { id: ids[1], name: 'New conversation', conversation: { connector: 'feishu', sourceRouteId: 'bot-a',
      target: { chatType: 'p2p', chatId: 'private-a', tenantKey: 'tenant-a', conversationKind: 'main' } } },
    { id: ids[2], name: 'Other person', sourceContext: { ...source, chatId: 'private-b' } },
    { id: ids[3], name: 'Other Bot', sourceContext: { ...source, sourceRouteId: 'bot-b' } },
    { id: ids[4], name: 'Group', sourceContext: { ...source, chatType: 'group' } },
    { id: ids[5], name: 'Other tenant', sourceContext: { ...source, sender: { tenantKey: 'tenant-b' } } },
    { id: ids[6], name: 'Helper', sourceContext: source, internalRole: 'classifier' },
    { id: ids[7], name: 'Unknown source', sourceContext: { ...source, sender: {} } },
  ];
  const items = [
    { type: 'message', role: 'user', timestamp: 100, content: '之前定下的是紫色按钮。<private>secretneedle</private>' },
    { type: 'tool_result', output: 'toolneedle' },
    { type: 'message', role: 'assistant', timestamp: 200, content: '<hide>secretneedle</hide> 已确认紫色按钮。' },
  ];
  async function events(id, rows) {
    const dir = join(historyDir, id);
    await mkdir(join(dir, 'events'), { recursive: true });
    await Promise.all(rows.map((row, i) => writeFile(join(dir, 'events', `${String(i + 1).padStart(9, '0')}.json`), JSON.stringify(row))));
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ latestSeq: rows.length, lastEventAt: `stamp-${rows.length}` }));
  }
  await events(ids[0], items);
  await events(ids[1], []);
  for (const id of ids.slice(2)) await events(id, [
    { type: 'message', role: 'user', content: '紫色按钮 excludedneedle' },
  ]);
  const opts = { historyDir, indexDir, list: async () => sessions,
    readCaseConfig: async () => { assert.fail('private-history lookup does not require trace configuration'); },
    sessionHref: id => `https://remote.example/?session=${id}` };
  const scope = { scope: 'private-chat', sessionId: ids[1] };
  let search = createSessionLogSearch(opts);
  const result = await search('紫色按钮', scope);
  assert.equal(result.incomplete, false);
  assert.equal(result.searchedSessionCount, 2);
  assert.deepEqual(result.sessions.map(row => row.id), [ids[0]]);
  assert.deepEqual(result.sessions[0].matches.map(row => row.seq), [3, 1]);
  assert.equal(result.sessions[0].matches[0].timestamp, 200);
  assert.match(result.sessions[0].matches[0].excerpt, /已确认紫色按钮/);
  assert.doesNotMatch(JSON.stringify(result), /secretneedle|toolneedle/);
  assert.equal(result.sessions[0].matches[0].eventPath, `/api/sessions/${ids[0]}/events?filter=all&afterSeq=2&limit=1`);
  assert.deepEqual((await readdir(indexDir)).sort(), ids.slice(0, 2).map(id => `${id}.json`),
    'scope is applied before reading or indexing unrelated histories');
  assert.deepEqual((await search('excludedneedle', scope)).sessions, []);
  assert.deepEqual((await search('secretneedle', scope)).sessions, []);
  assert.deepEqual((await search('toolneedle', scope)).sessions, []);
  assert.equal((await search('紫色按钮', { ...scope, sessionId: ids[0] })).sessions[0].id, ids[0],
    'an archived and unbound source still resolves its original private chat');
  for (const sessionId of ['', ids[4], ids[7], 'missing']) {
    await assert.rejects(search('紫色按钮', { ...scope, sessionId }), { statusCode: 400 });
  }
  await assert.rejects(search('紫色按钮', { scope: 'typo' }), { statusCode: 400 });

  // Warm searches read only matching originals plus new events; disk state
  // survives restart, and overlapping requests share indexing.
  await rm(join(historyDir, ids[0], 'events', '000000002.json'));
  search = createSessionLogSearch(opts);
  assert.equal((await search('紫色按钮', scope)).incomplete, false);
  const newMessage = { type: 'message', role: 'user', content: 'incrementalneedle' };
  await events(ids[1], [newMessage]);
  const [left, right] = await Promise.all([search('incrementalneedle', scope), search('incrementalneedle', scope)]);
  assert.deepEqual(left, right);
  assert.equal(left.sessions[0].matches[0].seq, 1);
  const stored = JSON.parse(await readFile(join(indexDir, `${ids[1]}.json`)));
  assert.equal(stored.seq, 1);
  assert.deepEqual(stored.postings.find(([term]) => term === 'incrementalneedle')[1], [1]);
  await events(ids[1], [newMessage, { ...newMessage, content: 'mixedscopeneedle' }]);
  const sharedSearch = createSessionLogSearch({ ...opts, readCaseConfig: async () => ({}), latestCase: async () => null });
  const [scoped, global] = await Promise.all([
    sharedSearch('mixedscopeneedle', scope), sharedSearch('mixedscopeneedle'),
  ]);
  assert.equal(scoped.sessions[0].id, ids[1]);
  assert.equal(global.sessions[0].id, ids[1]);
  assert.equal(JSON.parse(await readFile(join(indexDir, `${ids[1]}.json`))).counts.find(([term]) => term === 'mixedscopeneedle')[1], 2,
    'global and private lookups do not double-count overlapping incremental writes');
  await events(ids[1], [newMessage, { ...newMessage, bodyRef: 'evt_000000002_content' }]);
  await mkdir(join(historyDir, ids[1], 'bodies'), { recursive: true });
  await writeFile(join(historyDir, ids[1], 'bodies', 'evt_000000002_content.txt'), 'Long prefix '.repeat(500) + 'bodyneedle <private>secretneedle</private>');
  // A changed same-length history is identified by its timestamp.
  await writeFile(join(historyDir, ids[1], 'meta.json'), JSON.stringify({ latestSeq: 2, lastEventAt: 'replaced' }));
  const body = await search('bodyneedle', scope);
  assert.match(body.sessions[0].matches[0].excerpt, /bodyneedle/);
  assert.doesNotMatch(body.sessions[0].matches[0].excerpt, /secretneedle/);
  await rm(join(historyDir, ids[0], 'events', '000000003.json'));
  const missingOriginal = await search('紫色按钮', scope);
  assert.equal(missingOriginal.incomplete, true, 'missing originals are explicit, never silently replaced with unrelated matches');
  assert.deepEqual(missingOriginal.sessions[0].matches.map(row => row.seq), [1]);
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log('test-private-chat-history-search: ok');
