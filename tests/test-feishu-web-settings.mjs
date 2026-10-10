import assert from 'node:assert/strict';
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
  const choices = { opening: true, checklist: false, progress: 'card_all', strictStartCheck: true, routing: 'experimental' };
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
