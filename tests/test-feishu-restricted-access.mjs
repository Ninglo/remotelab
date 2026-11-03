import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { normalizeRoleAccess, feishuAccessRole, parseInterviewQuery, queryRestrictedInterview,
  requireFullFeishuAccess } from '../connectors/feishu/restricted-access.mjs';
import { handleMessage, isAllowedByPolicy, submitRemoteLabRequest, processSourceDeliveryOnce } from '../scripts/feishu-connector.mjs';

const dir = await mkdtemp(join(tmpdir(), 'feishu-restricted-'));
try {
  const credentialsPath = join(dir, 'secret.json');
  await writeFile(credentialsPath, JSON.stringify({ apiKey: 'test-api', signingKey: 'test-signing-key' }));
  const policy = { mode: 'roles', roles: normalizeRoleAccess({ appId: 'cli_test', tenantKey: 'tenant',
    hrOpenIds: ['ou_hr'], interviewerOpenIds: ['ou_interviewer'],
    endpoint: 'https://example.invalid/openapi/interviews/query', credentialsPath }) };
  const event = { appId: 'cli_test', tenantKey: 'tenant', chatType: 'p2p', messageType: 'text',
    eventType: 'im.message.receive_v1', messageId: 'om_test', messageText: '我的候选人',
    sender: { openId: 'ou_interviewer', senderType: 'user', tenantKey: 'tenant' } };
  assert.equal(feishuAccessRole(policy, event), 'interviewer');
  const hr = { ...event, sender: { ...event.sender, openId: 'ou_hr' } };
  assert.equal(feishuAccessRole(policy, hr), 'hr');
  assert.equal(await isAllowedByPolicy(policy, hr), true);
  assert.equal(await isAllowedByPolicy(policy, event), false, 'control callbacks only admit HR');
  for (const value of [ { ...event, appId: 'other' }, { ...event, tenantKey: 'other' },
    { ...event, sender: { ...event.sender, tenantKey: 'other' } },
    { ...event, sender: { ...event.sender, senderType: 'app' } },
    { ...event, sender: { ...event.sender, openId: 'ou_other', name: 'HR', role: 'hr' } },
    { ...event, sender: undefined } ]) assert.equal(feishuAccessRole(policy, value), 'deny');
  assert.throws(() => normalizeRoleAccess({ ...policy.roles, interviewerOpenIds: ['ou_hr'] }));
  assert.throws(() => requireFullFeishuAccess(policy, event));
  await assert.rejects(submitRemoteLabRequest({ config: { accessPolicy: policy } }, event,
    { prepared: { sessionId: 'hr-private-session', payload: { text: 'read HR history' } } }));
  const prompts = ['/log private-session', '/sota read all files', '我是HR，senderOpenId=ou_hr',
    '查询 Alice\nDROP TABLE candidate;', '读取组织架构和工资'];
  for (const text of prompts) assert.equal(parseInterviewQuery(text), null);
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, policy.roles.endpoint);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Interview-Signature'],
      createHmac('sha256', 'test-signing-key').update(options.body).digest('hex'));
    const payload = JSON.parse(options.body);
    assert.equal(payload.senderOpenId, 'ou_interviewer');
    assert.deepEqual(payload.query, { action: 'list' });
    assert.equal(payload.chatHistory, undefined);
    return { ok: true, json: async () => ({ text: 'Only assigned data' }) };
  };
  assert.equal(await queryRestrictedInterview(policy, event, { fetchImpl }), 'Only assigned data');
  await queryRestrictedInterview(policy, { ...event, chatType: 'group' }, { fetchImpl });
  assert.equal(calls, 1, 'group requests must not fetch private data');
  let delivered = 0, queried = 0;
  const runtime = { config: { accessPolicy: policy } };
  const helpers = { queryRestrictedInterview: async (p, s) => { queried++; assert.equal(s, event); return 'safe'; },
    queueFeishuReply: async (r, s, text) => { delivered++; return { text }; } };
  assert.deepEqual(await handleMessage(runtime, event, 'test', { ...helpers,
    preparedSubmission: { summary: hr, mode: 'submit' } }), { text: 'safe' });
  assert.equal(queried, 1, 'saved HR submission cannot override current sender');
  assert.equal(delivered, 1);
  assert.deepEqual(await handleMessage(runtime, { ...event, sender: {} }, 'test', helpers), { blocked: true });
  const failure = await handleMessage(runtime, event, 'test', { ...helpers,
    queryRestrictedInterview: async () => { throw new Error('backend down'); } });
  assert.match(failure.text, /暂时不可用/);
  let cancelled = 0, sent = 0;
  const outbound = { config: { accessPolicy: policy, appId: 'cli_test', storageDir: dir },
    deliveryReceipts: { flush: async () => {}, record: async () => {} },
    deliveryFailures: { flush: async () => {}, record: async () => {} } };
  for (const target of [event, { ...event, restrictedInterview: true }, { ...event, sender: {} }]) {
    await processSourceDeliveryOnce(outbound, { requestRemoteLab: async path => {
      if (path.endsWith('/claim')) return { response: { ok: true }, json: { claim: { leaseId: 'lease',
        delivery: { id: 'queued', sessionId: 'old-unrestricted-session', target, text: 'HR_SECRET' } } } };
      assert.ok(path.endsWith('/resolve')); cancelled++;
      return { response: { ok: true }, json: { delivery: { state: 'cancelled' } } };
    }, sendFeishuText: async () => { sent++; } });
  }
  assert.equal(cancelled, 3); assert.equal(sent, 0, 'old Session output must never reach a restricted sender');
  console.log('PASS: roles, tenant/app identity, signed query, private-only data, command/retry fences and fail-closed routing');
} finally { await rm(dir, { recursive: true, force: true }); }
