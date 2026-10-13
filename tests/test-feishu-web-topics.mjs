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
  const api = createFeishuTopicSource({ details:async entries=>({entries}), sessions: async () => records, session: async id => { reads.push(id); return records.find(s => s.id === id); }, bindings: async () => ({ bindings: { root: 'native', private: 'private', wrong: 'wrong' } }) });
  const data = await api.snapshot(['native', 'private', 'wrong']); assert.equal(data.entries.length, 1); assert.deepEqual(reads, [valid.id]);
  records.push(session('d'.repeat(32), 'root')); assert.equal((await api.snapshot(['native'])).entries.length, 0);
  assert.throws(() => topicIds('../etc/passwd')); assert.throws(() => topicIds(Array(201).fill('id').join(',')));
});
test('source pushes changed real state and releases its listener when the browser disconnects', async () => {
  const s = session('a'.repeat(32), 'root'); const api = createFeishuTopicSource({ details:async entries=>({entries}), sessions: async () => [s], session: async () => s, bindings: async () => ({ bindings: { root: 'native' } }) });
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
test('existing verified workspace connection activates a distinct read-only token without another login', async () => {
  const input = { origin: 'https://fixture.feishu.cn', nativeAccount: '1000000000000000001', confirm: true };
  const workspace = await auth.connectFeishuWebSettings(input, actor, 'workspace');
  async function activate(token, nativeAccount = input.nativeAccount) {
    const req = Readable.from([]); req.url = '/api/feishu-web-topics/activate'; req.method = 'POST';
    req.headers = { authorization: 'Bearer ' + token, 'x-feishu-origin': input.origin, 'x-feishu-account': nativeAccount };
    let result; await handleFeishuWebTopics({ req, res: { setHeader() {} }, pathname: req.url, writeJson: (_, status, body) => { result = { status, body }; } }); return result;
  }
  const linked = await activate(workspace.token); assert.equal(linked.status, 201); assert.match(linked.body.token, /^fwtops_/);
  assert.ok(linked.body.expiresAt <= workspace.expiresAt);
  assert.equal((await auth.authorizeFeishuWebSettings(linked.body.token, input.origin, input.nativeAccount, 'topics')).personId, actor.personId);
  assert.equal((await activate(workspace.token, '1000000000000000002')).status, 401);
  assert.equal((await activate(linked.body.token)).status, 401);
  const settings = await auth.connectFeishuWebSettings(input, actor); assert.equal((await activate(settings.token)).status, 401);
  await auth.disconnectFeishuWebSettings(await auth.authorizeFeishuWebSettings(workspace.token, input.origin, input.nativeAccount, 'workspace'));
  assert.equal((await activate(workspace.token)).status, 401);
});
test('group boards reuse paired-group source and exclude private, unrelated and unverified groups', async () => {
  const a = session('a'.repeat(32), 'root-a'); a.conversation.target.chatId = 'work'; a.workflowState = 'done';
  const b = session('b'.repeat(32), 'root-b', 'idle'); b.conversation.target.chatId = 'discussion';
  b.workAwareness = { works: [{ status: 'completed', updatedAt: '2026-10-12T10:00:00Z' }] }; b.lastUserMessageAt = '2026-10-12T09:00:00Z';
  b.privateSecret = 'must not appear in projection';
  const privateChat = { ...b, id: 'c'.repeat(32), conversation: { ...b.conversation, target: { ...b.conversation.target, chatType: 'p2p' } } };
  const records = [a, b, privateChat], reads = [];
  const api = createFeishuTopicSource({ details:async entries=>({entries}), sessions: async () => records, session: async id => { reads.push(id); return records.find(s => s.id === id); },
    bindings: async () => ({ bindings: { 'root-a': 'native-a', 'root-b': 'native-b' }, groups: { work: 'native-work', discussion: 'native-discussion' },
      pairs: [{ id: 'pair', name: 'Shared', workChatId: 'work', discussionChatId: 'discussion', workChatName: 'Work', discussionChatName: 'Discussion' }] }) });
  const data = await api.snapshot(['native-a'], '', null, ['native-work']);
  assert.equal(data.entries.length, 1); assert.equal(data.boards.length, 1); assert.equal(data.boards[0].topics.length, 2);
  assert.equal(data.boards[0].topics.find(t => t.sessionId === a.id).state, 'running');
  assert.equal(data.boards[0].topics.find(t => t.sessionId === b.id).state, 'done');
  assert.equal(reads.includes(privateChat.id), false); assert.equal(JSON.stringify(data).includes(b.privateSecret), false);
  assert.equal((await api.snapshot([], '', null, ['unknown-group'])).boards.length, 0);
  const pushed = []; let wake; const next = () => new Promise(resolve => { wake = resolve; });
  const first = next(); const off = await api.subscribe([], data => { pushed.push(data); wake?.(); }, error => { throw error; }, ['native-work']); await first;
  a.activity.run.state = 'idle'; const changed = next(); broadcastAll({ type: 'session_invalidated', sessionId: a.id }); await changed;
  assert.notEqual(pushed.at(-1).boards[0].topics.find(t => t.sessionId === a.id).state, 'running'); off();
});
test('topic details require explicit new confirmation; old and activated grants keep their scope', async () => {
  const input={origin:'http://127.0.0.1:19342',nativeAccount:'1000000000000000001',confirm:true};
  const old=await auth.connectFeishuWebSettings(input,actor,'topics');
  assert.equal((await auth.authorizeFeishuWebSettings(old.token,input.origin,input.nativeAccount,'topics')).topicDetails,false);
  const current=await auth.connectFeishuWebSettings({...input,topicDetails:true},actor,'topics');
  assert.equal((await auth.authorizeFeishuWebSettings(current.token,input.origin,input.nativeAccount,'topics')).topicDetails,true);
  let enriched=0;
  const api=createFeishuTopicSource({sessions:async()=>[],bindings:async()=>({bindings:{}}),details:async entries=>{enriched++;return {entries,quota:{status:'ready'}};}});
  assert.equal((await api.snapshot([], '', null, [], false)).quota,undefined);assert.equal(enriched,0);
  assert.equal((await api.snapshot([], '', null, [], true)).quota.status,'ready');assert.equal(enriched,1);
});

test('read acknowledgement requires new consent and exact verified mapping', async () => {
 const input={origin:'http://127.0.0.1:19342',nativeAccount:'1000000000000000001',confirm:true};
 let grant=await auth.connectFeishuWebSettings(input,actor,'topics'),calls=[];
 async function request(body,account=input.nativeAccount){let output;const req=Readable.from([JSON.stringify(body)]);req.url='/api/feishu-web-topics/review';req.method='POST';req.headers={authorization:'Bearer '+grant.token,'x-feishu-origin':input.origin,'x-feishu-account':account};await handleFeishuWebTopics({req,res:{setHeader(){}},pathname:req.url,writeJson:(_,status,body)=>output={status,body},source:{review:async(...args)=>{calls.push(args);return {reviewed:true}}}});return output;}
 assert.equal((await request({webThreadId:'native-a',resultAt:'2026-10-13T00:00:00Z'})).status,403);assert.equal(calls.length,0);
 grant=await auth.connectFeishuWebSettings({...input,topicReadAck:true},actor,'topics');
 assert.equal((await request({webThreadId:'native-a',resultAt:'2026-10-13T00:00:00Z'})).status,200);
 assert.equal((await request({webThreadId:'native-a',resultAt:'2026-10-13T00:00:00Z'},'1000000000000000002')).status,401);
 const s=session('c'.repeat(32),'root-c','idle');s.lastAssistantMessageAt='2026-10-13T00:00:00Z';
 const api=createFeishuTopicSource({sessions:async()=>[s],session:async()=>s,bindings:async()=>({bindings:{'root-c':'native-c'}}),acknowledge:async(...a)=>a});
 assert.deepEqual(await api.review('native-c',s.lastAssistantMessageAt),[s.id,s.lastAssistantMessageAt]);
 await assert.rejects(api.review('unknown',s.lastAssistantMessageAt));await assert.rejects(api.review('native-c','2026-10-14T00:00:00Z'));
});
test('late read acknowledgements never erase a later result or rewind review',async()=>{
 const {createSession,acknowledgeSessionResult}=await import('../chat/session-manager.mjs');
 const {mutateSessionMeta,loadSessionsMeta}=await import('../chat/session-meta-store.mjs');
 const s=await createSession(scratch,'codex','read race');
 await mutateSessionMeta(s.id,m=>{m.lastAssistantMessageAt='2026-10-13T00:02:00Z';return true;});
 await acknowledgeSessionResult(s.id,'2026-10-13T00:01:00Z');
 let m=(await loadSessionsMeta()).find(x=>x.id===s.id);assert.equal(topicProjection(m,'native').status,'review');
 await acknowledgeSessionResult(s.id,'2026-10-13T00:02:00Z');await acknowledgeSessionResult(s.id,'2026-10-13T00:01:00Z');
 m=(await loadSessionsMeta()).find(x=>x.id===s.id);assert.equal(m.lastReviewedAt,'2026-10-13T00:02:00.000Z');assert.notEqual(topicProjection(m,'native').status,'review');
 await assert.rejects(acknowledgeSessionResult(s.id,'2026-10-13T00:03:00Z'));
});
