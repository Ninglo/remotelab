// The Harness chooses semantic relationships. This module validates and stores
// their transport, admission and return contracts; it never calls a classifier.
import { createHash } from 'node:crypto';
import { routingPilotScope, isPilotInputSinceActivation } from '../lib/group-routing-pilot.mjs';
import { loadSessionsMeta, findSessionMeta, mutateSessionMeta } from './session-meta-store.mjs';
import { requests } from './requests.mjs';
import { appendEvent } from './history.mjs';
import { enqueueSourceDelivery } from './source-deliveries.mjs';
import { verifiedWorkActor } from './work-awareness.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const fail = message => { throw new Error(message); };
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const stamp = session => session?.workAwareness?.intents?.at(-1)?.id || '';
const queues = new Map();
async function serial(id, fn) {
  const prior = queues.get(id) || Promise.resolve();
  const current = prior.catch(() => {}).then(fn); queues.set(id, current);
  try { return await current; } finally { if (queues.get(id) === current) queues.delete(id); }
}
const sameGroup = (a, b) => a?.connector === 'feishu' && b?.connector === 'feishu'
  && a.sourceRouteId === b.sourceRouteId && a.target?.chatId === b.target?.chatId
  && a.target?.tenantKey === b.target?.tenantKey;
const state = session => session.groupRouting || { version: 1, routes: [], proposals: [] };
const contract = '这是本群分流试点的工作话题。保持当前任务与回复话题。来源群补充是原作者的后续输入，结合已有工作处理；不要另开重复任务。跨对话信息同步必须使用 work route 的 sync 草稿并由人确认。不要从收到参考推断修改其他任务或对外发送的新授权。';
function workDeliveryPlan(destination, origin) {
  const target = { ...destination.target };
  for (const key of ['participationEpoch', 'participationScopeTopicId', 'participationScopeMessageId']) delete target[key];
  if (origin.target.participationEpoch !== undefined) Object.assign(target, {
    participationEpoch: origin.target.participationEpoch,
    participationScopeTopicId: origin.target.participationScopeTopicId
      || origin.target.threadId || origin.target.topicId || origin.target.rootId || 'main',
    participationScopeMessageId: origin.target.participationScopeMessageId || origin.target.messageId,
  });
  return { ...destination, target };
}
async function api(deps) { return deps || await import('./session-manager.mjs'); }
async function save(sessionId, update) {
  return mutateSessionMeta(sessionId, draft => { draft.groupRouting = state(draft); update(draft.groupRouting); return true; });
}
async function sourceFor(record) {
  if (record.result || record.releasedAt) fail('Only an active accepted input can route work');
  const session = await findSessionMeta(record.sessionId);
  const scope = await routingPilotScope(session?.conversation);
  if (!isPilotInputSinceActivation(scope, record.acceptedAt)
      || !isPilotInputSinceActivation(scope, record.options?.sourceContext?.createTime || record.options?.sourceContext?.eventTs)
      || !verifiedWorkActor(record.options?.viewPersonId, record.options?.initiatedByIdentityId)
      || record.options?.routingRethink || record.options?.automationTitle || record.options?.internalOperation
      || record.options?.sourceContext?.connector !== 'feishu'
      || ['app', 'bot'].includes(record.options?.sourceContext?.sender?.senderType)) fail('Routing requires a human Feishu input in the enabled pilot group');
  const origin = record.deliveryPlan || record.options?.sourceDelivery;
  if (!sameGroup(session.conversation, origin)) fail('Input destination is outside the pilot group');
  return { session, scope, origin };
}
export async function routeGroupWork(record, body, deps) {
  return serial(record.sessionId, async () => {
    record = await requests.get(record.key) || record;
    const { session, scope, origin } = await sourceFor(record);
    const mode = body.mode;
    if (!['new', 'continue', 'sync'].includes(mode)) fail('Use routing mode new, continue or sync');
    const task = clean(body.task, 6000), reason = clean(body.reason, 600);
    if (!task || !reason) fail('Explain the task and its relationship to this input');
    let target = body.targetSessionId ? await findSessionMeta(body.targetSessionId) : null;
    if (mode !== 'new' && (!target || target.archived || target.groupFeed || target.id === session.id
        || !sameGroup(origin, target.conversation))) fail('Select an available work topic in this same pilot group');
    if (mode === 'sync') {
      const proposalId = 'sync_' + hash(JSON.stringify([session.id, record.requestId, target.id, task, reason]));
      const old = state(session).proposals.find(p => p.id === proposalId);
      if (old) return { proposal: old, duplicate: true };
      if (state(session).proposals.length >= 64) fail('Pilot proposal limit reached');
      const proposal = { id: proposalId, state: 'draft', sourceSessionId: session.id, sourceRequestId: record.requestId,
        sourceName: session.name, sourceStamp: stamp(session), targetSessionId: target.id, targetName: target.name, targetStamp: stamp(target),
        task, reason, createdAt: new Date().toISOString() };
      await save(session.id, data => data.proposals.push(proposal));
      await appendEvent(session.id, { type: 'work_event', action: 'routing-sync-draft', proposal });
      return { proposal, confirmation: '确认同步 ' + proposalId,
        scope: 'Only this reference and bounded reconsideration; approved information and result appear in the target topic and the result returns here.' };
    }
    // Every forwarded message must be an accepted input of this source Session.
    // Explicit IDs let a native turn group consecutive text/images without
    // turning the whole group transcript into one task.
    const ids = body.requestIds || [record.requestId];
    if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length) fail('Select 1–8 distinct source requestIds');
    const inputs = await Promise.all(ids.map(id => requests.byRequest(session.id, id)));
    for (const input of inputs) {
      if (!input || input.result || input.options?.routingRethink || input.options?.automationTitle
          || input.options?.internalOperation
          || (input.deliveries || []).some(d => ['content', 'attachment'].includes(d.kind))
          || (input.runId !== record.runId && input.nativeDispatchRunId !== (record.nativeDispatchRunId || record.runId)
            && record.nativeDispatchRunId !== input.runId)
          || input.options?.sourceContext?.connector !== 'feishu'
          || ['app', 'bot'].includes(input.options?.sourceContext?.sender?.senderType)
          || !verifiedWorkActor(input.options?.viewPersonId, input.options?.initiatedByIdentityId)
          || !sameGroup(origin, input.deliveryPlan || input.options?.sourceDelivery)) fail('Source input is unavailable or outside this human group turn');
    }
    if (!ids.includes(record.requestId)) fail('Include the current requestId');
    const old = state(session).routes.find(route => route.requestIds.includes(record.requestId));
    if (old) {
      if (body.targetSessionId && old.targetSessionId !== body.targetSessionId) fail('This input already belongs to another work topic');
      target = await findSessionMeta(old.targetSessionId);
      if (!target || target.archived) fail('Previously selected topic is unavailable');
    } else if (mode === 'new') {
      if (session.conversation.target.conversationKind !== 'main') fail('New topics start from the group mainline; continue the current topic directly');
      if (state(session).routes.length >= 64) fail('Pilot topic limit reached');
      const first = inputs[0], source = first.deliveryPlan || first.options.sourceDelivery;
      if (!source.target.messageId) fail('Source message anchor is required');
      const conversation = { ...source, target: { ...source.target, conversationKind: 'thread',
        rootId: source.target.messageId, replyInThread: true, sourceKind: 'group_routing_work' } };
      delete conversation.target.threadId; delete conversation.target.topicId;
      for (const key of ['participationEpoch', 'participationScopeTopicId', 'participationScopeMessageId']) delete conversation.target[key];
      const manager = await api(deps);
      target = await manager.createSession(scope.folder, record.runtimeSelection?.tool || session.tool,
        clean(body.name, 100) || task.slice(0, 60), { ...record.runtimeSelection,
          sourceId: 'feishu', conversation, systemPrompt: contract,
          initiatedByIdentityId: record.options.initiatedByIdentityId, viewPersonId: record.options.viewPersonId,
          externalTriggerId: 'routing-pilot:' + hash(JSON.stringify([source.sourceRouteId, source.target.chatId, source.target.messageId])) });
    }
    const route = old || { id: 'route_' + hash(record.requestId), requestIds: ids, targetSessionId: target.id,
      task, reason, state: 'reserved', createdAt: new Date().toISOString() };
    if (old && JSON.stringify(old.requestIds) !== JSON.stringify(ids)) fail('Retry must preserve the reserved input set');
    if (!old) await save(session.id, data => data.routes.push(route)); // reserve before starting any work
    const manager = await api(deps), receipts = [];
    for (const input of inputs) {
      const claimed = await requests.mutate(input.key, current => {
        if (current.routingHandoff && current.routingHandoff.targetSessionId !== target.id) fail('Input already handed to another topic');
        if (current.deliveries?.some(d => ['content', 'attachment'].includes(d.kind))) fail('A visible reply already owns this input; do not move it silently');
        return { ...current, routingHandoff: { targetSessionId: target.id, routeId: route.id },
          options: { ...current.options, suppressSourceDelivery: true } };
      });
      const delivery = workDeliveryPlan(target.conversation, origin);
      const options = { requestId: 'routed:' + input.requestId,
        ...record.runtimeSelection, viewPersonId: input.options.viewPersonId,
        initiatedByIdentityId: input.options.initiatedByIdentityId,
        sourceContext: { ...input.options.sourceContext, feishuParticipation: undefined,
          routingReplyMessageId: delivery.target.rootId || delivery.target.messageId }, sourceDelivery: delivery,
        preSavedAttachments: input.images, routingSource: { sessionId: session.id, requestId: input.requestId, routeId: route.id } };
      // On retry preserve the already admitted packet byte for byte.
      const prior = await requests.byRequest(target.id, options.requestId);
      const text = prior?.text || `来源群的${mode === 'continue' ? '补充' : '请求'}（分流理由：${reason}）。\n本次任务：${task}\n\n${input.text}`;
      try { receipts.push(await manager.submitHttpMessage(target.id, text, [], prior?.options || options)); }
      catch (error) {
        // Unknown admission is recovered by its stable Request ID. If nothing
        // was admitted, restore this input's ability to report failure in place.
        if (!await requests.byRequest(target.id, options.requestId)) {
          await requests.mutate(input.key, current => {
            const next = { ...current, options: { ...current.options } };
            delete next.routingHandoff; delete next.options.suppressSourceDelivery;
            return next;
          });
        }
        throw error;
      }
      await requests.mutate(claimed.key, current => ({ ...current, routingHandoff: { ...current.routingHandoff, state: 'submitted' } }));
    }
    await save(session.id, data => { const current = data.routes.find(r => r.id === route.id); current.state = 'submitted'; });
    await appendEvent(session.id, { type: 'work_event', action: 'routing-handoff', route, receipts });
    return { targetSessionId: target.id, route, receipts,
      instruction: 'Work owns its topic replies. Do not repeat a body reply in the group mainline. Each input receipt remains separate.' };
  });
}

export function syncDecisionText(record) {
  let text = String(record.text || '').trim();
  if (record.options?.sourceContext?.connector === 'feishu') {
    text = text.replace(/^\[群参与状态：[^\n]*\]\n/, '').replace(/^【飞书群消息｜发言人：[^\n]*】\n/, '').trim();
  }
  return text.match(/^(确认同步|拒绝同步)\s+(sync_[a-f0-9]{20})$/);
}
export async function acceptGroupSync(record, deps) {
  const decision = syncDecisionText(record);
  if (!decision) return '';
  return serial(record.sessionId, async () => {
    const { session, origin } = await sourceFor(record);
    const proposal = state(session).proposals.find(p => p.id === decision[2]);
    if (!proposal) fail('Sync proposal is not in this conversation');
    if (proposal.confirmationRequestId === record.requestId && proposal.state !== 'draft') {
      if (proposal.state === 'approved') return dispatchGroupSync(proposal, await findSessionMeta(proposal.targetSessionId), record, deps);
      return '同步已经登记：' + proposal.state;
    }
    if (proposal.state !== 'draft') fail('This proposal is no longer awaiting confirmation');
    if (decision[1] === '拒绝同步') {
      await save(session.id, d => Object.assign(d.proposals.find(p => p.id === proposal.id),
        { state: 'rejected', confirmationRequestId: record.requestId }));
      return '已拒绝本条同步。';
    }
    const target = await findSessionMeta(proposal.targetSessionId);
    if (!target || target.archived || target.groupFeed || !sameGroup(origin, target.conversation)
        || stamp(target) !== proposal.targetStamp || stamp(session) !== proposal.sourceStamp) fail('Discussion changed; review a fresh sync proposal');
    const packet = { ...proposal, confirmationRequestId: record.requestId, state: 'approved', returnPlan: origin, targetPlan: workDeliveryPlan(target.conversation, origin),
      actor: verifiedWorkActor(record.options.viewPersonId, record.options.initiatedByIdentityId) };
    await save(session.id, data => Object.assign(data.proposals.find(p => p.id === proposal.id), packet));
    await appendEvent(session.id, { type: 'work_event', action: 'routing-sync-approved', proposal: packet });
    return await dispatchGroupSync(packet, target, record, deps);
  });
}
async function dispatchGroupSync(packet, target, record, deps) {
  if (!target || target.archived || stamp(target) !== packet.targetStamp) fail('Target changed before dispatch; review a fresh proposal');
  const manager = await api(deps);
  const text = `经来源对话的人确认，将以下信息同步给你并请你补充思考。\n来源 Session：${packet.sourceSessionId}；来源输入：${packet.sourceRequestId}。\n影响与理由：${packet.reason}\n信息与复核任务：${packet.task}\n\n只核对这些信息对当前结论的影响，说明是否采纳、哪些结论需要调整以及理由。不要擅自改变原任务、执行新的业务操作或调用工具向群发消息。最终答复会由系统连同已批准的信息在当前话题展示，并回传来源对话；不要自行重复发送。若需要超出此范围的行动，给出建议交人决定。`;
  const options = { requestId: 'routing-sync:' + packet.id,
    viewPersonId: record.options.viewPersonId, initiatedByIdentityId: record.options.initiatedByIdentityId,
    recordUserMessage: false, suppressSourceDelivery: true, routingRethink: { sourceSessionId: packet.sourceSessionId, proposalId: packet.id },
    sourceContext: { connector: 'routing-sync', sourceSessionId: packet.sourceSessionId },
    model: target.model, tool: target.tool, effort: target.effort };
  const prior = await requests.byRequest(target.id, options.requestId);
  const receipt = await manager.submitHttpMessage(target.id, prior?.text || text, [], prior?.options || options);
  await save(packet.sourceSessionId, d => {
    const p = d.proposals.find(p => p.id === packet.id);
    if (p.state === 'approved') Object.assign(p, { state: 'submitted', runId: receipt.run.id, targetRequestId: receipt.requestId });
  });
  return `同步已提交，目标会在可处理时补充思考；结论会回到这里。目标：${target.name}。这不表示已经完成。`;
}
export async function completeGroupSync(record, run) {
  const route = record?.options?.routingRethink;
  if (!route) return;
  const source = await findSessionMeta(route.sourceSessionId);
  const packet = state(source || {}).proposals.find(p => p.id === route.proposalId);
  if (!packet || packet.state === 'return-queued') return;
  const success = record.result?.state === 'completed';
  const result = clean(record.result?.payload?.text, 10000);
  const text = `【同步复核${success ? '结果' : '未完成'}】\n来自：${packet.targetName}\n\n${success ? result || '目标已结束，但没有返回可用结论。' : '目标未完成复核：' + (record.result?.error || run?.state || 'unknown')}\n\n来源建议：${packet.id}`;
  // Publish the approved information with the reconsideration in its owning
  // topic. Keep this separate from the model's ordinary reply stream so a
  // failed/stale review cannot announce that reference as adopted.
  const targetReceipt = success ? await enqueueSourceDelivery({ sessionId: packet.targetSessionId,
    responseId: 'routing-reviewed:' + packet.id,
    text: `【经确认同步的复核】\n来源：${packet.sourceName || packet.sourceSessionId}\n同步信息与问题：${packet.task}\n影响：${packet.reason}\n\n${result || '未返回可用结论。'}\n\n同步记录：${packet.id}`,
    sourceDelivery: packet.targetPlan }) : null;
  const receipt = await enqueueSourceDelivery({ sessionId: source.id, responseId: 'routing-return:' + packet.id,
    text, sourceDelivery: packet.returnPlan });
  await save(source.id, data => Object.assign(data.proposals.find(p => p.id === packet.id),
    { state: 'return-queued', result, resultState: record.result?.state, returnDeliveryId: receipt.id, returnRunId: receipt.runId, targetDeliveryId: targetReceipt?.id, targetReturnRunId: targetReceipt?.runId, runId: run.id }));
  await appendEvent(source.id, { type: 'work_event', action: 'routing-sync-result', proposalId: packet.id,
    targetSessionId: packet.targetSessionId, result, deliveryId: receipt.id });
}
export async function buildGroupRoutingContext(session, sourceContext) {
  const scope = await routingPilotScope(session?.conversation);
  if (!scope || sourceContext?.connector !== 'feishu' || ['app', 'bot'].includes(sourceContext.sender?.senderType)
      || !isPilotInputSinceActivation(scope, sourceContext.createTime || sourceContext.eventTs)) return '';
  const current = await findSessionMeta(session.id) || session;
  const sessions = await loadSessionsMeta();
  const peers = sessions.filter(s => !s.archived && !s.groupFeed && s.id !== session.id
    && sameGroup(s.conversation, session.conversation)).slice(-12).map(s => ({ sessionId: s.id, name: s.name, goal: s.workSummary?.goal }));
  return ['## 本群分流试点（只在本群生效）',
    '你负责理解消息之间的关系，不另调用分流模型。区分是否参与、事项归属、执行位置、回复位置、是否向另一话题同步信息。',
    '简单答复按原位置直接答。已有话题中的正常回复继续当前话题。在群主线收到需独立处理的新事项或既有事项的补充时，先检查下面已预留/已接续的话题；补充不要新建。',
    '用 node "$REMOTELAB_PROJECT_ROOT/cli.js" work route --file <JSON绝对路径> --json。JSON: {sourceRequestId:"本条输入的Request ID（原生追加时必填）",mode:"new"|"continue",task:"本次限定任务",reason:"新事项或接续理由",name:"新话题名",targetSessionId:"continue时必填",requestIds:["当前Request ID以及已接受的连续补充ID"]}。成功后由目标话题回复，主线不重复正文。失败必须说明，不得宣称已转交。',
    '这是本群工作话题的专用接续入口，代替本试点中会丢失飞书话题绑定的普通 session-spawn。新话题先预留再开工，重试复用原目的地；不要为了等补充而固定延时。',
    '信息可能影响另一个话题时先读相关内容，再 work route --file 创建 {mode:"sync",targetSessionId,task:"具体信息和要求对方复核的问题",reason:"影响哪项结论、为什么"}。这仅保存草稿，不发送。向人展示目标、具体内容、影响、在目标展示已批准信息及复核结论、并回传来源的范围，以及返回的“确认同步 sync_...”短句；人发该短句后才送达并让目标补充思考。不要自动批准，不要求人在目标重复确认同一范围。',
    '同步只限本群工作话题；不触碰其他群、自动通知或既有任务的执行状态。复核结果自动回来源，不能把已提交说成已采纳或已完成。需要新业务动作另提建议。',
    '本试点已经获得在本群自动新建工作话题和接续同一事项的授权；跨话题复核另按具体草稿请人确认。这一试点入口优先于通用新建Session说明。相关检索和同步建议不能阻塞当前简短答复，不为每条聊天全局扫描所有会话。路由/同步记录可通过 work context 查看。',
    JSON.stringify({ routes: state(current).routes.slice(-12).map(({ id, targetSessionId, task, reason, state, requestIds }) =>
      ({ id, targetSessionId, task: task.slice(0, 300), reason: reason.slice(0, 160), state, requestIds })),
      proposals: state(current).proposals.slice(-5).map(({ id, targetName, state, reason }) => ({ id, targetName, state, reason })), workTopics: peers }),
  ].join('\n');
}

export async function readGroupRoutingState(session) {
  if (!session.groupRouting) return null;
  const value = structuredClone(session.groupRouting);
  for (const p of value.proposals) {
    if (p.returnRunId) {
      const request = await requests.byRunId(p.returnRunId);
      p.returnDeliveryState = request?.deliveries.find(d => d.id === p.returnDeliveryId)?.state || 'unknown';
    }
    if (p.targetReturnRunId) {
      const request = await requests.byRunId(p.targetReturnRunId);
      p.targetDeliveryState = request?.deliveries.find(d => d.id === p.targetDeliveryId)?.state || 'unknown';
    }
  }
  return value;
}
export async function validateGroupRethink(record) {
  const route = record.options?.routingRethink;
  if (!route) return;
  const source = await findSessionMeta(route.sourceSessionId);
  const proposal = state(source || {}).proposals.find(p => p.id === route.proposalId);
  const target = await findSessionMeta(record.sessionId);
  if (!proposal || !['approved', 'submitted'].includes(proposal.state) || proposal.targetSessionId !== target?.id
      || target.archived || stamp(target) !== proposal.targetStamp) fail('目标讨论已变化，未执行过期复核；请根据最新内容重新确认。');
}
