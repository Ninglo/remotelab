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
  const { listSourceDeliveries, claimSourceDelivery, completeSourceDelivery, failSourceDelivery, resolveSourceDelivery, getSourceDelivery } = await import('../chat/source-deliveries.mjs');
  const deliveredNotices = new Map();
  const admissionDeliveries = async () => [...new Map([...(await listSourceDeliveries({ sessionId: 'source' })), ...deliveredNotices.values()]
    .filter(d => d.responseId?.startsWith('plan-admission:')).map(d => [d.id, d])).values()];
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
  const deliver = async (deliveryApi = api) => {
    for (let i = 0; i < 100; i++) {
      const claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' });
      if (!claim) return;
      const { delivery: d, leaseId } = claim;
      if (d.responseId?.startsWith('plan-admission:')) deliveredNotices.set(d.id, d);
      await completeSourceDelivery(d.id, leaseId, { messageId: 'om_' + d.sessionId,
        threadId: 'omt_' + d.sessionId }, deliveryApi);
    }
    throw new Error('Delivery fixture did not settle');
  };
  const state = async id => (await findSessionMeta('source')).workAwareness.executionPlans.find(p => p.id === id);
  const branch = (id, dependsOn = []) => ({ id, name: id, task: '只分析已有证据 ' + id, writeScope: '只读', dependsOn });
  const propose = async (id, branches) => {
    const r = await input(id, '请先提出分工，等我选择');
    const { plan } = await act(r, { action: 'propose', goal: id, context: '原讨论已确定只读，不启动新业务；来源原话题。', reason: '独立分析后汇总', branches }, api);
    return { r, plan };
  };
  const approve = async (p, selected = p.branches.map(b => b.id)) => { const result = await act(await input('approve-' + p.id, '按刚才方案开这些分支'), {
    action: 'approve', planId: p.id, expectedVersion: p.version, selected, approval: '本人明确选择上述原提案分支' }, api); await deliver(); return result; };
  const complete = async (p, id, status = 'completed', text = '核查结果与原证据') => {
    const b = (await state(p.id)).branches.find(b => b.id === id);
    const r = await requests.byRequest(b.sessionId, b.requestId);
    await requests.settle(r.key, { state: status, payload: { text }, error: status === 'failed' ? 'fixture failure' : null }, []);
    await finish(await requests.get(r.key), { id: r.runId }, api); await deliver();
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
  const notices = await admissionDeliveries();
  assert.equal(notices.length, 2, 'each actual topic receipt makes its branch available');
  assert.deepEqual(notices[0].target, conversation.target, 'receipt returns to the original topic');
  assert.match(notices[0].text, /只分析已有证据 a/);
  assert.match(notices[0].text, /open_thread_id=omt_child1/);
  assert.match(notices[1].text, /open_thread_id=omt_child2/);
  assert.doesNotMatch(notices[0].text, /session=child3/, 'blocked dependency is not announced as created');
  // Simulate a crash after durable enqueue but before saving the receipt ID.
  await mutateSessionMeta('source', draft => {
    delete draft.workAwareness.executionPlans.find(p => p.id === plan.id).admissionNotices[0].deliveryId;
    return true;
  });
  await recoverExecutionPlans(api);
  assert.equal(creations, 2, 'recovery reuses admitted work');
  assert.equal((await admissionDeliveries()).length, 2, 'recovery cannot duplicate the saved launch receipt');
  await complete(plan, 'a'); assert.equal(creations, 2);
  await complete(plan, 'b'); assert.equal(creations, 3);
  assert.equal((await admissionDeliveries()).length, 3, 'dependent child gets its link only after actual admission');
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
  assert.equal(direct.plan.branches[0].state, 'pending');
  const child = await findSessionMeta(direct.plan.branches[0].sessionId);
  assert.equal(child.sourceId, 'feishu');
  assert.equal(child.conversation.target.chatId, 'discussion');
  assert.equal(child.conversation.target.messageId, undefined, 'parent topic anchor is not inherited');
  assert.equal(await requests.byRequest(child.id, direct.plan.branches[0].requestId), null, 'no execution before real topic receipt');
  await deliver();
  const bound = await findSessionMeta(child.id);
  assert.equal(bound.conversation.target.threadId, 'omt_' + child.id);
  const { findSessionConversation } = await import('../chat/session-conversations.mjs');
  assert.equal((await findSessionConversation(bound.conversation)).id, child.id, 'human follow-up resolves to this child, not a second Session');
  const childRequest = await requests.byRequest(child.id, direct.plan.branches[0].requestId);
  assert.equal(childRequest.options.suppressSourceDelivery, false);
  assert.equal(childRequest.deliveryPlan.target.rootId, bound.conversation.target.rootId);
  assert.equal((await state(direct.plan.id)).state, 'running');
  const n = creations; await act(directInput, directBody, api); assert.equal(creations, n);
  await assert.rejects(act(await input('bypass'), { ...directBody, branches: [branch('a'), branch('b')] }, api), /executionMode parallel-sessions/);
  const explicit = await act(await input('explicit-parallel', '这三项分别开子Session并行处理'), {
    ...directBody, executionMode: 'parallel-sessions', authorization: '本人明确要求三个具体分工开子Session并行',
    branches: [branch('pool'), branch('resources'), branch('oracle')],
  }, api);
  await deliver();
  explicit.plan = await state(explicit.plan.id);
  assert.equal(explicit.plan.state, 'running');
  assert.equal(explicit.plan.branches.length, 3);
  assert.equal(new Set(explicit.plan.branches.map(b => b.sessionId)).size, 3);
  assert(explicit.plan.branches.every(b => b.state === 'running' && b.sessionUrl));
  assert.deepEqual(explicit.plan.selected, ['pool', 'resources', 'oracle']);
  await assert.rejects(act(await input('off', '开工', { messageRoutingPolicy: { version: 1, mechanism: 'none' } }), directBody, api), /disabled/);
  await assert.rejects(act(await input('another-person', '开工', { viewPersonId: 'person_b', initiatedByIdentityId: 'identity_b' }), directBody, api), /outside/);
  await assert.rejects(propose('cycle', [branch('a', ['b']), branch('b', ['a'])]), /no cycles/);
  await deliver();
  const delayed = await act(await input('delayed-topic'), { ...directBody, goal: '等待真实话题回执' }, api);
  const pending = delayed.plan.branches[0];
  await act(await input('amend-pending-topic'), { action: 'amend', planId: delayed.plan.id,
    expectedVersion: delayed.plan.version, selected: ['a'], text: '补充：仅使用已有原文' }, api);
  assert.equal(await requests.byRequest(pending.sessionId, pending.requestId), null, 'an amendment cannot bypass topic admission');
  const claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' });
  assert.equal(claim.delivery.id, pending.topicDeliveryId);
  await assert.rejects(completeSourceDelivery(claim.delivery.id, claim.leaseId, {}, api), /actual messageId/);
  await failSourceDelivery(claim.delivery.id, claim.leaseId, new Error('connection lost'));
  assert.equal((await state(delayed.plan.id)).branches[0].state, 'pending');
  assert.equal(await requests.byRequest(pending.sessionId, pending.requestId), null);
  const issues = await listSourceDeliveries({ sessionId: 'source' });
  assert(issues.some(d => d.responseId?.startsWith('plan-topic-issue:') && d.text.includes('尚未启动')));
  await recoverExecutionPlans(api);
  assert.equal(await requests.byRequest(pending.sessionId, pending.requestId), null, 'unknown send cannot fall back to Web');
  // A late successful provider receipt recovers the same branch; duplicate
  // acknowledgements do not start a second execution or create another topic.
  const countBeforeReceipt = creations;
  const ack = { messageId: 'om_late', threadId: 'omt_late' };
  await completeSourceDelivery(claim.delivery.id, claim.leaseId, ack, api);
  const submitsAfterReceipt = submits;
  await completeSourceDelivery(claim.delivery.id, claim.leaseId, ack, api);
  assert.match((await requests.byRequest(pending.sessionId, pending.requestId)).text, /补充：仅使用已有原文/);
  assert.equal(submits, submitsAfterReceipt);
  assert.equal(creations, countBeforeReceipt);
  assert.equal((await state(delayed.plan.id)).branches[0].state, 'running');
  await deliver();

  const failed = await act(await input('failed-topic'), { ...directBody, goal: '核实后恢复投递' }, api);
  const failedClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' });
  await failSourceDelivery(failedClaim.delivery.id, failedClaim.leaseId, new Error('provider rejection'), { definiteFailure: true });
  assert.equal(await requests.byRequest(failed.plan.branches[0].sessionId, failed.plan.branches[0].requestId), null);
  await resolveSourceDelivery(failedClaim.delivery.id, { state: 'delivered', messageId: 'om_verified', threadId: 'omt_verified' }, api);
  assert.equal((await state(failed.plan.id)).branches[0].state, 'running');
  await deliver();

  const stopped = await act(await input('stop-before-topic'), { ...directBody, goal: '投递前停止' }, api);
  const stoppedBranch = stopped.plan.branches[0];
  await act(await input('stop-pending-topic', '取消尚未投递的分支'), { action: 'stop', planId: stopped.plan.id,
    expectedVersion: stopped.plan.version, selected: ['a'], text: '取消分支' }, api);
  assert.equal((await getSourceDelivery(stoppedBranch.topicDeliveryId)).state, 'cancelled');
  await recoverExecutionPlans(api);
  assert.equal(await requests.byRequest(stoppedBranch.sessionId, stoppedBranch.requestId), null);

  const noThread = await act(await input('message-only-topic'), { ...directBody, goal: '只有真实消息 ID' }, api);
  const messageClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' });
  await completeSourceDelivery(messageClaim.delivery.id, messageClaim.leaseId, { messageId: 'om_only' }, api);
  const noThreadState = await state(noThread.plan.id);
  assert.equal(noThreadState.branches[0].state, 'running');
  assert.match(noThreadState.admissionNotices[0].text, /飞书尚未返回话题链接/);
  assert.doesNotMatch(noThreadState.admissionNotices[0].text, /session=|open_thread_id=om_only/);

  const legacy = (await propose('legacy-web-plan', [branch('a')])).plan;
  await mutateSessionMeta('source', s => {
    const p = s.workAwareness.executionPlans.find(p => p.id === legacy.id);
    delete p.branchSurface; delete p.branchOrigin; return true;
  });
  await approve(legacy);
  const legacyBranch = (await state(legacy.id)).branches[0];
  assert.equal((await findSessionMeta(legacyBranch.sessionId)).sourceId, 'chat', 'historical Web plans keep their original contract');
  assert.equal(legacyBranch.topicDeliveryId, undefined);

  await mutateSessionMeta('source', s => { s.archived = true; return true; });
  const frozen = creations; await recoverExecutionPlans(api); assert.equal(creations, frozen, 'archived parent cannot be revived by recovery');
  await mutateSessionMeta('source', s => { s.archived = false; return true; });
  // A slow child creation does not hold plan commands or delay a stop intent.
  let releaseCreate, enteredCreate;
  const createGate = new Promise(resolve => { releaseCreate = resolve; });
  const creating = new Promise(resolve => { enteredCreate = resolve; });
  const slowApi = { ...api, createSession: async (...args) => {
    enteredCreate(); await createGate; return api.createSession(...args);
  } };
  const slowInput = await input('slow-plan-start', '开始独立工作');
  const starting = act(slowInput, { action: 'start', goal: 'slow-plan', context: '只读上下文',
    reason: '独立分析', authorization: '本人明确要求', branches: [branch('slow')] }, slowApi);
  await creating;
  const slowPlan = (await findSessionMeta('source')).workAwareness.executionPlans.find(p => p.goal === 'slow-plan');
  await act(await input('stop-slow-plan', '停止刚才工作'), { action: 'stop', planId: slowPlan.id,
    expectedVersion: slowPlan.version, selected: ['slow'], text: '停止，不再启动' }, api);
  assert.equal((await state(slowPlan.id)).branches[0].stopRequested, true);
  const beforeLateCreate = submits;
  releaseCreate(); await starting;
  assert.equal(submits, beforeLateCreate, 'late child creation cannot submit stopped work');
  const reviewRace = (await propose('review-race', [branch('a'), branch('b')])).plan;
  await approve(reviewRace);
  await complete(reviewRace, 'a');
  const finalBranch = (await state(reviewRace.id)).branches.find(b => b.id === 'b');
  const finalInput = await requests.byRequest(finalBranch.sessionId, finalBranch.requestId);
  await requests.settle(finalInput.key, { state: 'completed', payload: { text: 'done' } }, []);
  let releaseReview, reviewEntered;
  const reviewBarrier = new Promise(resolve => { releaseReview = resolve; });
  const reviewStarted = new Promise(resolve => { reviewEntered = resolve; });
  const finishing = finish(await requests.get(finalInput.key), { id: finalInput.runId }, { ...api,
    async submitHttpMessage(...args) { reviewEntered(); await reviewBarrier; return api.submitHttpMessage(...args); } });
  await reviewStarted;
  await act(await input('stop-review'), { action: 'stop', planId: reviewRace.id,
    expectedVersion: (await state(reviewRace.id)).version, selected: ['a', 'b'], text: '停止汇总' }, api);
  releaseReview(); await finishing;
  const stoppedReview = await state(reviewRace.id);
  assert.notEqual(stoppedReview.state, 'reviewing', 'late review admission cannot overwrite stop');
  assert.ok(cancelled.some(([id, run]) => id === 'source' && run === stoppedReview.reviewRunId),
    'a review admitted concurrently with stop receives cancellation');
  // Execution completion can beat the HTTP admission receipt. The later
  // receipt must not replace terminal branch/review state with running.
  const early = (await propose('early-completion', [branch('a')])).plan;
  await approve(early);
  const earlyBranch = (await state(early.id)).branches[0];
  const earlyInput = await requests.byRequest(earlyBranch.sessionId, earlyBranch.requestId);
  await requests.settle(earlyInput.key, { state: 'completed', payload: { text: 'done' } }, []);
  const earlyApi = { ...api, async submitHttpMessage(...args) {
    const receipt = await api.submitHttpMessage(...args);
    const record = await requests.byRunId(receipt.run.id);
    assert(record.options.workPlanReview);
    await requests.settle(record.key, { state: 'completed', payload: { text: 'review done' } }, []);
    await finish(await requests.get(record.key), receipt.run, api);
    return receipt;
  } };
  await finish(await requests.get(earlyInput.key), { id: earlyInput.runId }, earlyApi);
  assert.equal((await state(early.id)).state, 'reviewed', 'late admission receipt must preserve a completed review');
  const rapid = await act(await input('early-child-completion'), { ...directBody, goal: '回执之前完成分支' }, api);
  const earlyCompletions = [];
  const rapidApi = { ...api, async submitHttpMessage(...args) {
    const receipt = await api.submitHttpMessage(...args);
    const record = await requests.byRunId(receipt.run.id);
    await requests.settle(record.key, { state: 'completed', payload: { text: 'finished before receipt' } }, []);
    const completion = finish(await requests.get(record.key), receipt.run, rapidApi);
    earlyCompletions.push(completion);
    if (record.options.workPlanChild) {
      const deadline = Date.now() + 5000;
      while ((await state(rapid.plan.id)).branches[0].state !== 'completed') {
        if (Date.now() > deadline) throw Error('Early branch completion did not persist');
        await new Promise(setImmediate);
      }
    } else await completion;
    return receipt;
  } };
  await deliver(rapidApi);
  await Promise.all(earlyCompletions);
  assert.equal((await state(rapid.plan.id)).branches[0].state, 'completed', 'late child admission must preserve terminal state');
  assert.equal((await state(rapid.plan.id)).state, 'reviewed');
  console.log('EXECUTION_PLANS_VERIFIED: personal/group scope, cross-group consent, draft/partial approval, direct authorized work, dependencies, failure, amendment, question relay, cancellation, recovery and source result ownership. No real model or group send.');
} finally { await rm(home, { recursive: true, force: true }); }
