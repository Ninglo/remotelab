import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-web-settings-'));
setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { updateAuthDocument } = await import('../lib/auth-config.mjs');
const { loadPersonMessageReplies } = await import('../chat/person-message-replies.mjs');
const api = await import('../chat/feishu-web-settings.mjs');
const { handleFeishuWebSettings } = await import('../chat/router-feishu-web-settings.mjs');
await updateAuthDocument(document => {
  document.people = ['alice', 'bob'].map(name => ({ id: 'person_' + name, name, credentials: [], preferences: { keep: name },
    identities: [{ id: 'web_' + name, kind: 'web', realm: 'remotelab', subjectId: name }] }));
  document.primaryPersonId = 'person_alice';
});
const actor = name => ({ personId: 'person_' + name, identityId: 'web_' + name });
const origin = 'https://fixture.feishu.cn', nativeAccount = '1000000000000000001';
const connect = { origin, nativeAccount, confirm: true };

test('connection verifies login, limits scope, survives reload, and never activates preferences', async () => {
  for (const identity of [{}, { ...actor('alice'), identityId: 'web_bob' }, { ...actor('alice'), authKind: 'service' }]) {
    await assert.rejects(api.connectFeishuWebSettings(connect, identity), /本人/);
  }
  await assert.rejects(api.connectFeishuWebSettings({ ...connect, confirm: false }, actor('alice')), /明确/);
  await assert.rejects(api.connectFeishuWebSettings({ ...connect, origin: 'https://feishu.cn.evil.test' }, actor('alice')), /飞书/);
  const grant = await api.connectFeishuWebSettings(connect, actor('alice'));
  assert.equal((await loadPersonMessageReplies(actor('alice'))).active, null);
  const verified = await api.authorizeFeishuWebSettings(grant.token, origin, nativeAccount);
  assert.equal(verified.personId, 'person_alice');
  for (const [token, site, account] of [[grant.token, 'https://other.feishu.cn', nativeAccount], [grant.token, origin, '1000000000000000002'], ['owner-secret', origin, nativeAccount]]) {
    await assert.rejects(api.authorizeFeishuWebSettings(token, site, account), /连接/);
  }
  const disk = await readFile(join(home, '.config/remotelab/feishu-web-settings-connections.json'), 'utf8');
  assert(!disk.includes(grant.token), 'only token hashes reach the server store');
  const second = await api.connectFeishuWebSettings(connect, actor('alice'));
  await assert.rejects(api.authorizeFeishuWebSettings(grant.token, origin, nativeAccount), /失效/);
  const active = await api.authorizeFeishuWebSettings(second.token, origin, nativeAccount);
  const before = await api.loadFeishuWebReplies(active);
  const choices = { opening: true, checklist: false, progress: 'card_all', strictStartCheck: true, routing: 'experimental', selfReview: false };
  await api.saveFeishuWebReplies({ action: 'apply', confirm: true, expectedRevision: before.revision, choices }, active);
  assert.deepEqual((await loadPersonMessageReplies(actor('alice'))).choices, choices, 'same personal settings as the ordinary Web route');
  assert.equal((await loadPersonMessageReplies(actor('bob'))).active, null, 'other people keep their own settings');
  await assert.rejects(api.saveFeishuWebReplies({ action: 'apply', confirm: true, expectedRevision: before.revision, choices }, active), /已更新/);
  await api.disconnectFeishuWebSettings(active);
  await assert.rejects(api.authorizeFeishuWebSettings(second.token, origin, nativeAccount), /失效/);
  const third = await api.connectFeishuWebSettings(connect, actor('alice'));
  const doc = JSON.parse(await readFile(join(home, '.config/remotelab/feishu-web-settings-connections.json'), 'utf8'));
  doc.connections[0].expiresAt = 1;
  await writeFile(join(home, '.config/remotelab/feishu-web-settings-connections.json'), JSON.stringify(doc));
  await assert.rejects(api.authorizeFeishuWebSettings(third.token, origin, nativeAccount), /失效/);
});

test('narrow routes do not accept cookie/service credentials, preserve CORS and require the connected account', async () => {
  const grant = await api.connectFeishuWebSettings(connect, actor('alice'));
  const call = async (method, path, headers = {}, body = '') => {
    let status, value; const responseHeaders = {};
    const req = { url: path, method, headers, async *[Symbol.asyncIterator]() { yield body; } };
    const res = { setHeader(k, v) { responseHeaders[k] = v; }, writeHead(code) { status = code; }, end() {} };
    await handleFeishuWebSettings({ req, res, pathname: path.split('?')[0], nonce: 'test',
      writeJson(_res, code, result) { status = code; value = result; } });
    return { status, value, responseHeaders };
  };
  assert.equal((await call('GET', '/api/feishu-web-settings/replies')).status, 401);
  const headers = { authorization: 'Bearer ' + grant.token, origin, 'x-feishu-account': nativeAccount };
  const read = await call('GET', '/api/feishu-web-settings/replies', headers);
  assert.equal(read.status, 200); assert.equal(read.value.person.id, 'person_alice');
  assert.equal(read.responseHeaders['Access-Control-Allow-Origin'], origin);
  assert.equal((await call('GET', '/api/feishu-web-settings/files', headers)).status, 404);
  assert.equal((await call('OPTIONS', '/api/feishu-web-settings/replies', { origin })).status, 204);
  assert.equal((await call('OPTIONS', '/api/feishu-web-settings/replies', { origin: 'https://evil.test' })).status, 400);
});

test('runtime limits changes to bound Feishu sessions, validates catalog, rejects conflicts under the metadata lock', async () => {
  const { createSession, getSession, updateSessionRuntimePreferences } = await import('../chat/session-manager.mjs');
  const { updateSessionConversation } = await import('../chat/session-conversations.mjs');
  const session = await createSession(home, 'codex', 'fixture', { model: 'gpt-6.1-sol', effort: 'high' });
  const deps = { getSession, updateRuntime: updateSessionRuntimePreferences, getModels: async () => ({ defaultModel: 'gpt-6.1-sol',
    models: ['gpt-6.1-sol', 'gpt-6-astra'].map(id => ({ id, reasoning: { kind: 'enum', levels: ['high', 'xhigh'], default: 'high' } })) }) };
  await assert.rejects(api.readFeishuWebRuntime(session.id, deps), /飞书/);
  await updateSessionConversation(session.id, { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'oc_fixture', chatType: 'group', conversationKind: 'main' } });
  const before = await api.readFeishuWebRuntime(session.id, deps);
  const input = { sessionId: session.id, expectedRevision: before.revision, model: 'gpt-6-astra', effort: 'xhigh', confirm: true };
  await assert.rejects(api.saveFeishuWebRuntime({ ...input, model: 'unknown' }, deps), /不可选/);
  await assert.rejects(api.saveFeishuWebRuntime({ ...input, effort: 'ultra' }, deps), /思考/);
  const saved = await api.saveFeishuWebRuntime(input, deps);
  assert.equal(saved.model, 'gpt-6-astra'); assert.equal(saved.effort, 'xhigh');
  await assert.rejects(api.saveFeishuWebRuntime(input, deps), /已更新/);
  const stale = await api.readFeishuWebRuntime(session.id, deps);
  const racing = { ...deps, updateRuntime: async (id, patch, options) => {
    await updateSessionRuntimePreferences(id, { effort: 'high' });
    return updateSessionRuntimePreferences(id, patch, options);
  } };
  await assert.rejects(api.saveFeishuWebRuntime({ ...input, expectedRevision: stale.revision, model: 'gpt-6.1-sol' }, racing), /已更新/);
  assert.equal((await getSession(session.id)).model, 'gpt-6-astra', 'late writes cannot overwrite a newer selection');
});

test('native loopback grants stay bound to the exact helper origin, account and capability', async () => {
  const nativeOrigin='http://127.0.0.1:19342';
  assert.equal(api.feishuOrigin(nativeOrigin),nativeOrigin);
  for(const bad of ['null','http://localhost:19342','http://127.0.0.1:19343','http://127.0.0.1:19342/','http://192.168.1.1:19342']) assert.throws(()=>api.feishuOrigin(bad));
  // Deliberately invalid fixture userinfo, constructed to avoid a secret-like literal.
  const credentialUrl = new URL('http://127.0.0.1:19342'); credentialUrl.username = 'fixture'; credentialUrl.password = 'fixture';
  assert.throws(() => api.feishuOrigin(credentialUrl.href.slice(0, -1)));

  const grant=await api.connectFeishuWebSettings({origin:nativeOrigin,nativeAccount,confirm:true},actor('alice'));
  assert.equal((await api.authorizeFeishuWebSettings(grant.token,nativeOrigin,nativeAccount)).personId,'person_alice');
  await assert.rejects(api.authorizeFeishuWebSettings(grant.token,origin,nativeAccount));
  await assert.rejects(api.authorizeFeishuWebSettings(grant.token,nativeOrigin,'1000000000000000002'));
  await assert.rejects(api.authorizeFeishuWebSettings(grant.token,nativeOrigin,nativeAccount,'workspace'));
  await assert.rejects(api.connectFeishuWebSettings({origin:nativeOrigin,nativeAccount,confirm:false},actor('alice')));
});

test('native confirmation atomically connects all scoped capabilities without changing preferences',async()=>{
 const input={origin:'http://127.0.0.1:19342',nativeAccount:'1000000000000000077',confirm:true};
 for(const bad of [{...input,confirm:false},{...input,origin:'https://fixture.feishu.cn'},{...input,unexpected:true}])await assert.rejects(api.connectFeishuNative(bad,actor('alice')));
 await assert.rejects(api.connectFeishuNative(input,{...actor('alice'),authKind:'service'}));
 const result=await api.connectFeishuNative(input,actor('alice'));
 assert.deepEqual(Object.keys(result.grants),['settings','workspace','topics']);
 for(const [kind,g]of Object.entries(result.grants)){
  const a=await api.authorizeFeishuWebSettings(g.token,input.origin,input.nativeAccount,kind);assert.equal(a.personId,'person_alice');assert.equal(a.topicReadAck,kind==='topics');
  await assert.rejects(api.authorizeFeishuWebSettings(g.token,input.origin,'1000000000000000078',kind));
 }
 const disk=await readFile(join(home,'.config/remotelab/feishu-web-settings-connections.json'),'utf8');for(const g of Object.values(result.grants))assert(!disk.includes(g.token));
 const {createRequire}=await import('node:module');const connection=createRequire(import.meta.url)('../scripts/feishu-native/native-connection.cjs');
 const p={state:'a'.repeat(32),account:input.nativeAccount};
 const callback={...result,type:'remotelab:feishu-native-connected',state:p.state};const values=connection.validateBundle(callback,p);
 assert(connection.reusable(values,p.account));assert.equal(connection.reusable(values,'1000000000000000099'),null);
 for(const bad of [{...callback,state:'wrong'},{...callback,grants:{...result.grants,topics:{...result.grants.topics,topicReadAck:false}}},{...callback,grants:{...result.grants,workspace:{...result.grants.workspace,person:{id:'person_bob'}}}}])assert.throws(()=>connection.validateBundle(bad,p));
 values[connection.key('topics',p.account)].expiresAt=0;assert.equal(connection.reusable(values,p.account),null);
});

test('native connection page uses one same-tab round trip and fixed local callback',async()=>{
 const base='http://127.0.0.1:19342',state='b'.repeat(32),returnKey='c'.repeat(32);
 const url='/page/feishu-web-settings/connect?bundle=native&origin='+encodeURIComponent(base)+'&account=1000000000000000079&state='+state+'&returnKey='+returnKey;
 let html='',status;
 await handleFeishuWebSettings({req:{url,method:'GET',headers:{}},res:{setHeader(){},end(v){html=v;}},pathname:url.split('?')[0],authSession:{...actor('alice'),personName:'Alice'},nonce:'test',writeJson:(_,s)=>status=s});
 assert(html.includes('确认并连接全部功能'));assert(html.includes('location.replace('));assert(!html.includes('window.open('));assert(!html.includes('window.opener'));assert(html.includes("'/pair/return?key='"));
 const path='/api/feishu-web-settings/native-grant',body=JSON.stringify({origin:base,nativeAccount:'1000000000000000079',confirm:true});let result;
 const request=async headers=>{const req=Object.assign(Readable.from([body]),{url:path,method:'POST',headers});await handleFeishuWebSettings({req,res:{setHeader(){}},pathname:path,authSession:actor('alice'),writeJson:(_,s,v)=>{status=s;result=v;}});};
 await request({origin:'https://evil.test',host:'fixture.test'});assert.equal(status,403);
 await request({origin:'https://fixture.test',host:'fixture.test'});assert.equal(status,201,JSON.stringify(result));assert.equal(Object.keys(result.grants).length,3);
});
