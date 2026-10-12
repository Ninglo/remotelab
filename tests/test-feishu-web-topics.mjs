import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const scratch = await mkdtemp(join(tmpdir(), 'remotelab-topic-read-')); setIsolatedTestHome(scratch);
after(() => rm(scratch, { recursive: true, force: true }));
const { createFeishuTopicSource, topicProjection, topicIds } = await import('../chat/feishu-web-topics.mjs');
const { handleFeishuWebTopics } = await import('../chat/router-feishu-web-topics.mjs');
const { updateAuthDocument } = await import('../lib/auth-config.mjs');
const auth = await import('../chat/feishu-web-settings.mjs');
const { broadcastAll } = await import('../chat/ws-clients.mjs');
await updateAuthDocument(d => { d.people = [{ id: 'person_a', name: 'A', credentials: [], preferences: {}, identities: [{ id: 'identity_a', kind: 'web', realm: 'remotelab', subjectId: 'a' }] }]; d.primaryPersonId = 'person_a'; });
const actor = { personId: 'person_a', identityId: 'identity_a' };
const session = (id, root, run = 'running') => ({ id, name: '真实标题', description: '真实摘要', conversation: { connector: 'feishu', sourceRouteId: 'bot-2', target: { chatType: 'group', rootId: root, threadId: 'thread' } }, activity: { run: { state: run }, queue: { state: 'idle', count: 0 }, compact: { state: 'idle' } } });
test('projection shares native running precedence and never infers running from old task completion', () => {
  const s = session('a'.repeat(32), 'root'); s.workflowState = 'done';
  assert.equal(topicProjection(s, 'native').status, 'running');
  s.activity.run.state = 'idle'; assert.notEqual(topicProjection(s, 'native').status, 'running');
  s.name = '【飞书群消息｜发言人：A】'; s.description = 'inbound feishu';
  s.workAwareness = { works: [{ goal: '已登记目标', updatedAt: '2026-10-12' }] };
  assert.equal(topicProjection(s, 'native').name, '已登记目标');
  assert.equal(topicProjection(s, 'native').summary, '已登记目标');
});
test('snapshot reads only requested verified bot-2 group topics and omits private and conflicting sessions', async () => {
  const valid = session('a'.repeat(32), 'root'), privateChat = session('b'.repeat(32), 'private'); privateChat.conversation.target.chatType = 'p2p';
  const wrong = session('c'.repeat(32), 'wrong'); wrong.conversation.sourceRouteId = 'bot-1';
  const records = [valid, privateChat, wrong]; const reads = [];
  const api = createFeishuTopicSource({ sessions: async () => records, session: async id => { reads.push(id); return records.find(s => s.id === id); }, bindings: async () => ({ bindings: { root: 'native', private: 'private', wrong: 'wrong' } }) });
  const data = await api.snapshot(['native', 'private', 'wrong']); assert.equal(data.entries.length, 1); assert.deepEqual(reads, [valid.id]);
  records.push(session('d'.repeat(32), 'root')); assert.equal((await api.snapshot(['native'])).entries.length, 0);
  assert.throws(() => topicIds('../etc/passwd')); assert.throws(() => topicIds(Array(201).fill('id').join(',')));
});
test('source pushes changed real state and releases its listener when the browser disconnects', async () => {
  const s = session('a'.repeat(32), 'root'); const api = createFeishuTopicSource({ sessions: async () => [s], session: async () => s, bindings: async () => ({ bindings: { root: 'native' } }) });
  const delivered = []; let wake; const next = () => new Promise(resolve => { wake = resolve; });
  const initial = next(); const off = await api.subscribe(['native'], data => { delivered.push(data); wake?.(); }, error => { throw error; }); await initial;
  assert.equal(delivered[0].entries[0].status, 'running');
  s.activity.run.state = 'idle'; const changed = next(); broadcastAll({ type: 'session_invalidated', sessionId: s.id }); await changed;
  assert.notEqual(delivered.at(-1).entries[0].status, 'running'); off();
  const count = delivered.length; broadcastAll({ type: 'session_invalidated', sessionId: s.id }); await new Promise(resolve => setImmediate(resolve)); assert.equal(delivered.length, count);
});
test('topics use a new exact-account read-only capability and cannot borrow settings or workspace tokens', async () => {
  const input = { origin: 'https://fixture.feishu.cn', nativeAccount: '1000000000000000001', confirm: true };
  const linked = await auth.connectFeishuWebSettings(input, actor, 'topics');
  assert.match(linked.token, /^fwtops_/); assert.equal((await auth.authorizeFeishuWebSettings(linked.token, input.origin, input.nativeAccount, 'topics')).personId, 'person_a');
  await assert.rejects(auth.authorizeFeishuWebSettings(linked.token, input.origin, input.nativeAccount, 'workspace'));
  await assert.rejects(auth.authorizeFeishuWebSettings(linked.token, input.origin, '1000000000000000002', 'topics'));
  async function request(token, operation = 'snapshot?ids=native') {
    const req = Readable.from([]); req.url = '/api/feishu-web-topics/' + operation; req.method = 'GET'; req.headers = { authorization: 'Bearer ' + token, 'x-feishu-origin': input.origin, 'x-feishu-account': input.nativeAccount };
    let result; const res = { setHeader() {} };
    await handleFeishuWebTopics({ req, res, pathname: req.url.split('?')[0], source: { snapshot: async ids => ({ ids }) }, writeJson: (_, status, body) => { result = { status, body }; } }); return result;
  }
  assert.equal((await request(linked.token)).status, 200);
  const settings = await auth.connectFeishuWebSettings(input, actor); assert.equal((await request(settings.token)).status, 401);
  assert.equal((await request(linked.token, 'arbitrary')).status, 404);
  await auth.disconnectFeishuWebSettings(await auth.authorizeFeishuWebSettings(linked.token, input.origin, input.nativeAccount, 'topics'));
  assert.equal((await request(linked.token)).status, 401);
});
