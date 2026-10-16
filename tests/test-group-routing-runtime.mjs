import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-routing-runtime-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
const dir = join(home, '.config/remotelab');
await mkdir(dir, { recursive: true });
await mkdir(join(home, 'bin'));
const executable = join(home, 'bin/fake-route');
await writeFile(executable, `#!/usr/bin/env node
(async () => {
if (process.argv.join(' ').includes('HOLD_REVIEW_FIXTURE')) {
 const fs = require('fs'); const gate = ${JSON.stringify(join(home, 'release'))};
 if (!fs.existsSync(gate)) await new Promise(resolve => { const watcher = fs.watch(${JSON.stringify(home)}, () => {
  if (fs.existsSync(gate)) { watcher.close(); resolve(); }
 }); if (fs.existsSync(gate)) { watcher.close(); resolve(); } });
}
console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread'}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'复核完成：新信息影响原结论，建议更新假设。'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
})().catch(e => { console.error(e); process.exitCode = 1; });
`);
await chmod(executable, 0o755);
const nativeExecutable = join(home, 'bin/fake-sync-native');
const nativeFixture = await readFile(new URL('./fixtures/native-codex-app-server.cjs', import.meta.url), 'utf8');
await writeFile(nativeExecutable, nativeFixture.replaceAll("label: '简短'", "label: fs.readFileSync(path.join(root, 'sync-choice'), 'utf8')"));
await chmod(nativeExecutable, 0o755);
process.env.PATH = join(home, 'bin') + ':' + process.env.PATH;
await writeFile(join(dir, 'tools.json'), JSON.stringify([{ id: 'fake-route', name: 'Fixture', command: 'fake-route',
  runtimeFamily: 'codex-json', models: [{ id: 'fixture', label: 'Fixture' }],
  reasoning: { kind: 'enum', levels: ['low'], default: 'low' } },
  { id: 'fake-sync-native', name: 'Native fixture', command: 'fake-sync-native', runtimeFamily: 'codex-json',
    inputMode: 'native', promptMode: 'bare-user' }]));
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: '甲', identities: [{ id: 'identity_a', kind: 'web', subjectId: 'a' }] },
] }));
await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify({ version: 1, enabled: true,
  groups: [{ sourceRouteId: 'bot', chatId: 'pilot', tenantKey: 'tenant', folder: home }] }));
const { loadAuthDocument } = await import('../lib/auth-config.mjs');
await loadAuthDocument({ persistMigration: false });
const manager = await import('../chat/session-manager.mjs');
const { requests } = await import('../chat/requests.mjs');
const { recordWorkInput } = await import('../chat/work-awareness.mjs');
const { findSessionMeta, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { routeGroupWork, readGroupRoutingState } = await import('../chat/group-routing.mjs');
// A bounded observer, only synthetic detached processes, no provider or connector.
async function until(predicate) {
  const deadline = Date.now() + 15000;
  let delay = 25;
  do { const result = await predicate(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(500, delay * 2);
  } while (Date.now() < deadline);
  throw new Error('Synthetic routing run did not complete');
}
try {
  const origin = { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'pilot', tenantKey: 'tenant',
    chatType: 'group', conversationKind: 'main', messageId: 'input-root' } };
  const runtime = { tool: 'fake-route', model: 'fixture', effort: 'low' };
  const opts = { ...runtime, viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a',
    sourceContext: { connector: 'feishu', chatId: 'pilot' }, sourceDelivery: origin };
  const main = await manager.createSession(home, runtime.tool, 'Pilot', { ...runtime, conversation: origin, sourceId: 'feishu' });
  const { record: first } = await requests.accept({ sessionId: main.id, requestId: 'manual-input', text: '复核事项 A',
    options: opts, runtimeSelection: runtime, deliveryPlan: origin });
  await recordWorkInput(main, first);
  const route = await routeGroupWork(first, { mode: 'new', task: '核对事项 A', reason: '独立工作' });
  const target = await findSessionMeta(route.targetSessionId);
  assert.equal(target.conversation.target.rootId, 'input-root');
  const task = await until(async () => { const r = await requests.byRequest(target.id, 'routed:manual-input'); return r?.result && r; });
  assert.equal(task.result.state, 'completed');
  assert(task.deliveries.length > 0);
  assert(task.deliveries.every(d => d.target.rootId === 'input-root'));
  const draft = await routeGroupWork(first, { mode: 'sync', targetSessionId: target.id, task: '补充事实 X，请复核', reason: '影响原假设' });
  const confirmation = await manager.submitHttpMessage(main.id, draft.confirmation, [], { ...opts, requestId: 'human-confirm' });
  await until(async () => (await requests.byRunId(confirmation.run.id))?.result);
  const state = await until(async () => { const s = await readGroupRoutingState(await findSessionMeta(main.id));
    return s.proposals[0]?.returnDeliveryId && s; });
  const proposal = state.proposals[0];
  const review = await requests.byRequest(target.id, 'routing-sync:' + proposal.id);
  assert.equal(review.result.state, 'completed');
  assert.equal(review.options.nativeQuestionId, undefined);
  assert.equal(review.deliveries.length, 0, 'ordinary reply stream does not duplicate the approved reference publication');
  const targetOutput = await requests.byRunId(proposal.targetReturnRunId);
  assert.equal(targetOutput.deliveries[0].target.rootId, 'input-root');
  assert.match(targetOutput.deliveries[0].text, /补充事实 X/);
  assert.equal(proposal.returnDeliveryState, 'pending', 'no synthetic group messages are sent');
  const outbound = await requests.byRunId(proposal.returnRunId);
  assert.match(outbound.deliveries[0].text, /复核完成/);
  assert.equal(outbound.deliveries[0].target.messageId, 'input-root');
  // Queued reconsideration must fail visibly if a newer task changes the target.
  const hold = await manager.submitHttpMessage(target.id, 'HOLD_REVIEW_FIXTURE', [], {
    ...runtime, requestId: 'held-task', viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a', suppressSourceDelivery: true,
  });
  await until(async () => (await requests.byRunId(hold.run.id))?.preparedAt);
  const { record: newSource } = await requests.accept({ sessionId: main.id, requestId: 'stale-source', text: '再核对一项',
    options: opts, runtimeSelection: runtime, deliveryPlan: origin });
  const staleDraft = await routeGroupWork(newSource, { mode: 'sync', targetSessionId: target.id, task: '复核旧假设', reason: '排队期间的新任务反例' });
  await manager.submitHttpMessage(main.id, staleDraft.confirmation, [], { ...opts, requestId: 'stale-human-confirm' });
  await mutateSessionMeta(target.id, session => { session.workAwareness.intents.push({ id: 'newer-human-task' }); return true; });
  await writeFile(join(home, 'release'), 'release');
  const failed = await until(async () => { const p = (await readGroupRoutingState(await findSessionMeta(main.id))).proposals[1];
    return p.returnDeliveryId && p; });
  assert.equal(failed.resultState, 'failed');
  assert.equal(failed.targetDeliveryId, undefined, 'an expired review does not publish in the target topic');
  assert.equal(failed.returnDeliveryState, 'pending');
  const failureReturn = await requests.byRunId(failed.returnRunId);
  assert.match(failureReturn.deliveries[0].text, /目标讨论已变化/);
  // Exercise the shipped admission path, independently of legacy pilot inputs.
  const { loadPersonMessageReplies, changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
  const actor = { personId: 'person_a', identityId: 'identity_a' };
  const authenticated = { ...opts, feishuConnectorAuthenticated: true, sourceContext: {
    connector: 'feishu', sourceRouteId: 'bot', chatId: 'pilot', chatType: 'group', messageId: 'input-root',
    sender: { openId: 'a', senderType: 'user' } } };
  const disabled = await manager.submitHttpMessage(main.id, '默认在原会话处理', [], { ...authenticated, requestId: 'routing-off' });
  const disabledRecord = await requests.byRunId(disabled.run.id);
  assert.equal(disabledRecord.options.messageRoutingPolicy.mechanism, 'none');
  assert.equal(disabledRecord.options.routingPilotMainline, undefined);
  await until(async () => (await requests.byRunId(disabled.run.id))?.result);
  let setting = await loadPersonMessageReplies(actor);
  setting = await changePersonMessageReplies({ action: 'apply', expectedRevision: setting.revision, confirm: true,
    choices: { ...setting.choices, routing: 'experimental' } }, actor);
  const enabled = await manager.submitHttpMessage(main.id, '选择实验分流', [], { ...authenticated, requestId: 'routing-on' });
  assert.equal((await requests.byRunId(enabled.run.id)).options.routingPilotMainlineProtocol, 2);
  await until(async () => (await requests.byRunId(enabled.run.id))?.result);
  await changePersonMessageReplies({ action: 'reset', expectedRevision: setting.revision, confirm: true }, actor);
  await manager.submitHttpMessage(main.id, '选择实验分流', [], { ...authenticated, requestId: 'routing-on' });
  assert.equal((await requests.byRunId(enabled.run.id)).options.messageRoutingPolicy.mechanism, 'experimental', 'retry keeps the original selection');
  // The v2 plan uses the real request admission, detached worker, completion
  // hooks and parent review queue. Neither a provider nor Feishu is contacted.
  await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify({ version: 2, enabled: true,
    trialId: 'fixture-v2', personIds: ['person_a'], crossGroupSync: true,
    groups: [{ sourceRouteId: 'bot', chatId: 'pilot', tenantKey: 'tenant', folder: home }] }));
  const { handleExecutionPlan } = await import('../chat/work-execution-plans.mjs');
  const sourceOptions = { ...authenticated, sourceContext: { ...authenticated.sourceContext, createTime: String(Date.now()) },
    messageRoutingPolicy: { version: 1, mechanism: 'experimental', trialVersion: 2, trialId: 'fixture-v2' } };
  const sourceInput = (await requests.accept({ sessionId: main.id, requestId: 'plan-source', text: '提出分工',
    options: sourceOptions, runtimeSelection: runtime, deliveryPlan: origin })).record;
  const proposed = await handleExecutionPlan(sourceInput, { action: 'propose', goal: '核对原讨论并汇总',
    context: '只使用已提供的测试资料，禁止外部操作', reason: '两个独立检查', branches: [
      { id: 'one', name: '检查一', task: '核查第一份材料', writeScope: '只读', dependsOn: [] },
      { id: 'two', name: '检查二', task: '核查第二份材料', writeScope: '只读', dependsOn: [] },
    ] });
  const approvalInput = (await requests.accept({ sessionId: main.id, requestId: 'plan-human-approval', text: '两个都开始',
    options: sourceOptions, runtimeSelection: runtime, deliveryPlan: origin })).record;
  await handleExecutionPlan(approvalInput, { action: 'approve', planId: proposed.plan.id, expectedVersion: 1,
    selected: ['one', 'two'], approval: '本人确认两个分支' });
  const finishedPlan = await until(async () => {
    const p = (await findSessionMeta(main.id)).workAwareness.executionPlans[0];
    return p.state === 'reviewed' && p;
  });
  assert(finishedPlan.branches.every(b => b.state === 'completed'));
  const parentResult = await requests.byRequest(main.id, finishedPlan.reviewRequestId);
  assert.equal(parentResult.result.state, 'completed');
  assert(parentResult.deliveries.length > 0);
  assert(parentResult.deliveries.every(d => d.target.chatId === 'pilot' && d.target.messageId === 'input-root'));
  for (const b of finishedPlan.branches) {
    const child = await findSessionMeta(b.sessionId);
    assert.equal(child.sourceId, 'chat'); assert.equal(child.conversation, undefined);
    const r = await requests.byRequest(b.sessionId, b.requestId);
    assert.equal(r.deliveries.length, 0, 'children do not publish duplicate results into groups');
  }
  const explicitInput = (await requests.accept({ sessionId: main.id, requestId: 'explicit-three-sessions',
    text: '号池、资源、理想分流三项分别开子Session并行核对', options: sourceOptions,
    runtimeSelection: runtime, deliveryPlan: origin })).record;
  const direct = await handleExecutionPlan(explicitInput, { action: 'start', goal: '三项独立复核',
    context: '仅使用测试材料，不访问真实业务', reason: '本人明确指定三条并行分工',
    executionMode: 'parallel-sessions', authorization: '当前原话明确要求三个具体子Session并行',
    branches: ['pool', 'resources', 'oracle'].map(id => ({ id, name: id, task: '只读检查测试材料 ' + id,
      writeScope: '只读测试材料', dependsOn: [] })) });
  const three = await until(async () => {
    const p = (await findSessionMeta(main.id)).workAwareness.executionPlans.find(p => p.id === direct.plan.id);
    return p.state === 'reviewed' && p;
  });
  assert.equal(new Set(three.branches.map(b => b.sessionId)).size, 3);
  for (const b of three.branches) {
    assert.equal(b.state, 'completed'); assert(b.sessionUrl);
    const child = await findSessionMeta(b.sessionId);
    assert.equal(child.delegatedFromSessionId, main.id); assert.equal(child.sourceId, 'chat');
    assert.equal((await requests.byRequest(b.sessionId, b.requestId)).deliveries.length, 0);
  }
  assert((await requests.byRequest(main.id, three.reviewRequestId)).deliveries.every(d => d.target.messageId === 'input-root'));
  // Use the real native question/admission path. Successful confirmation
  // updates the original question; only review completion creates a return.
  const nativePlan = { ...origin, target: { ...origin.target, conversationKind: 'thread',
    messageId: 'native-root', rootId: 'native-root', replyInThread: true } };
  const nativeSession = await manager.createSession(home, 'fake-sync-native', 'Confirmation', {
    conversation: nativePlan, sourceId: 'feishu' });
  const nativeOptions = { ...authenticated, sourceDelivery: nativePlan };
  const nativeTask = '保留结论和必须回答的问题', nativeReason = '核对同步展示路径';
  const predictedId = 'sync_' + createHash('sha256').update(JSON.stringify([
    nativeSession.id, 'native-sync-question', target.id, nativeTask, nativeReason])).digest('hex').slice(0, 20);
  await writeFile(join(home, 'sync-choice'), '确认同步 ' + predictedId);
  const nativeSetting = await loadPersonMessageReplies(actor);
  await changePersonMessageReplies({ action: 'apply', expectedRevision: nativeSetting.revision, confirm: true,
    choices: { ...nativeSetting.choices, routing: 'experimental' } }, actor);
  const nativeRoot = await manager.submitHttpMessage(nativeSession.id, 'ASK_NATIVE_QUESTION PUBLISH_OPENING THREAD_OPENING', [], {
    ...nativeOptions, requestId: 'native-sync-question', tool: 'fake-sync-native', model: '', effort: '',
  });
  const { readNativeQuestion } = await import('../chat/native-user-questions.mjs');
  const { runDir } = await import('../chat/runs.mjs');
  const question = await until(async () => { const q = await readNativeQuestion(runDir(nativeRoot.run.id)); return q?.state === 'pending' && q; });
  const nativeDraft = await routeGroupWork(await requests.byRunId(nativeRoot.run.id), { mode: 'sync', targetSessionId: target.id,
    task: nativeTask, reason: nativeReason });
  assert.equal(nativeDraft.proposal.id, predictedId);
  const answerOptions = { ...nativeOptions, requestId: 'native-sync-answer', nativeQuestionId: question.id,
    nativeQuestionAnswerSource: 'control', sourceContext: { ...authenticated.sourceContext, createTime: String(Date.now()), messageType: 'interactive' } };
  await manager.submitHttpMessage(nativeSession.id, '1', [], answerOptions);
  const answered = await until(async () => { const r = await requests.byRequest(nativeSession.id, 'native-sync-answer'); return r?.nativeReceipt && r; });
  assert.equal(answered.options.routingDecisionText, nativeDraft.confirmation);
  assert.match(answered.nativeInput.systemOutcome.context, /不要再发送仅确认受理/);
  assert.doesNotMatch(answered.nativeInput.systemOutcome.text, /submitted|sync_/);
  const { loadHistory } = await import('../chat/history.mjs');
  await until(async () => (await loadHistory(nativeSession.id, { includeBodies: true })).some(e => e.questionId === question.id && e.questionState === 'answered'));
  const answerEvent = (await loadHistory(nativeSession.id, { includeBodies: true })).find(e => e.questionId === question.id && e.questionState === 'answered');
  assert.match(answerEvent.content, /已提交|复核结果/);
  assert((await requests.projectActive(records => records)).every(r => r.responseId !== 'routing-question-result:native-sync-answer'),
    'successful native confirmation does not create a second receipt message');
  const repeated = await manager.submitHttpMessage(nativeSession.id, '1', [], answerOptions);
  assert.equal(repeated.duplicate, true);
  await writeFile(join(home, `${nativeRoot.run.id}.release`), 'release');
  const final = await until(async () => { const r = await requests.byRunId(nativeRoot.run.id); return r?.result && r; });
  assert(final.deliveries.some(d => d.surfaceKind === 'final' && d.text.includes('durable native answer')),
    'a substantive model final is still delivered separately');
  console.log('GROUP_ROUTING_RUNTIME_VERIFIED: actual admission, isolated worker, human approval dispatch, target completion hook and durable source outbox. No live model or Feishu send.');
} finally {
  await manager.killAll();
  // Metadata classification is intentionally non-blocking and can still write
  // after the foreground run settles. Keep its isolated home until Node has
  // drained those child processes and I/O, rather than racing recursive rm.
  // Detached runners may finish their final durable writes after this process
  // becomes idle. Retry transient ENOTEMPTY during teardown, with a bounded
  // 1.5-second retry budget; persistent cleanup errors still fail the test.
  process.once('beforeExit', async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
}
