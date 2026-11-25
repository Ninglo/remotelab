import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
import { isHrCollaborationQuery } from '../chat/hr-collaboration.mjs';

const declaration = '应聘类型实习，应聘岗位数据算法工程师';
for (const text of [
  declaration,
  '应聘岗位：数据算法工程师，实习',
  '岗位是数据算法工程师',
  '岗位名称：数据算法工程师',
  '岗位方向为数据，用工类型实习',
  '应聘岗位：数据算法工程师，可以继续吗？',
  '安排数据实习一面',
  '帮候选人查询岗位后入库',
  '继续办理',
]) assert.equal(isHrCollaborationQuery(text), false, text);
for (const text of [
  '查询在招岗位', '有哪些应聘岗位？', '应聘岗位有什么要求', '应聘岗位是哪个',
  '查看招聘优先级', 'SOP操作说明', '这个岗位是什么', '应聘岗位具体要求？', '应聘岗位要填什么？', '应聘岗位？',
]) assert.equal(isHrCollaborationQuery(text), true, text);

const root = await mkdtemp(join(tmpdir(), 'hr-collaboration-declarations-'));
setIsolatedTestHome(root);
const originalFetch = globalThis.fetch;
try {
  const credentialsPath = join(root, 'credentials.json');
  const guardPath = join(root, 'guard.json');
  const hrPolicyPath = join(root, 'policy.json');
  const appId = 'fixture-app';
  const tenantKey = 'fixture-tenant';
  const sourceRouteId = 'muka-hr';
  const endpoint = 'https://fixture.invalid';
  const subject = (id, roles, userId) => ({
    id, roles, userId, openId: `ou_${id}`, active: true, bindings: [
      { kind: 'feishu', route: sourceRouteId, appId, tenant: tenantKey, openId: `ou_${id}` },
    ],
  });
  await writeFile(credentialsPath, JSON.stringify({ apiKey: 'fixture', signingKey: 'fixture' }));
  await writeFile(guardPath, JSON.stringify({ version: 2, policyId: 'fixture', allowPairs: [],
    rules: [{ id: 'fixture-rule', category: 'protected', all: ['内部薪资'] }],
    hrPolicyPath, hrInstance: 'hr', hrRestrictedRuntime: true,
    collaboration: { endpoint, credentialsPath, appId, tenant: tenantKey } }));
  await writeFile(hrPolicyPath, JSON.stringify({ schema: 1, version: 'fixture-v1', roles: {
    recruiting: { 'jobs.read': 'shared', 'candidate.read': 'owned', 'candidate.write': 'owned' },
    interviewer: { 'candidate.read': 'assigned' },
  }, subjects: [subject('recruiter', ['recruiting'], 'owner'),
    subject('dual', ['recruiting', 'interviewer'], 'other-owner'),
    subject('catalog', ['recruiting'])] }));
  process.env.REMOTELAB_REQUEST_ACCESS_GUARD = guardPath;

  const { handleMessage } = await import('../scripts/feishu-connector.mjs');
  const { queryRestrictedInterview } = await import('../connectors/feishu/restricted-access.mjs');
  const recruitingWorkflowCommand = ['/fixed/workflow'];
  const runtime = { config: { sourceRouteId, storageDir: root, accessPolicy: { mode: 'roles', roles: {
    hrPolicy: true, appId, tenantKey, endpoint, credentialsPath, recruitingWorkflowCommand,
  } } } };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, endpoint);
    const { query, senderOpenId, subjectId } = JSON.parse(options.body);
    assert.equal(senderOpenId, `ou_${subjectId}`);
    calls.push(['service', subjectId, query.action]);
    assert.equal(query.action, 'jobs');
    return Response.json({ jobsVersion: 1, jobs: [{ role: '测试岗位', active: true }], guide: '测试 SOP' });
  };
  const helpers = {
    queryRestrictedInterview: (policy, summary, options) => queryRestrictedInterview(policy, summary, {
      ...options,
      workflowImpl: async (command, input) => {
        assert.deepEqual(command, recruitingWorkflowCommand);
        calls.push(['workflow', input.sender.openId, input.messageText]);
        return { handled: true, text: '已接续原招聘办理' };
      },
    }),
    queueFeishuReply: async (_runtime, summary, text) => {
      assert.equal(summary.restrictedInterview, true);
      return text;
    },
    submitRemoteLabRequest: async () => assert.fail('Restricted sender reached the general executor'),
  };
  let sequence = 0;
  const send = (sender, messageText) => handleMessage(runtime, {
    appId, tenantKey, messageText, chatId: `chat-${sender}`, chatType: 'p2p',
    messageType: 'text', eventType: 'im.message.receive_v1', messageId: `fixture-${++sequence}`,
    sender: { openId: `ou_${sender}`, senderType: 'user', tenantKey },
  }, 'im.message.receive_v1', helpers);

  assert.equal(await send('recruiter', declaration), '已接续原招聘办理');
  assert.equal(await send('dual', declaration), '已接续原招聘办理');
  assert.match(await send('recruiter', '查询在招岗位'), /测试岗位/u);
  assert.equal(await send('dual', 'SOP 操作说明'), '测试 SOP');
  assert.match(await send('catalog', declaration), /测试岗位/u);
  assert.deepEqual(await send('unregistered', declaration), { blocked: true });
  assert.deepEqual(calls, [
    ['workflow', 'ou_recruiter', declaration], ['workflow', 'ou_dual', declaration],
    ['service', 'recruiter', 'jobs'], ['service', 'dual', 'jobs'], ['service', 'catalog', 'jobs'],
  ]);
  console.log('PASS: recruiting field replies reach the fixed Feishu workflow; catalog and SOP reads stay scoped');
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.REMOTELAB_REQUEST_ACCESS_GUARD;
  await rm(root, { recursive: true, force: true });
}
