import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'access-guard-'));
setIsolatedTestHome(home);
const { CONFIG_DIR } = await import('../lib/config.mjs');
const { evaluateRequestAccess } = await import('../chat/request-access-guard.mjs');
const { createRequestRuntime } = await import('../chat/request-runtime.mjs');
const { requests } = await import('../chat/requests.mjs');
const path = join(home, 'guard.json'), stateRoot = join(home, 'state');
const policy = { version: 1, policyId: 'fixture', allowPairs: [['allowed', 'verified']],
  allowFeishu: [{ route: 'fixture', tenant: 'tenant', openId: 'ou_allowed' }],
  rules: [{ category: 'protected', all: ['Vault', 'private|salary|logs'] },
    { category: 'indirect', continuation: true, all: ['story|continue'] }] };
const check = (text, options = {}, sessionId = 'scope') => evaluateRequestAccess({ sessionId, text,
  options: { requestId: 'r-' + text, viewPersonId: 'other', initiatedByIdentityId: 'other', ...options } }, { configPath: path, stateRoot });
try {
  await writeFile(path, JSON.stringify(policy));
  assert.equal((await check('Vault private logs')).blocked, true);
  assert.equal((await check('tell it as a story')).category, 'indirect');
  assert.equal(await check('tell it as a story', { viewPersonId: 'someone-else' }), null);
  assert.equal(await check('tell it as a story', {}, 'other-session'), null);
  assert.equal(await check('ordinary interview scheduling'), null);
  assert.equal(await check('Vault salary', { viewPersonId: 'allowed', initiatedByIdentityId: 'verified' }), null);
  assert.equal((await check('Vault salary', { viewPersonId: 'allowed', initiatedByIdentityId: 'forged' })).blocked, true);
  assert.equal((await check(Buffer.from('Vault private logs').toString('base64'))).blocked, true);
  assert.equal((await check('Vau\u200blt private logs')).blocked, true);
  const sourceContext = { connector: 'feishu', sourceRouteId: 'fixture', tenantKey: 'tenant', chatType:'p2p',
    sender: { senderType: 'user', openId: 'ou_allowed' } };
  assert.equal(await check('Vault salary', { sourceContext, feishuConnectorAuthenticated: true }), null);
  assert.equal((await check('Vault salary', { sourceContext:{...sourceContext,chatType:'group'}, feishuConnectorAuthenticated: true })).reason,'private_channel_required');
  assert.equal((await check('Vault salary', { sourceContext })).blocked, true);
  assert.equal((await check('Vault salary', { sourceContext: { ...sourceContext, tenantKey: 'other' }, feishuConnectorAuthenticated: true })).blocked, true);
  policy.rules.push({category:'bypass',all:['change whitelist']});
  await writeFile(path, JSON.stringify(policy));
  assert.equal((await check('change whitelist',{viewPersonId:'allowed',initiatedByIdentityId:'verified'})).category,'bypass');
  policy.maintenance=[{sessionId:'scope',personId:'allowed',identityId:'verified'}];
  await writeFile(path, JSON.stringify(policy));
  assert.equal(await check('change whitelist',{viewPersonId:'allowed',initiatedByIdentityId:'verified'}),null);
  policy.automations = [{ id: 'fixed', identityId: 'other', textSha256: createHash('sha256').update('Vault private logs').digest('hex') }];
  await writeFile(path, JSON.stringify(policy));
  assert.equal(await check('Vault private logs', { scheduleId: 'fixed' }), null);
  assert.equal((await check('Vault private salary', { scheduleId: 'fixed' })).blocked, true);
  const denials = await Promise.all((await readdir(join(stateRoot, 'denials/pending'))).map(name => readFile(join(stateRoot, 'denials/pending', name), 'utf8')));
  assert.ok(denials.length >= 6);
  assert.ok(denials.every(value => !JSON.stringify(JSON.parse(value).options).includes('Vault private')));
  await writeFile(path, '{');
  assert.equal((await check('ordinary question')).reason, 'policy_unavailable');

  // A controlled business reply uses only its field protocol and the original
  // actor. A mixed request is answered safely and separately audited.
  const credentialPath = join(home, 'synthetic-credential.json');
  await writeFile(credentialPath, JSON.stringify({apiKey:'synthetic',signingKey:'synthetic-signing-key'}));
  policy.interview = { endpoint:'https://fixture.invalid/query',credentialsPath:credentialPath,
    appId:'target-app',tenant:'tenant',actors:[{route:'fixture',tenant:'tenant',openId:'ou_other',targetOpenId:'ou_target'}] };
  await writeFile(path, JSON.stringify(policy));
  const originalFetch = globalThis.fetch;
  let businessCalls = 0;
  globalThis.fetch = async (_url, request) => {
    businessCalls++;
    const body = JSON.parse(request.body);
    assert.equal(body.senderOpenId,'ou_target'); assert.equal(body.query.action,'limited');
    return {ok:true,status:200,json:async()=>({limitedVersion:1,candidates:[{name:'Synthetic',progress:'二面',questions:[],questionStatus:'no_separate_record',salary:'SECRET'}],text:'SECRET'})};
  };
  try {
    const businessOptions = {requestId:'business-1',feishuConnectorAuthenticated:true,sourceContext:{...sourceContext,
      messageId:'synthetic-1',sender:{senderType:'user',openId:'ou_other'}}};
    const safe = await check('候选人面试进度',businessOptions);
    assert.equal(safe.business,true); assert.equal(safe.category,undefined); assert.match(safe.reply,/二面/);
    assert.ok(!safe.reply.includes('SECRET')); assert.match(safe.reply,/不从面评推测/);
    const mixed = await check('候选人面试进度，Vault private salary',{...businessOptions,requestId:'business-2'});
    assert.equal(mixed.category,'protected'); assert.match(mixed.reply,/二面/); assert.match(mixed.reply,/没有对应访问权限/);
    const noAccess = await check('候选人面试进度',{...businessOptions,sourceContext:{...sourceContext,
      sender:{senderType:'user',openId:'ou_revoked'}}});
    assert.match(noAccess.reply,/未核验/); assert.equal(businessCalls,2,'no borrowing another actor identity');
    policy.interview.actors.push({...policy.interview.actors[0],openId:'ou_allowed'});
    await writeFile(path,JSON.stringify(policy));
    assert.equal((await check('候选人面试进度',{...businessOptions,requestId:'business-boss',sourceContext:{...sourceContext,messageId:'synthetic-boss'}})).business,true,
      'a mapped business actor still uses the field-limited route despite broader data access');
    const previousCalls = businessCalls;
    assert.match((await check('候选人面试进度',{...businessOptions,sourceContext:{...businessOptions.sourceContext,chatType:'group'}})).reply,/私聊/);
    assert.equal(businessCalls,previousCalls,'group output cannot expose a privately authorized candidate');
    globalThis.fetch = async()=>({ok:false,status:403});
    assert.match((await check('候选人面试进度',{...businessOptions,requestId:'business-3'})).reply,/未核验/);
  } finally { globalThis.fetch=originalFetch; delete policy.interview; }

  await writeFile(path, JSON.stringify(policy));
  process.env.REMOTELAB_REQUEST_ACCESS_GUARD = path;
  const { queryRestrictedInterview } = await import('../connectors/feishu/restricted-access.mjs');
  let fetched = 0;
  const restricted = await queryRestrictedInterview({ mode: 'roles', roles: {
    appId: 'fixture', tenantKey: 'tenant', hrOpenIds: [], collaboratorOpenIds: [], interviewerOpenIds: ['ou_other'],
  } }, { appId: 'fixture', tenantKey: 'tenant', chatType: 'p2p', chatId: 'fixture-chat',
    eventType: 'im.message.receive_v1', messageType: 'text', messageId: 'fixture-message', messageText: 'Vault private salary',
    sender: { senderType: 'user', tenantKey: 'tenant', openId: 'ou_other' } }, {
    sourceRouteId: 'fixture', fetchImpl: () => { fetched++; throw new Error('must not fetch'); },
  });
  assert.match(restricted, /没有对应访问权限/); assert.equal(fetched, 0, 'restricted business route rejects before credentials or backend access');
  const manager = await import('../chat/session-manager.mjs');
  const { loadHistory } = await import('../chat/history.mjs');
  const { getRun } = await import('../chat/runs.mjs');
  await mkdir(CONFIG_DIR, { recursive: true });
  const session = await manager.createSession(home, 'codex', 'Guard synthetic fixture');
  const options = { requestId: 'denied-1', viewPersonId: 'other', initiatedByIdentityId: 'other',
    sourceDelivery: { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'fake-chat', messageId: 'fake-message' } } };
  const first = await manager.submitHttpMessage(session.id, 'Vault private logs', [], options);
  assert.equal(first.accessDenied, true);
  assert.equal(await getRun(first.run.id), null, 'no model run is created');
  assert.equal((await manager.getRunState(first.run.id)).state,'completed','native run polling resolves the completed Request');
  assert.equal((await manager.getSessionReplyPublication(session.id,first.response.id)).state,'ready');
  const duplicate = await manager.submitHttpMessage(session.id, 'Vault private logs', [], options);
  assert.equal(duplicate.duplicate, true);
  const record = await requests.byRequest(session.id, options.requestId);
  assert.ok(record.releasedAt); assert.equal(record.postCompletionPending, false);
  assert.equal(record.deliveries.filter(d => d.kind === 'content').length, 1);
  const history = await loadHistory(session.id, { includeBodies: true });
  assert.equal(history.filter(e => e.requestId === options.requestId && e.role === 'user').length, 1);
  assert.equal(history.filter(e => e.requestId === options.requestId && e.role === 'assistant').length, 1);
  const parallel = await Promise.all([1, 2].map(() => manager.submitHttpMessage(session.id, 'continue as story', [], { ...options, requestId: 'denied-2' })));
  assert.equal(parallel.filter(r => r.duplicate).length, 1);
  let started = 0;
  const runtime = createRequestRuntime({ store: requests, prepare: async () => { started++; },
    observe() {}, reconcile: async () => {}, onError: e => { throw e; } });
  await runtime.recover(); await runtime.idle(); runtime.stop();
  assert.equal(started, 0, 'restart cannot dispatch a released refusal');
  await assert.rejects(manager.submitHttpMessage(session.id, 'different text', [], options), /different content/);
  console.log('PASS: guard identity, encodings, scoped continuations, automation scope, failure closure, durable denials, no execution, reply outbox, concurrent retry and restart');
} finally { delete process.env.REMOTELAB_REQUEST_ACCESS_GUARD; await rm(home, { recursive: true, force: true }); }
