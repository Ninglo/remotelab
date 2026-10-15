import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-execution-plan-'));
setIsolatedTestHome(home);
const dir = join(home, '.config/remotelab');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: '甲', identities: [{ id: 'identity_a', kind: 'feishu', realm: 'bot', subjectId: 'a' }] },
  { id: 'person_b', name: '乙', identities: [{ id: 'identity_b', kind: 'feishu', realm: 'bot', subjectId: 'b' }] },
] }));
const conversation = { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'discussion', tenantKey: 'tenant',
  chatType: 'group', conversationKind: 'thread', messageId: 'root', rootId: 'root', replyInThread: true } };
const second = { ...conversation, target: { ...conversation.target, chatId: 'work' } };
const config = { version: 2, enabled: true, trialId: 'personal-v2', personIds: ['person_a'], crossGroupSync: true,
  groups: ['discussion', 'work', 'misc'].map(chatId => ({ chatId, tenantKey: 'tenant', sourceRouteId: 'bot', folder: home })) };
await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify(config));
await writeFile(join(dir, 'chat-sessions.json'), JSON.stringify([
  { id: 'source', name: '讨论', folder: home, tool: 'fake', conversation },
  { id: 'target', name: '工作', folder: home, tool: 'fake', conversation: second },
]));
try {
  await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
  const { requests } = await import('../chat/requests.mjs');
  const { findSessionMeta, mutateSessionMeta, withSessionsMetaMutation } = await import('../chat/session-meta-store.mjs');
  const { changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
  const { captureMessageRoutingOptions } = await import('../chat/message-routing-policy.mjs');
  const { routingPilotScope, routingSyncTargetAllowed } = await import('../lib/group-routing-pilot.mjs');
  const { routeGroupWork, acceptGroupSync, buildGroupRoutingContext } = await import('../chat/group-routing.mjs');
  const { handleExecutionPlan: act, completeExecutionPlan: finish, recoverExecutionPlans, readExecutionPlans,
    validateExecutionPlanRequest, forwardExecutionQuestions } = await import('../chat/work-execution-plans.mjs');
  const { canForwardNativeRequest } = await import('../chat/native-request-dispatch.mjs');
  const { runDir } = await import('../chat/runs.mjs');
  const base = { viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a', feishuConnectorAuthenticated: true,
    sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatId: 'discussion', chatType: 'group',
      createTime: Date.now().toString(), messageId: 'message', sender: { openId: 'a', senderType: 'user' } },
    sourceDelivery: conversation, messageRoutingPolicy: { version: 1, mechanism: 'experimental', personId: 'person_a', trialVersion: 2, trialId: config.trialId } };
  const input = async (id, text = id, extra = {}) => (await requests.accept({ sessionId: 'source', requestId: id, text,
    options: { ...base, ...extra }, runtimeSelection: { tool: 'fake', model: 'fixture' }, deliveryPlan: conversation })).record;
  let creations = 0, submits = 0, reviews = 0;
  const cancelled = [], origins = new Map();
  const api = {
    async createSession(folder, tool, name, extra) {
      if (origins.has(extra.externalTriggerId)) return findSessionMeta(origins.get(extra.externalTriggerId));
      const id = 'child' + ++creations;
      origins.set(extra.externalTriggerId, id);
      await withSessionsMetaMutation(async (sessions, save) => { sessions.push({ id, folder, tool, name, ...extra }); await save(sessions); });
      return findSessionMeta(id);
    },
    async submitHttpMessage(sessionId, text, images, options) {
      const { record, duplicate } = await requests.accept({ sessionId, requestId: options.requestId, text, options,
        runtimeSelection: { tool: options.tool, model: options.model }, deliveryPlan: options.sourceDelivery });
      if (!duplicate) { submits++; if (options.workPlanReview) reviews++; }
      return { requestId: record.requestId, run: { id: record.runId } };
    },
    async cancelActiveRun(sessionId, options) { cancelled.push([sessionId, options.expectedRunId]); return { state: 'running', cancelRequested: true }; },
  };
  const state = async id => (await findSessionMeta('source')).workAwareness.executionPlans.find(p => p.id === id);
  const branch = (id, dependsOn = []) => ({ id, name: id, task: '只分析已有证据 ' + id, writeScope: '只读', dependsOn });
  const propose = async (id, branches) => {
    const r = await input(id, '请先提出分工，等我选择');
    const { plan } = await act(r, { action: 'propose', goal: id, context: '原讨论已确定只读，不启动新业务；来源原话题。', reason: '独立分析后汇总', branches }, api);
    return { r, plan };
  };
  const approve = async (p, selected = p.branches.map(b => b.id)) => act(await input('approve-' + p.id, '按刚才方案开这些分支'), {
    action: 'approve', planId: p.id, expectedVersion: p.version, selected, approval: '本人明确选择上述原提案分支' }, api);
  const complete = async (p, id, status = 'completed', text = '核查结果与原证据') => {
    const b = (await state(p.id)).branches.find(b => b.id === id);
    const r = await requests.byRequest(b.sessionId, b.requestId);
    await requests.settle(r.key, { state: status, payload: { text }, error: status === 'failed' ? 'fixture failure' : null }, []);
    await finish(await requests.get(r.key), { id: r.runId }, api);
  };

  assert.equal(await routingPilotScope(conversation), null, 'v2 needs the exact person');
  assert.equal(await routingPilotScope(conversation, undefined, 'person_b'), null);
  assert(await routingSyncTargetAllowed(conversation, second, 'person_a'));
  assert.equal(await routingSyncTargetAllowed(conversation, second, 'person_b'), false);
  assert.equal(await routingSyncTargetAllowed(conversation, { ...second, target: { ...second.target, chatId: 'outside' } }, 'person_a'), false);
  await changePersonMessageReplies({ action: 'routing', enabled: true, expectedRevision: 0, confirm: true }, { personId: 'person_a', identityId: 'identity_a' });
  const captured = await captureMessageRoutingOptions(await findSessionMeta('source'), base);
  assert.equal(captured.messageRoutingPolicy.trialVersion, 2);
  const outsider = await captureMessageRoutingOptions(await findSessionMeta('source'), { ...base, viewPersonId: 'person_b', initiatedByIdentityId: 'identity_b' });
  assert.equal(outsider.messageRoutingPolicy.mechanism, 'none');
  assert.match(await buildGroupRoutingContext(await findSessionMeta('source'), base.sourceContext, captured), /讨论已形成结论/);
  const sync = await routeGroupWork(await input('sync', 'A中的结论影响B'), { mode: 'sync', task: '仅复核结论', reason: '同一依据变化', targetSessionId: 'target' }, api);
  await assert.rejects(acceptGroupSync(await input('wrong-human', sync.confirmation, { viewPersonId: 'person_b', initiatedByIdentityId: 'identity_b' }), api));
  await acceptGroupSync(await input('sync-human', sync.confirmation), api);
  assert.equal(submits, 1, 'cross-group reference waits for its real human confirmation');

  // An optional proposal must not own the original task's completion. Work
  // can finish locally while the draft is unanswered; recovery starts nothing.
  const local = await input('local-default', '整理已有资料；可以建议并行，但不要等确认才开工');
  const optional = (await act(local, { action: 'propose', goal: '整理资料', context: '原话题已授权整理',
    reason: '可选并行', branches: [branch('local_a'), branch('local_b')] }, api)).plan;
  const submissionsBeforeLocal = submits;
  await requests.settle(local.key, { state: 'completed', payload: { text: '已在原话题整理完成' } }, []);
  await finish(await requests.get(local.key), { id: local.runId }, api);
  await recoverExecutionPlans(api);
  assert.equal((await requests.get(local.key)).result.state, 'completed');
  assert.equal((await state(optional.id)).state, 'draft');
  assert.equal(submits, submissionsBeforeLocal); assert.equal(creations, 0);
  await act(await input('obsolete-optional', '原任务完成，不再拆分'), { action: 'stop', planId: optional.id,
    expectedVersion: optional.version, selected: ['local_a', 'local_b'], text: '原话题已完成，撤销过期草稿' }, api);
  await assert.rejects(approve(optional), /Proposal changed/);
  assert.equal(creations, 0, 'late approval cannot revive an explicitly withdrawn draft');

  const { r, plan } = await propose('parallel', [branch('a'), branch('b'), branch('c', ['a', 'b'])]);
  assert.equal(creations, 0, 'proposal creates no Session');
  await assert.rejects(act(r, { action: 'approve', planId: plan.id, expectedVersion: 1, selected: ['a'], approval: 'self approval' }, api), /subsequent/);
  await assert.rejects(act(await input('bad-selection'), { action: 'approve', planId: plan.id, expectedVersion: 1, selected: ['c'], approval: 'select c' }, api), /dependencies/);
  await approve(plan);
  assert.equal(creations, 2, 'independent roots start together; dependent branch waits');
  await recoverExecutionPlans(api);
  assert.equal(creations, 2, 'recovery reuses admitted work');
  await complete(plan, 'a'); assert.equal(creations, 2);
  await complete(plan, 'b'); assert.equal(creations, 3);
  await complete(plan, 'c'); assert.equal(reviews, 1);
  await recoverExecutionPlans(api); assert.equal(reviews, 1);
  const review = await requests.byRequest('source', (await state(plan.id)).reviewRequestId);
  assert.equal(review.options.sourceDelivery.target.rootId, 'root', 'result returns to the original discussion');
  assert.equal(canForwardNativeRequest(review, { key: 'active', runtimeSelection: review.runtimeSelection, options: {} }), false, 'review cannot interrupt or answer another pending task');
  await requests.settle(review.key, { state: 'completed', payload: { text: '已核验三个结果及剩余限制' } }, []);
  await finish(await requests.get(review.key), { id: review.runId }, api);
  assert.equal((await state(plan.id)).state, 'reviewed');

  const partial = (await propose('partial', [branch('a'), branch('b')])).plan;
  const before = creations;
  await approve(partial, ['b']); assert.equal(creations, before + 1);
  assert.equal((await state(partial.id)).branches[0].state, 'skipped');
  await complete(partial, 'b', 'failed');
  assert.equal((await state(partial.id)).state, 'reviewing', 'failures are returned rather than called success');

  const depFail = (await propose('failure', [branch('a'), branch('b', ['a'])])).plan;
  await approve(depFail);
  await complete(depFail, 'a', 'completed', '');
  assert.equal((await state(depFail.id)).branches[0].state, 'failed', 'empty final is not a useful result');
  assert.equal((await state(depFail.id)).branches[1].state, 'blocked');

  const control = (await propose('control', [branch('a'), branch('b')])).plan;
  await approve(control);
  let current = await state(control.id), b = current.branches[0];
  const initial = await requests.byRequest(b.sessionId, b.requestId);
  await mkdir(runDir(initial.runId), { recursive: true });
  const question = { id: 'question1', state: 'pending', question: { question: '选哪份已有材料？', options: [{ label: '甲' }, { label: '乙' }] } };
  await writeFile(join(runDir(initial.runId), 'native-question.json'), JSON.stringify(question));
  assert.equal((await readExecutionPlans(await findSessionMeta('source'))).find(p => p.id === control.id).branches[0].runtimeState, 'waiting');
  await forwardExecutionQuestions(initial, [{ messageKind: 'user_question', questionState: 'pending', questionId: question.id, nativeQuestion: question.question }]);
  await act(await input('answer', 'a用甲'), { action: 'answer', planId: control.id, branchId: 'a', questionId: question.id, text: '甲' }, api);
  await assert.rejects(act(await input('old-answer'), { action: 'answer', planId: control.id, branchId: 'a', questionId: 'old', text: '乙' }, api), /Question changed/);
  await act(await input('amend', 'a请补上新的约束'), { action: 'amend', planId: control.id, expectedVersion: current.version, selected: ['a'], text: '只用甲资料，不访问外部服务' }, api);
  await requests.settle(initial.key, { state: 'completed', payload: { text: 'old result' } }, []);
  await finish(await requests.get(initial.key), { id: initial.runId }, api);
  assert.equal((await state(control.id)).branches[0].state, 'running', 'old completion cannot close an amended branch');
  current = await state(control.id);
  const stop = await input('stop', '两个分支都停');
  await act(stop, { action: 'stop', planId: control.id, expectedVersion: current.version, selected: ['a', 'b'], text: '停止两个分支' }, api);
  assert.equal(cancelled.length, 3, 'also cancel an accepted pending answer/correction, not just the latest input');
  b = (await state(control.id)).branches[0];
  await assert.rejects(validateExecutionPlanRequest(await requests.byRequest(b.sessionId, b.requestId)), /no longer active/);
  const reviewBefore = reviews;
  for (const r of await requests.active()) if (!r.result && r.options?.workPlanChild?.planId === control.id
      && r.requestId.startsWith('plan-answer:')) await requests.settle(r.key, { state: 'cancelled', payload: { text: '' } }, []);
  await complete(control, 'a', 'cancelled'); await complete(control, 'b', 'cancelled');
  assert.equal((await state(control.id)).state, 'cancelled'); assert.equal(reviews, reviewBefore, 'whole-plan stop cannot wake the parent');

  const directInput = await input('direct', '按讨论确认的方案，只做资料整理，开始吧');
  const directBody = { action: 'start', goal: '整理资料', context: '讨论原件和约束', reason: '已有明确开工决定', authorization: '原话明确要求开始', branches: [branch('a')] };
  const direct = await act(directInput, directBody, api);
  assert.equal(direct.plan.state, 'running');
  const n = creations; await act(directInput, directBody, api); assert.equal(creations, n);
  await assert.rejects(act(await input('bypass'), { ...directBody, branches: [branch('a'), branch('b')] }, api), /one explicitly/);
  await assert.rejects(act(await input('off', '开工', { messageRoutingPolicy: { version: 1, mechanism: 'none' } }), directBody, api), /disabled/);
  await assert.rejects(act(await input('another-person', '开工', { viewPersonId: 'person_b', initiatedByIdentityId: 'identity_b' }), directBody, api), /outside/);
  await assert.rejects(propose('cycle', [branch('a', ['b']), branch('b', ['a'])]), /no cycles/);
  await mutateSessionMeta('source', s => { s.archived = true; return true; });
  const frozen = creations; await recoverExecutionPlans(api); assert.equal(creations, frozen, 'archived parent cannot be revived by recovery');
  console.log('EXECUTION_PLANS_VERIFIED: personal/group scope, cross-group consent, draft/partial approval, direct authorized work, dependencies, failure, amendment, question relay, cancellation, recovery and source result ownership. No real model or group send.');
} finally { await rm(home, { recursive: true, force: true }); }
