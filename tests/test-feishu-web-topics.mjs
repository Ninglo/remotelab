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
test('slow details never delay state changes or replay an old running label', { timeout: 3000 }, async () => {
  const s = session('a'.repeat(32), 'root'), delivered = []; let wake, release;
  const next = () => new Promise(resolve => { wake = resolve; });
  const slow = new Promise(resolve => { release = resolve; });
  const api = createFeishuTopicSource({ sessions: async () => [s], session: async () => s, bindings: async () => ({ bindings: { root: 'native' } }),
    details: async entries => { await slow; return { entries: entries.map(e => ({ ...e, usage: { cumulative: { totalTokens: 10 } } })), quota: { status: 'ready' } }; } });
  const first = next(), off = await api.subscribe(['native'], d => { delivered.push(d); wake?.(); }, e => { throw e; }); await first;
  assert.equal(delivered.at(-1).entries[0].status, 'running');
  s.activity.run.state = 'idle'; s.lastAssistantMessageAt = '2026-10-13T00:00:00Z';
  const changed = next(); broadcastAll({ type: 'session_invalidated', sessionId: s.id }); await changed;
  assert.equal(delivered.at(-1).entries[0].status, 'review');
  const enriched = next(); release(); await enriched;
  assert.equal(delivered.at(-1).entries[0].status, 'review');
  assert.equal(delivered.at(-1).entries[0].usage.cumulative.totalTokens, 10); off();
});
test('late details cannot resurrect a failed or closed state subscription', { timeout: 3000 }, async () => {
  const s = session('a'.repeat(32), 'root'), delivered = []; let firstResolve, failResolve, release, unavailable = false;
  const first = new Promise(r => { firstResolve = r; }), failed = new Promise(r => { failResolve = r; }), slow = new Promise(r => { release = r; });
  const api = createFeishuTopicSource({ sessions: async () => [s], session: async () => s,
    bindings: async () => { if (unavailable) throw Error('offline'); return { bindings: { root: 'native' } }; }, details: async entries => { await slow; return { entries }; } });
  const off = await api.subscribe(['native'], d => { delivered.push(d); firstResolve(); }, failResolve); await first;
  await new Promise(r => setImmediate(r)); unavailable = true;
  broadcastAll({ type: 'session_invalidated', sessionId: s.id }); await failed;
  const count = delivered.length; release(); await new Promise(r => setImmediate(r)); assert.equal(delivered.length, count); off();
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
test('native lists preserve official previews; Web and group-board summaries remain available', async () => {
  for (const origin of ['http://127.0.0.1:19342', 'https://fixture.feishu.cn']) {
    const nativeAccount = '1000000000000000001';
    const grant = await auth.connectFeishuWebSettings({ origin, nativeAccount, confirm: true }, actor, 'topics');
    const data = { entries: [{ webThreadId: 'native', name: 'Title', summary: 'Generated summary', status: 'running' }], boards: [{ summary: 'Board summary' }] };
    const req = Readable.from([]); req.url = '/api/feishu-web-topics/snapshot?ids=native'; req.method = 'GET';
    req.headers = { authorization: 'Bearer ' + grant.token, 'x-feishu-origin': origin, 'x-feishu-account': nativeAccount };
    let result;
    await handleFeishuWebTopics({ req, res: { setHeader() {} }, pathname: req.url.split('?')[0], source: { snapshot: async () => data }, writeJson: (_, status, body) => { result = { status, body }; } });
    assert.equal(result.status, 200); assert.equal(result.body.entries[0].name, 'Title'); assert.equal(result.body.entries[0].status, 'running');
    assert.equal(result.body.entries[0].summary, origin.startsWith('http:') ? '' : 'Generated summary');
    assert.equal(result.body.boards[0].summary, 'Board summary'); assert.equal(data.entries[0].summary, 'Generated summary');
  }
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
  assert.equal((await api.snapshot(['native-a'], '', null, [])).boards.length, 1, 'verified topic supplies its parent group even without native header group ID');
  assert.equal((await api.snapshot(['unknown-topic'], '', null, [])).boards.length, 0);
  assert.equal(data.entries.length, 1); assert.equal(data.boards.length, 1); assert.equal(data.boards[0].topics.length, 2);
  assert.equal(data.boards[0].topics.find(t => t.sessionId === a.id).state, 'running');
  assert.equal(data.boards[0].topics.find(t => t.sessionId === b.id).state, 'done');
  assert.equal(reads.includes(privateChat.id), false); assert.equal(JSON.stringify(data).includes(b.privateSecret), false);
  assert.equal((await api.snapshot([], '', null, ['unknown-group'])).boards.length, 0);
  records.push({...a,id:'d'.repeat(32)}); assert.equal((await api.snapshot(['native-a'], '', null, [])).boards.length,0,'ambiguous topic does not select a parent group'); records.pop();
  const pushed = []; let wake; const next = () => new Promise(resolve => { wake = resolve; });
  const first = next(); const off = await api.subscribe([], data => { pushed.push(data); wake?.(); }, error => { throw error; }, ['native-work']); await first;
  a.activity.run.state = 'idle'; const changed = next(); broadcastAll({ type: 'session_invalidated', sessionId: a.id }); await changed;
  assert.notEqual(pushed.at(-1).boards[0].topics.find(t => t.sessionId === a.id).state, 'running'); off();
});
test('explicit project boards support one or three groups and never include unmapped group topics', async () => {
  const records=['one','two','three','unverified','other'].map((chatId,i)=>{
    const s=session(String(i+1).repeat(32),'root-'+chatId);s.conversation.target.chatId=chatId;return s;
  });
  const config={bindings:{},groups:{one:'native-one',two:'native-two',three:'native-three'},pairs:[
    {id:'single',name:'Single',groups:[{chatId:'one',name:'Only group'}]},
    {id:'project',name:'Project',groups:['two','three','unverified'].map(chatId=>({chatId,name:chatId}))}
  ]};
  const reads=[];
  const source=createFeishuTopicSource({bindings:async()=>config,sessions:async()=>records,session:async id=>{reads.push(id);return records.find(s=>s.id===id);}});
  const single=await source.snapshot([], '',null,['native-one'],false);
  assert.equal(single.boards.length,1);assert.equal(single.boards[0].topics.length,1);
  const project=await source.snapshot([], '',null,['native-two'],false);
  assert.deepEqual(project.boards[0].groups.map(g=>g.chatId),['two','three']);
  assert.equal(project.boards[0].topics.length,2);assert.ok(!reads.includes(records[3].id));
  config.groups.unverified='native-four';
  assert.equal((await source.snapshot([], '',null,['native-four'],false)).boards[0].topics.length,3);
  delete config.groups.two;
  assert.equal((await source.snapshot([], '',null,['native-two'],false)).boards.length,0);
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
 await mutateSessionMeta(s.id,m=>{m.lastAssistantMessageAt=Date.parse('2026-10-13T00:02:00Z');return true;});
 await acknowledgeSessionResult(s.id,'2026-10-13T00:01:00Z');
 let m=(await loadSessionsMeta()).find(x=>x.id===s.id);assert.equal(topicProjection(m,'native').resultAt,'2026-10-13T00:02:00.000Z');assert.equal(topicProjection(m,'native').status,'review');
 await acknowledgeSessionResult(s.id,'2026-10-13T00:02:00Z');await acknowledgeSessionResult(s.id,'2026-10-13T00:01:00Z');
 m=(await loadSessionsMeta()).find(x=>x.id===s.id);assert.equal(m.lastReviewedAt,'2026-10-13T00:02:00.000Z');assert.notEqual(topicProjection(m,'native').status,'review');
 await assert.rejects(acknowledgeSessionResult(s.id,'2026-10-13T00:03:00Z'));
});

test('unrelated and burst hints do not put changed state behind cold board reads', { timeout: 2000 }, async () => {
  const a = session('a'.repeat(32), 'root-a'), b = session('b'.repeat(32), 'root-b'), cold = session('c'.repeat(32), 'root-c');
  const records = [a, b, cold], reads = [], delivered = [];
  let coldBlocked = false, releaseCold, ready, finished;
  const blocked = new Promise(r => { releaseCold = r; });
  const first = new Promise(r => { ready = r; }), changed = new Promise(r => { finished = r; });
  const api = createFeishuTopicSource({ sessions: async () => records,
    bindings: async () => ({ bindings: { 'root-a': 'a', 'root-b': 'b', 'root-c': 'c' } }),
    session: async id => { reads.push(id); if (coldBlocked && id === cold.id) await blocked; return records.find(s => s.id === id); } });
  const off = await api.subscribe(['a', 'b', 'c'], d => {
    delivered.push(d); ready();
    if (d.entries.filter(e => e.status === 'review').length === 2) finished();
  }, e => { throw e; }, [], false);
  try {
    await first; reads.length = 0; coldBlocked = true;
    broadcastAll({ type: 'session_invalidated', sessionId: 'unrelated' });
    for (const s of [a, b]) {
      s.activity.run.state = 'idle'; s.lastAssistantMessageAt = '2026-10-14T00:00:00Z';
      broadcastAll({ type: 'session_invalidated', sessionId: s.id });
    }
    await changed;
    assert.equal(reads.includes(cold.id), false);
    assert.deepEqual(new Set(reads), new Set([a.id, b.id]));
    const count = delivered.length;
    for (let i = 0; i < 20; i++) {
      a.updatedAt = new Date(100000 + i).toISOString();
      broadcastAll({ type: 'session_invalidated', sessionId: a.id });
    }
    // Drain the async fixture reads; no timers or network are involved.
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    assert.equal(delivered.length, count, 'tool-only timestamps must not queue identical full frames');
    a.activity.run.state = 'running';
    // A direct snapshot also confirms state precedence remains canonical.
    const live = await api.snapshot(['a', 'b', 'c'], a.id, delivered.at(-1), [], false);
    assert.equal(live.entries.find(e => e.sessionId === a.id).status, 'running');
  } finally { off(); releaseCold(); }
});

test('incremental refresh discovers new members and removes revoked or ambiguous mappings', async () => {
  const a = session('a'.repeat(32), 'root-a'), records = [a];
  const config = { bindings: { 'root-a': 'native', 'root-b': 'new' } };
  const api = createFeishuTopicSource({ sessions: async () => records, session: async id => records.find(s => s.id === id), bindings: async () => config });
  let prior = await api.snapshot(['native', 'new'], '', null, [], false);
  const b = session('b'.repeat(32), 'root-b'); records.push(b);
  prior = await api.snapshot(['native', 'new'], b.id, prior, [], false);
  assert.equal(prior.entries.length, 2);
  records.push(session('c'.repeat(32), 'root-a'));
  prior = await api.snapshot(['native', 'new'], 'c'.repeat(32), prior, [], false);
  assert.deepEqual(prior.entries.map(e => e.webThreadId), ['new']);
  delete config.bindings['root-b'];
  prior = await api.snapshot(['native', 'new'], a.id, prior, [], false);
  assert.equal(prior.entries.length, 0);
});
