import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-group-routing-'));
setIsolatedTestHome(home);
const dir = join(home, '.config/remotelab');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: '甲', identities: [{ id: 'identity_a', kind: 'web', subjectId: 'a' }] },
] }));
const origin = { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'pilot', tenantKey: 'tenant',
  chatType: 'group', conversationKind: 'main', messageId: 'one', participationEpoch: '7' } };
const topic = { ...origin, target: { ...origin.target, conversationKind: 'thread', rootId: 'root', messageId: 'root', replyInThread: true } };
await writeFile(join(dir, 'chat-sessions.json'), JSON.stringify([
  { id: 'main', name: 'group', folder: home, conversation: origin, groupFeed: true },
  { id: 'work', name: 'existing work', folder: home, conversation: topic },
  { id: 'other', name: 'other group', folder: home, conversation: { ...topic, target: { ...topic.target, chatId: 'other' } } },
  { id: 'new', name: 'new work', folder: home, conversation: { ...topic, target: { ...topic.target, rootId: 'one', messageId: 'one' } } },
]));
const config = { version: 1, enabled: true, groups: [{ sourceRouteId: 'bot', chatId: 'pilot', tenantKey: 'tenant', folder: home }] };
const configPath = join(dir, 'group-routing-pilot.json');
await writeFile(configPath, JSON.stringify(config));
try {
  await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
  const { requests } = await import('../chat/requests.mjs');
  const { findSessionMeta, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
  const { recordWorkInput } = await import('../chat/work-awareness.mjs');
  const { routeGroupWork, acceptGroupSync, completeGroupSync, validateGroupRethink, readGroupRoutingState, buildGroupRoutingContext } = await import('../chat/group-routing.mjs');
  const { routingPilotScope, isPilotInputSinceActivation } = await import('../lib/group-routing-pilot.mjs');
  const { canForwardNativeRequest } = await import('../chat/native-request-dispatch.mjs');
  const options = { viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a',
    sourceContext: { connector: 'feishu', chatId: 'pilot' }, sourceDelivery: origin };
  const input = async (id, text, extra = {}) => (await requests.accept({ sessionId: 'main', requestId: id, text,
    options: { ...options, ...extra }, deliveryPlan: origin, runtimeSelection: { tool: 'codex', model: 'test' } })).record;
  let created = 0, submits = 0;
  const manager = {
    async createSession(folder, tool, name, extra) { created++; assert.equal(extra.conversation.target.rootId, 'one'); assert.equal(extra.conversation.target.participationEpoch, undefined); assert.equal(extra.conversation.target.sourceKind, 'group_routing_work'); return findSessionMeta('new'); },
    async submitHttpMessage(sessionId, text, images, supplied) {
      const { record, duplicate } = await requests.accept({ sessionId, requestId: supplied.requestId, text, images: supplied.preSavedAttachments || images,
        options: supplied, deliveryPlan: supplied.suppressSourceDelivery ? null : supplied.sourceDelivery });
      if (!duplicate) submits++;
      return { requestId: record.requestId, run: { id: record.runId } };
    },
  };
  assert(await routingPilotScope(origin));
  const fence = { activatedAt: '2026-10-08T00:00:00.000Z' };
  assert.equal(isPilotInputSinceActivation(fence, '2026-10-07T23:59:59Z'), false);
  assert.equal(isPilotInputSinceActivation(fence, undefined), false);
  assert.equal(isPilotInputSinceActivation(fence, Date.parse(fence.activatedAt)), true);
  assert.equal(isPilotInputSinceActivation(fence, String(Date.parse(fence.activatedAt))), true);
  assert.equal(await routingPilotScope({ ...origin, sourceRouteId: 'another-bot' }), null);
  assert.equal(await routingPilotScope({ ...origin, target: { ...origin.target, tenantKey: 'wrong' } }), null);
  const first = await input('one', '调查 A');
  await recordWorkInput(await findSessionMeta('main'), first);
  const routed = await routeGroupWork(first, { mode: 'new', task: '调查 A', reason: '独立事项' }, manager);
  await routeGroupWork(first, { mode: 'new', task: '调查 A', reason: '独立事项' }, manager);
  assert.equal(created, 1); assert.equal(submits, 1);
  assert.equal((await requests.get(first.key)).options.suppressSourceDelivery, true);
  assert.equal((await requests.byRequest('new', 'routed:one')).options.sourceContext.routingReplyMessageId, 'one');
  const second = await input('two', '补充一句：请加入 B');
  await routeGroupWork(second, { mode: 'continue', targetSessionId: 'new', task: '加入 B', reason: '同一工作补充' }, manager);
  assert.equal(created, 1); assert.equal(submits, 2);
  assert.equal((await requests.byRequest('new', 'routed:two')).deliveryPlan.target.rootId, 'one');
  assert.equal((await requests.byRequest('new', 'routed:two')).deliveryPlan.target.participationScopeTopicId, 'main');
  assert.equal((await requests.byRequest('new', 'routed:two')).deliveryPlan.target.participationEpoch, '7');
  assert.equal((await readGroupRoutingState(await findSessionMeta('main'))).routes.length, 2);
  const third = await input('three', '不同事项');
  await assert.rejects(routeGroupWork(third, { mode: 'continue', targetSessionId: 'other', task: '跨群', reason: '错误' }, manager), /same pilot/);
  await assert.rejects(routeGroupWork(await input('auto', '通知', { automationTitle: 'notice' }), { mode: 'new', task: '通知', reason: '错误' }, manager), /human Feishu/);
  await requests.mutate(third.key, r => ({ ...r, deliveries: [{ kind: 'content' }] }));
  await assert.rejects(routeGroupWork(third, { mode: 'new', task: '另开', reason: '已回复' }, manager), /unavailable/);
  assert.equal(created, 1, 'validate input before creating a topic');
  const syncSource = await input('sync-source', 'A 信息可能影响 B');
  await recordWorkInput(await findSessionMeta('main'), syncSource);
  const draft = await routeGroupWork(syncSource, { mode: 'sync', targetSessionId: 'work', task: '新事实 X，复核原结论', reason: '原结论基于旧事实' }, manager);
  assert.equal(submits, 2, 'draft never sends');
  const human = await input('confirmation', '[群参与状态：active。]\n【飞书群消息｜发言人：甲（成员 A）】\n' + draft.confirmation);
  const pending = await acceptGroupSync(human, manager);
  assert.match(pending, /不表示已经完成/);
  await acceptGroupSync(human, manager);
  assert.equal(submits, 3, 'duplicate confirmation sends once');
  const review = await requests.byRequest('work', 'routing-sync:' + draft.proposal.id);
  assert.equal(review.options.recordUserMessage, false); assert.equal(review.options.suppressSourceDelivery, true);
  assert.equal(review.deliveryPlan, undefined);
  await validateGroupRethink(review);
  const active = { key: 'head', runtimeSelection: review.runtimeSelection, options: {} };
  assert.equal(canForwardNativeRequest(review, active), false, 'review cannot steer active work or answer a question');
  assert.equal(canForwardNativeRequest({ key: 'later', options: {} }, review), false, 'review results cannot coalesce with a later user task');
  assert.equal(canForwardNativeRequest({ ...first, options: { routingPilotMainline: true } }, active), false);
  const completed = { ...review, result: { state: 'completed', payload: { text: '新事实成立，结论应调整。' } } };
  await completeGroupSync(completed, { id: review.runId, state: 'completed' });
  await completeGroupSync(completed, { id: review.runId, state: 'completed' });
  const p = (await readGroupRoutingState(await findSessionMeta('main'))).proposals[0];
  assert.equal(p.state, 'return-queued'); assert.equal(p.returnDeliveryState, 'pending');
  const out = await requests.byRunId(p.returnRunId);
  assert.equal(out.deliveries.length, 1);
  const targetReturn = await requests.byRunId(p.targetReturnRunId);
  assert.equal(targetReturn.deliveries.length, 1);
  assert.equal(targetReturn.deliveries[0].target.rootId, 'root');
  assert.match(targetReturn.deliveries[0].text, /新事实 X/);
  assert.equal(p.targetDeliveryState, 'pending');
  assert.equal(out.deliveries[0].target.messageId, 'one');
  assert.match(out.deliveries[0].text, /新事实成立/);
  assert.equal((await requests.byRequest('work', review.requestId)).deliveries.length, 0);
  const fresh = await routeGroupWork(syncSource, { mode: 'sync', targetSessionId: 'work', task: '另一个事实', reason: '需要复核' }, manager);
  await mutateSessionMeta('work', s => { s.workAwareness = { intents: [{ id: 'changed' }] }; return true; });
  await assert.rejects(acceptGroupSync(await input('stale-confirm', fresh.confirmation), manager), /changed/);
  const rejected = await acceptGroupSync(await input('reject', '拒绝同步 ' + fresh.proposal.id), manager);
  assert.match(rejected, /拒绝/); assert.equal(submits, 3);
  assert.match(await acceptGroupSync(await requests.byRequest('main', 'reject'), manager), /rejected/);
  const crashDraft = await routeGroupWork(syncSource, { mode: 'sync', targetSessionId: 'work', task: '重试固定输入', reason: '模拟接受前故障' }, manager);
  const crashInput = await input('crash', crashDraft.confirmation);
  await assert.rejects(acceptGroupSync(crashInput, { ...manager, submitHttpMessage: async () => { throw new Error('interrupted'); } }), /interrupted/);
  await acceptGroupSync(crashInput, manager);
  assert.equal(submits, 4, 'approved-but-not-submitted packet resumes without duplicate approval');
  const secondReview = await requests.byRequest('work', 'routing-sync:' + crashDraft.proposal.id);
  await mutateSessionMeta('work', s => { s.workAwareness.intents.push({ id: 'newer' }); return true; });
  await assert.rejects(validateGroupRethink(secondReview), /目标讨论已变化/);
  const context = await buildGroupRoutingContext(await findSessionMeta('main'), options.sourceContext);
  assert.match(context, /sourceRequestId/); assert(context.length < 16000);
  await writeFile(configPath, JSON.stringify({ ...config, enabled: false }));
  assert.equal(await routingPilotScope(origin), null);
  assert.equal(await buildGroupRoutingContext(await findSessionMeta('main'), options.sourceContext), '');
  await assert.rejects(routeGroupWork(syncSource, { mode: 'sync', targetSessionId: 'work', task: 'disabled', reason: 'disabled' }, manager), /enabled pilot/);
  console.log('GROUP_ROUTING_VERIFIED: scoped handoff and continuation, stable ownership and retries, confirmed bounded reconsideration, queued return receipt, stale/rejected/off-scope inputs fail closed; no external messages or models.');
} finally { await rm(home, { recursive: true, force: true }); }
