// The Harness chooses semantic relationships. This module validates and stores
// their transport, admission and return contracts; it never calls a classifier.
import { createHash } from 'node:crypto';
import { routingPilotScope, routingSyncTargetAllowed, isPilotInputSinceActivation, hasPilotInputReplyContract } from '../lib/group-routing-pilot.mjs';
import { findSessionMeta, mutateSessionMeta } from './session-meta-store.mjs';
import { requests, requestKey } from './requests.mjs';
import { appendEvent, getHistorySnapshot } from './history.mjs';
import { enqueueSourceDelivery } from './source-deliveries.mjs';
import { verifiedWorkActor } from './work-awareness.mjs';
import { stripHiddenBlocks } from '../lib/reply-selection.mjs';
import { allowsMessageRouting } from './message-routing-policy.mjs';
import { publishFeishuResponse, withFeishuResponseLock as serial } from './feishu-response.mjs';
import { routingDiscovery } from './work-routing-discovery.mjs';
import { buildSessionNavigationHref } from '../lib/session-navigation.mjs';
import { groupSyncReturnPlan, syncResultPresentation, syncDecisionOutcome } from './group-sync-presentation.mjs';
import { normalizeConversation } from '../lib/conversation-target.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const fail = message => { throw new Error(message); };
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const stamp = session => session?.workAwareness?.intents?.at(-1)?.id || '';
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
async function sourceFor(record, { explicitSyncDecision = false, explicitHandoff = false, newThread = false } = {}) {
  if (record.result || record.releasedAt) fail('Only an active accepted input can route work');
  const session = await findSessionMeta(record.sessionId);
  const origin = record.deliveryPlan || record.options?.sourceDelivery;
  // Opening a reply thread is a conversation operation, not permission to
  // forward work into another existing task. Reuse the durable topic workflow.
  if (newThread && record.options?.sourceContext?.feishuThreadSessionVersion === 1) {
    if (!record.options.feishuConnectorAuthenticated
        || !verifiedWorkActor(record.options.viewPersonId, record.options.initiatedByIdentityId)
        || record.options.sourceContext.connector !== 'feishu'
        || ['app', 'bot'].includes(record.options.sourceContext.sender?.senderType)
        || record.options.internalOperation || record.options.automationTitle || record.options.routingRethink
        || session?.conversation?.target?.chatType !== 'group'
        || session.conversation.target.conversationKind !== 'main'
        || origin?.target?.conversationKind !== 'main' || !sameGroup(session.conversation, origin)) {
      fail('New reply threads require an authenticated human input in the bound group mainline');
    }
    return { session, origin, scope: { folder: session.folder, replyThread: true } };
  }
  if (explicitHandoff && record.options?.feishuConnectorAuthenticated !== true) fail('Explicit handoff requires an authenticated human Feishu input');
  if (!explicitSyncDecision && !explicitHandoff && !allowsMessageRouting(record.options)) fail('Message routing is disabled for this accepted input');
  const scope = await routingPilotScope(session?.conversation, undefined, record.options?.viewPersonId);
  if (explicitHandoff && !scope) fail('Handoff source is outside the enabled registered group scope; no transfer was made');
  if (!isPilotInputSinceActivation(scope, record.acceptedAt)
      || !isPilotInputSinceActivation(scope, record.options?.sourceContext?.createTime || record.options?.sourceContext?.eventTs)
      || !verifiedWorkActor(record.options?.viewPersonId, record.options?.initiatedByIdentityId)
      || record.options?.routingRethink || record.options?.automationTitle || record.options?.internalOperation
      || record.options?.sourceContext?.connector !== 'feishu'
      || ['app', 'bot'].includes(record.options?.sourceContext?.sender?.senderType)) fail('Routing requires a human Feishu input in the enabled pilot group');
  if (!sameGroup(session.conversation, origin)) fail('Input destination is outside the pilot group');
  if (scope.version === 2 && !explicitSyncDecision && !explicitHandoff && (record.options?.messageRoutingPolicy?.trialVersion !== 2
      || record.options.messageRoutingPolicy.trialId !== scope.trialId)) fail('This accepted input predates the personal trial');
  return { session, scope, origin };
}

// Compatibility API: routing eligibility is checked here; response ownership,
// parsing, durable reservation and publication have one shared implementation.
export async function replyGroupInput(record, body) {
  return publishFeishuResponse(record, body, { validateInput: async input => {
    const { session } = await sourceFor(input);
    if (session.conversation.target.conversationKind !== 'main') fail('Local per-input replies require the pilot mainline');
  } });
}
export { recoverPilotReplies, pilotInputResult } from './feishu-response.mjs';

export async function routeGroupWork(record, body, deps) {
  return serial(record.sessionId, async () => {
    record = await requests.get(record.key) || record;
    const mode = body.mode;
    const authorization = mode === 'handoff' && body.authorization ? handoffAuthorization(record, body.authorization) : null;
    const { session, scope, origin } = await sourceFor(record, { newThread: mode === 'new',
      explicitHandoff: mode === 'handoff' });
    if (!['new', 'continue', 'sync', 'handoff'].includes(mode)) fail('Use routing mode new, continue, sync or handoff');
    if (mode === 'handoff' && body.proposalId) {
      const p = state(session).proposals.find(p => p.id === body.proposalId && p.kind === 'task-handoff');
      if (!p || p.personId !== record.options.viewPersonId || !p.confirmationRequestId
          || !['approved', 'submitted', 'return-queued'].includes(p.state)) fail('Only an already human-approved handoff can resume');
      if (['task', 'reason', 'requestIds', 'targetSessionId', 'authorization'].some(k => body[k] !== undefined)) fail('Resume cannot change an approved packet');
      return { outcome: await acceptConfirmedHandoff(record, ['','确认转交',p.id], session, origin, deps) };
    }
    const task = clean(body.task, 6000), reason = clean(body.reason, 600);
    if (!task || !reason) fail('Explain the task and its relationship to this input');
    // Recover an identical explicit instruction before checking mutable target
    // metadata. Admission changes that metadata; it must not create a new task.
    if (authorization) {
      const old = state(session).proposals.find(p => p.kind === 'task-handoff'
        && p.authorization?.sourceRequestId === record.requestId && p.authorization.quote === authorization.quote
        && p.targetSessionId === body.targetSessionId && p.task === task && p.reason === reason
        && JSON.stringify(p.originals.map(o => o.requestId)) === JSON.stringify(body.requestIds || [record.requestId]));
      if (old) return { proposalId: old.id,
        outcome: await acceptConfirmedHandoff(record, ['', '确认转交', old.id], session, origin, deps) };
    }
    let target = body.targetSessionId ? await findSessionMeta(body.targetSessionId) : null;
    if (mode === 'handoff') {
      if (!target) fail('Handoff target Session was not found; select a concrete existing topic');
      if (target.archived || target.groupFeed || target.internalRole || target.id === session.id) fail('Handoff target is not an available separate human work topic');
      if (!await routingSyncTargetAllowed(origin, target.conversation, record.options.viewPersonId)) {
        fail('Handoff target is outside the registered Bot, tenant or group scope; no transfer was made');
      }
    }
    if (!['new', 'handoff'].includes(mode) && (!target || target.archived || target.groupFeed || target.id === session.id
        || !(['sync', 'handoff'].includes(mode) ? await routingSyncTargetAllowed(origin, target.conversation, record.options.viewPersonId)
          : sameGroup(origin, target.conversation)))) fail('Select an available work topic in this same pilot group or confirmed sync scope');
    if (mode === 'handoff') {
      const draft = await draftConfirmedHandoff(record, body, session, target, task, reason, origin, authorization);
      if (!authorization) return draft;
      return { proposalId: draft.proposal.id, outcome: await acceptConfirmedHandoff(record,
        ['', '确认转交', draft.proposal.id], await findSessionMeta(session.id), origin, deps) };
    }
    if (mode === 'sync') {
      const proposalId = 'sync_' + hash(JSON.stringify([session.id, record.requestId, target.id, task, reason]));
      const old = state(session).proposals.find(p => p.id === proposalId);
      if (old) return { proposal: old, duplicate: true };
      if (state(session).proposals.length >= 64) fail('Pilot proposal limit reached');
      const proposal = { id: proposalId, state: 'draft', sourceSessionId: session.id, sourceRequestId: record.requestId,
        sourceName: session.name, sourceStamp: stamp(session), targetSessionId: target.id, targetName: target.name, targetStamp: stamp(target),
        task, reason, personId: record.options.viewPersonId, createdAt: new Date().toISOString() };
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
      if (!input || input.result || input.mainlineReply || input.options?.routingRethink || input.options?.automationTitle
          || !(scope.replyThread ? input.options?.feishuConnectorAuthenticated
            && input.options?.sourceContext?.feishuThreadSessionVersion === 1
            : allowsMessageRouting(input.options))
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
    const root = await requests.byRunId(record.nativeDispatchRunId || record.runId);
    if (root?.mainlineReplyPlans?.some(reply => reply.requestIds.some(id => ids.includes(id)))) {
      fail('A reserved local reply already owns this input');
    }
    const old = state(session).routes.find(route => route.requestIds.includes(record.requestId));
    if (old) {
      if (body.targetSessionId && old.targetSessionId !== body.targetSessionId) fail('This input already belongs to another work topic');
      target = await findSessionMeta(old.targetSessionId);
      if (!target || target.archived) fail('Previously selected topic is unavailable');
    } else if (mode === 'new') {
      if (session.conversation.target.conversationKind !== 'main') fail('New topics start from the group mainline; continue the current topic directly');
      if (!scope.replyThread && state(session).routes.length >= 64) fail('Pilot topic limit reached');
      const first = inputs[0], source = first.deliveryPlan || first.options.sourceDelivery;
      if (!source.target.messageId) fail('Source message anchor is required');
      const conversation = { ...source, target: { ...source.target, conversationKind: 'thread',
        rootId: source.target.messageId, replyInThread: true, sourceKind: 'group_routing_work' } };
      delete conversation.target.threadId; delete conversation.target.topicId;
      for (const key of ['participationEpoch', 'participationScopeTopicId', 'participationScopeMessageId']) delete conversation.target[key];
      const manager = await api(deps);
      target = await manager.createSession(scope.folder, record.runtimeSelection?.tool || session.tool,
        clean(body.name, 100) || task.slice(0, 60), { ...record.runtimeSelection,
          sourceId: 'feishu', conversation, systemPrompt: scope.replyThread ? session.systemPrompt || '' : contract,
          initiatedByIdentityId: record.options.initiatedByIdentityId, viewPersonId: record.options.viewPersonId,
          externalTriggerId: 'routing-pilot:' + hash(JSON.stringify([source.sourceRouteId, source.target.chatId, source.target.messageId])) });
    }
    const route = old || { id: 'route_' + hash(record.requestId), requestIds: ids, targetSessionId: target.id,
      task, reason, state: 'reserved', createdAt: new Date().toISOString() };
    if (old && JSON.stringify(old.requestIds) !== JSON.stringify(ids)) fail('Retry must preserve the reserved input set');
    if (!old) await save(session.id, data => data.routes.push(route)); // reserve before starting any work
    const manager = await api(deps), receipts = [], feedbackWarnings = [];
    for (const input of inputs) {
      const claimed = await requests.mutate(input.key, current => {
        if (current.mainlineReply) fail('A local reply decision already owns this input');
        if (current.routingHandoff && current.routingHandoff.targetSessionId !== target.id) fail('Input already handed to another topic');
        if (current.deliveries?.some(d => ['content', 'attachment'].includes(d.kind))) fail('A visible reply already owns this input; do not move it silently');
        return { ...current, routingHandoff: { targetSessionId: target.id, routeId: route.id },
          options: { ...current.options, suppressSourceDelivery: true } };
      });
      const delivery = workDeliveryPlan(target.conversation, origin);
      const options = { requestId: 'routed:' + input.requestId,
        feishuConnectorAuthenticated: input.options.feishuConnectorAuthenticated === true,
        ...record.runtimeSelection, viewPersonId: input.options.viewPersonId,
        initiatedByIdentityId: input.options.initiatedByIdentityId,
        sourceContext: { ...input.options.sourceContext, feishuParticipation: undefined,
          ...(scope.replyThread ? { feishuThreadSessionVersion: undefined, feishuReplyPlacementVersion: undefined,
            conversationKind: 'thread', rootId: delivery.target.rootId, topicId: delivery.target.rootId } : {}),
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
      if (scope.replyThread) continue; // Normal input feedback keeps its existing optional reaction policy.
      // The task has been admitted elsewhere. A separate durable receipt still
      // belongs on EACH original message, even when its mainline body is muted.
      try {
        const feedback = await (deps?.enqueueSourceDelivery || enqueueSourceDelivery)({
          sessionId: session.id, responseId: `feishu-routing-receipt:${input.requestId}`,
          reaction: 'Get', reactionStage: 2,
          sourceDelivery: input.deliveryPlan || input.options.sourceDelivery,
        });
        await requests.mutate(input.key, current => ({ ...current, routingHandoff: {
          ...current.routingHandoff, receiptDeliveryId: feedback.id, feedbackError: null } }));
      } catch (error) {
        feedbackWarnings.push({ requestId: input.requestId, error: error.message });
        await requests.mutate(input.key, current => ({ ...current, routingHandoff: {
          ...current.routingHandoff, feedbackError: error.message } }));
      }
    }
    await save(session.id, data => { const current = data.routes.find(r => r.id === route.id); current.state = 'submitted'; });
    await appendEvent(session.id, { type: 'work_event', action: 'routing-handoff', route, receipts });
    return { targetSessionId: target.id, route, receipts, feedbackWarnings,
      instruction: 'Work owns its topic replies. Do not repeat a body reply in the group mainline. Each input receipt remains separate.' };
  });
}

// A reviewed task transfer is separate from reference-only sync. Its immutable
// packet survives the source turn ending; only a later verified human decides.
const targetVersion = s => hash(JSON.stringify([s?.name, s?.conversation, s?.archived, stamp(s),
  s?.workSummary?.goal, (s?.workAwareness?.works || []).map(w => [w.id, w.version, w.status])]));
const inputVersion = r => hash(JSON.stringify([r.text, r.images, r.options?.viewPersonId, r.options?.initiatedByIdentityId]));
function handoffAuthorization(record, value) {
  // The Harness interprets the instruction. Code binds its evidence to the
  // actual current human input; a flag, invented quote or another run cannot consent.
  const quote = clean(value?.quote, 6000);
  if (value?.sourceRequestId !== record.requestId || !quote || !record.text.includes(quote)) {
    fail('Explicit handoff needs authorization.sourceRequestId and an exact quote from that accepted human instruction');
  }
  return { sourceRequestId: record.requestId, quote, personId: record.options?.viewPersonId,
    identityId: record.options?.initiatedByIdentityId };
}
async function draftConfirmedHandoff(record, body, session, target, task, reason, origin, authorization) {
  if (target.internalRole || !['thread', 'topic'].includes(target.conversation?.target?.conversationKind)) fail('Select an existing human work topic');
  const ids = body.requestIds || [record.requestId];
  if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length) fail('Select 1–8 distinct original input IDs');
  const inputs = await Promise.all(ids.map(id => requests.byRequest(session.id, id)));
  for (const r of inputs) {
    if (!r || r.options?.viewPersonId !== record.options.viewPersonId
        || !verifiedWorkActor(r.options.viewPersonId, r.options.initiatedByIdentityId)
        || r.options.sourceContext?.connector !== 'feishu' || r.options.routingSource
        || r.options.automationTitle || r.options.internalOperation || r.options.routingRethink
        || ['app', 'bot'].includes(r.options.sourceContext?.sender?.senderType)
        || !sameGroup(origin, r.deliveryPlan || r.options.sourceDelivery) || r.routingHandoff) fail('Original human input is unavailable for transfer');
  }
  if (inputs.reduce((n, r) => n + r.text.length, 0) > 24000) fail('Select a smaller original input set (maximum 24000 characters)');
  const originals = inputs.map(r => ({ requestId: r.requestId, version: inputVersion(r), text: r.text,
    author: verifiedWorkActor(r.options.viewPersonId, r.options.initiatedByIdentityId),
    sourceContext: r.options.sourceContext, sourceDelivery: r.deliveryPlan || r.options.sourceDelivery,
    attachments: (r.images || []).map(i => ({ name: i.name || i.filename || i.originalName || '附件', id: i.assetId || i.id || i.path })) }));
  const id = 'handoff_' + hash(JSON.stringify([session.id, record.requestId, target.id, targetVersion(target), task, reason, originals, authorization]));
  const old = state(session).proposals.find(p => p.id === id);
  if (old) return handoffPreview(old);
  if (state(session).proposals.length >= 64) fail('Pilot proposal limit reached');
  const { catalog } = await routingDiscovery(session, record.options.viewPersonId);
  const group = catalog.find(g => g.route === target.conversation.sourceRouteId && g.chatId === target.conversation.target.chatId);
  const latestWork = [...(target.workAwareness?.works || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const snapshot = await getHistorySnapshot(target.id, { metadataOnly: true });
  const proposal = { id, kind: 'task-handoff', state: 'draft', sourceSessionId: session.id,
    sourceRequestId: record.requestId, sourceName: session.name, personId: record.options.viewPersonId,
    targetSessionId: target.id, targetName: target.name, targetGroup: group?.name || target.conversation.target.chatId,
    targetStatus: latestWork?.status || '未确认，需结合原话题判断', targetLastInputAt: snapshot.lastUserMessageAt || null,
    targetVersion: targetVersion(target), task, reason, originals, ...(authorization ? { authorization } : {}),
    createdAt: new Date().toISOString() };
  await save(session.id, data => data.proposals.push(proposal));
  await appendEvent(session.id, { type: 'work_event', action: 'routing-handoff-draft', proposal });
  return handoffPreview(proposal);
}
function handoffPreview(p) {
  const preview = `转交单 ${p.id.slice(-8)}\n将转交到：${p.targetGroup} / ${p.targetName}\n目标：${buildSessionNavigationHref(p.targetSessionId)}\n记录状态：${p.targetStatus}\n最近输入时间：${p.targetLastInputAt ? new Date(p.targetLastInputAt).toISOString() : '未知'}（不代表仍在进行）\n请对方处理：${p.task}\n转交理由：${p.reason}\n转交的原文：\n${p.originals.map(o => o.text + (o.attachments.length ? '\n附件：' + o.attachments.map(a => a.name).join('、') : '')).join('\n\n')}\n\n确认后才发送以上内容及附件，目标将在该话题处理限定任务，处理结果回到这里。未确认或发送失败时仍由这里说明情况。`;
  return { proposal: p, confirmation: '确认转交 ' + p.id, rejection: '拒绝转交 ' + p.id, preview,
    question: { title: preview, options: ['确认转交', '暂不转交'] } };
}
// Bind a plain-language button to the exact server-produced preview. No draft
// ID, arbitrary agent flag, or inferred "yes" can substitute for this display.
export function routingQuestionDecision(session, question, values) {
  if (values.length !== 1) return '';
  const text = values[0];
  if (!['确认转交', '暂不转交'].includes(text)) return syncDecisionText({ text }) ? text : '';
  const candidates = state(session).proposals.filter(p => p.kind === 'task-handoff'
    && p.state === 'draft' && handoffPreview(p).preview === question?.question);
  if (candidates.length !== 1) return '';
  return (text === '确认转交' ? '确认转交 ' : '拒绝转交 ') + candidates[0].id;
}
async function acceptConfirmedHandoff(record, decision, session, origin, deps) {
  const p = state(session).proposals.find(p => p.id === decision[2] && p.kind === 'task-handoff');
  if (!p || p.personId !== record.options.viewPersonId) fail('Only the original requester can confirm this handoff draft');
  if (p.state === 'draft' && p.sourceRequestId === record.requestId
      && p.authorization?.sourceRequestId !== record.requestId) fail('Handoff requires a subsequent human decision');
  if (['submitted', 'return-queued'].includes(p.state)) {
    await handoffAdmissionReceipt(p, deps);
    return `已转交到 ${p.targetGroup} / ${p.targetName}，不会重复发送。`;
  }
  if (!['draft', 'approved'].includes(p.state)) fail('This handoff is no longer awaiting confirmation');
  if (decision[1] === '拒绝转交') {
    if (p.state !== 'draft') fail('Already approved; check admission before changing this transfer');
    await save(session.id, d => Object.assign(d.proposals.find(v => v.id === p.id), { state: 'rejected', confirmationRequestId: record.requestId }));
    return '已取消这条转交，内容仍留在原话题。';
  }
  const target = await findSessionMeta(p.targetSessionId);
  const prior = await requests.byRequest(p.targetSessionId, 'routing-handoff:' + p.id);
  if (prior && (prior.options?.confirmedHandoff?.sourceSessionId !== session.id
      || prior.options.confirmedHandoff.proposalId !== p.id || prior.options.viewPersonId !== p.personId)) fail('Existing admission does not match this approved handoff');
  // Admission itself changes the destination's intent stamp. After a lost
  // acknowledgement, recover the durable receipt instead of rejecting our own
  // change or scheduling the task again. Fresh submissions still revalidate.
  if (!prior && (!target || target.archived || target.groupFeed || targetVersion(target) !== p.targetVersion
      || !await routingSyncTargetAllowed(origin, target.conversation, record.options.viewPersonId))) fail('目标或可转交范围已变化，尚未转交；请重新核对并确认。');
  const inputs = await Promise.all(p.originals.map(o => requests.byRequest(session.id, o.requestId)));
  for (let i = 0; i < inputs.length; i++) {
    const r = inputs[i];
    if (!r || inputVersion(r) !== p.originals[i].version
        || (r.routingHandoff && r.routingHandoff.routeId !== p.id)) fail('Original input changed or already transferred; review a fresh draft');
  }
  const packet = { ...p, state: 'approved', confirmationRequestId: p.confirmationRequestId || record.requestId,
    approvedAt: p.approvedAt || new Date().toISOString(),
    returnPlan: p.returnPlan || origin };
  await save(session.id, d => {
    const current = d.proposals.find(v => v.id === p.id);
    if (['draft', 'approved'].includes(current.state)) Object.assign(current, packet);
  });
  for (const r of inputs) await requests.mutate(r.key, current => {
    if (current.routingHandoff && current.routingHandoff.routeId !== p.id) fail('Original input already belongs to another transfer');
    return { ...current, routingHandoff: { targetSessionId: p.targetSessionId, routeId: p.id, state: 'reserved' } };
  });
  const manager = await api(deps);
  // Cross-group delivery must use the destination's participation scope, never
  // copy the source group's epoch onto a different group.
  const delivery = structuredClone(target?.conversation || prior.deliveryPlan || prior.options.sourceDelivery);
  for (const k of ['participationEpoch', 'participationScopeTopicId', 'participationScopeMessageId']) delete delivery.target[k];
  const first = inputs[0];
  const options = { requestId: 'routing-handoff:' + p.id,
    viewPersonId: first.options.viewPersonId, initiatedByIdentityId: first.options.initiatedByIdentityId,
    feishuConnectorAuthenticated: first.options.feishuConnectorAuthenticated === true,
    sourceDelivery: delivery, preSavedAttachments: inputs.flatMap(r => r.images || []),
    // Original provenance remains in routingSource and the immutable packet.
    // This is a confirmed handoff, not a new Feishu message in the source group.
    sourceContext: { connector: 'routing-handoff', sourceRouteId: delivery.sourceRouteId,
      chatId: delivery.target.chatId, sourceSessionId: session.id, sourceRequestId: first.requestId },
    routingSource: { sessionId: session.id, requestId: first.requestId, routeId: p.id },
    confirmedHandoff: { sourceSessionId: session.id, proposalId: p.id,
      authorization: p.authorization || { sourceRequestId: packet.confirmationRequestId, kind: 'confirmed-draft' },
      originals: p.originals.map(({ requestId, author, sourceContext, sourceDelivery }) => ({ requestId, author, sourceContext, sourceDelivery })) },
    tool: target?.tool, model: target?.model, effort: target?.effort };
  const text = `原作者已确认将误发内容转交到本话题。\n限定任务：${p.task}\n理由：${p.reason}\n来源：${session.id}；确认输入：${packet.confirmationRequestId}\n仅承接这项已确认交办；原话题其他工作不变。结果在本话题答复，系统会回传来源，请勿重复发送。\n\n${inputs.map(r => `原输入 ${r.requestId}：\n${r.text}`).join('\n\n')}`;
  let receipt;
  try { receipt = prior ? { requestId: prior.requestId, run: { id: prior.runId } }
    : await manager.submitHttpMessage(p.targetSessionId, text, [], options); }
  catch (error) {
    await save(session.id, d => Object.assign(d.proposals.find(v => v.id === p.id), {
      lastError: error.message, lastAttemptAt: new Date().toISOString() }));
    if (!await requests.byRequest(p.targetSessionId, options.requestId)) {
      for (const r of inputs) await requests.mutate(r.key, current => {
        if (current.routingHandoff?.routeId !== p.id) return current;
        const next = { ...current }; delete next.routingHandoff; return next;
      });
    }
    throw error;
  }
  for (const r of inputs) await requests.mutate(r.key, current => ({ ...current,
    routingHandoff: { ...current.routingHandoff, state: 'submitted', targetRequestId: receipt.requestId } }));
  await save(session.id, d => {
    const current = d.proposals.find(v => v.id === p.id);
    Object.assign(current, { ...(current.state === 'approved' ? { state: 'submitted' } : {}),
      targetRequestId: receipt.requestId, runId: receipt.run.id,
      submittedAt: current.submittedAt || new Date().toISOString(), lastError: null });
  });
  await appendEvent(session.id, { type: 'work_event', action: 'routing-handoff-submitted', proposalId: p.id, receipt });
  await handoffAdmissionReceipt(packet, deps);
  return '转交已受理，接收回执已排入原话题；这不表示业务已经完成。';
}
async function handoffAdmissionReceipt(p, deps) {
  let receipt;
  try {
    receipt = await (deps?.enqueueSourceDelivery || enqueueSourceDelivery)({ sessionId: p.sourceSessionId,
      responseId: 'routing-handoff-receipt:' + p.id, sourceDelivery: p.returnPlan,
      text: `已按你的确认转交到 ${p.targetGroup} / ${p.targetName}，目标已接收，处理结果会回到这里。\n${buildSessionNavigationHref(p.targetSessionId)}` });
  } catch (error) {
    await save(p.sourceSessionId, d => Object.assign(d.proposals.find(v => v.id === p.id), { receiptError: error.message }));
    throw error;
  }
  await save(p.sourceSessionId, d => Object.assign(d.proposals.find(v => v.id === p.id), {
    admissionDeliveryId: receipt.id, admissionRunId: receipt.runId, receiptError: null }));
}
async function completeConfirmedHandoff(record, run) {
  const route = record.options.confirmedHandoff;
  const source = await findSessionMeta(route.sourceSessionId);
  const p = state(source || {}).proposals.find(p => p.id === route.proposalId);
  if (!p || p.state === 'return-queued') return;
  await handoffAdmissionReceipt(p);
  const result = clean(record.result?.payload?.text, 12000);
  const success = record.result?.state === 'completed';
  const receipt = await enqueueSourceDelivery({ sessionId: source.id, responseId: 'routing-handoff-return:' + p.id,
    sourceDelivery: p.returnPlan,
    text: `【转交处理${success ? '结果' : '未完成'}】${p.targetGroup} / ${p.targetName}\n${result || record.result?.error || '未返回可用结论，请查看目标话题。'}\n${buildSessionNavigationHref(p.targetSessionId)}` });
  await save(source.id, d => Object.assign(d.proposals.find(v => v.id === p.id), {
    state: 'return-queued', result, resultState: record.result?.state, returnDeliveryId: receipt.id, returnRunId: receipt.runId, runId: run.id }));
}

export function syncDecisionText(record) {
  let text = String(record.options?.routingDecisionText || record.text || '').trim();
  if (record.options?.sourceContext?.connector === 'feishu') {
    text = text.replace(/^\[群参与状态：[^\n]*\]\n/, '').replace(/^【飞书群消息｜发言人：[^\n]*】\n/, '').trim();
  }
  return text.match(/^(确认同步|拒绝同步)\s+(sync_[a-f0-9]{20})$/)
    || text.match(/^(确认转交|拒绝转交)\s+(handoff_[a-f0-9]{20})$/);
}
export async function acceptGroupSync(record, deps) {
  const decision = syncDecisionText(record);
  if (!decision) return '';
  return serial(record.sessionId, async () => {
    // A callback retry can arrive after its owning native turn has completed.
    // Return only an existing outcome; terminal records cannot approve new work.
    if (record.result || record.releasedAt) {
      const saved = await findSessionMeta(record.sessionId);
      const prior = state(saved || {}).proposals.find(p => p.id === decision[2]);
      if (prior?.confirmationRequestId === record.requestId && prior.personId === record.options?.viewPersonId
          && ['submitted', 'return-queued', 'rejected'].includes(prior.state)) return decision[2].startsWith('handoff_')
            ? '转交决定已处理，不会重复执行。' : syncDecisionOutcome(prior);
    }
    // Confirming or rejecting an existing specific draft is an explicit action,
    // independent of whether automatic routing is now enabled for the sender.
    const { session, origin } = await sourceFor(record, { explicitSyncDecision: true });
    if (decision[2].startsWith('handoff_')) return acceptConfirmedHandoff(record, decision, session, origin, deps);
    const proposal = state(session).proposals.find(p => p.id === decision[2]);
    if (!proposal) fail('Sync proposal is not in this conversation');
    if (proposal.personId && proposal.personId !== record.options.viewPersonId) fail('Only the proposal requester can confirm this personal trial');
    if (proposal.confirmationRequestId === record.requestId && proposal.state !== 'draft') {
      if (proposal.state === 'approved') return dispatchGroupSync(proposal, await findSessionMeta(proposal.targetSessionId), record, deps);
      return syncDecisionOutcome(proposal);
    }
    if (proposal.state !== 'draft') fail('This proposal is no longer awaiting confirmation');
    if (decision[1] === '拒绝同步') {
      await save(session.id, d => Object.assign(d.proposals.find(p => p.id === proposal.id),
        { state: 'rejected', confirmationRequestId: record.requestId }));
      return '已取消本条同步。';
    }
    const target = await findSessionMeta(proposal.targetSessionId);
    if (!target || target.archived || target.groupFeed || !await routingSyncTargetAllowed(origin, target.conversation, record.options.viewPersonId)
        || stamp(target) !== proposal.targetStamp || stamp(session) !== proposal.sourceStamp) fail('Discussion changed; review a fresh sync proposal');
    const packet = { ...proposal, confirmationRequestId: record.requestId, state: 'approved',
      returnPlan: await groupSyncReturnPlan(record, proposal, requests), targetPlan: workDeliveryPlan(target.conversation, origin),
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
  return syncDecisionOutcome({ ...packet, state: 'submitted' });
}

async function enqueueSyncResult(input) {
  // A crash can happen after outbox admission and before the proposal receipt.
  // Reuse that exact committed payload, including pre-upgrade presentations.
  const plan = normalizeConversation(input.sourceDelivery);
  const id = `outbound:${input.responseId}:${requestKey(plan.sourceRouteId, JSON.stringify(plan.target))}`;
  const prior = await requests.byRequest(input.sessionId, id);
  return prior?.deliveries[0] || enqueueSourceDelivery(input);
}
export async function completeGroupSync(record, run) {
  if (record?.options?.confirmedHandoff) return completeConfirmedHandoff(record, run);
  const route = record?.options?.routingRethink;
  if (!route) return;
  const source = await findSessionMeta(route.sourceSessionId);
  const packet = state(source || {}).proposals.find(p => p.id === route.proposalId);
  if (!packet || packet.state === 'return-queued') return;
  const success = record.result?.state === 'completed';
  const result = stripHiddenBlocks(record.result?.payload?.text || '').trim();
  const failureNotice = '目标未完成复核：' + (record.result?.error || '执行已停止，请查看原工作话题。');
  const body = success ? result || '目标已结束，但没有返回可用结论。'
    : [failureNotice, result].filter(Boolean).join('\n\n');
  const foldedDetails = syncResultPresentation(packet, success ? body : failureNotice, { failed: !success });
  const text = `【${foldedDetails.title}】\n来自：${packet.targetName}\n\n${body}`
    + (foldedDetails.url ? `\n\n[查看原工作话题](${foldedDetails.url})` : '');
  // Publish the approved information with the reconsideration in its owning
  // topic. Keep this separate from the model's ordinary reply stream so a
  // failed/stale review cannot announce that reference as adopted.
  const targetReceipt = success ? await enqueueSyncResult({ sessionId: packet.targetSessionId,
    responseId: 'routing-reviewed:' + packet.id,
    text: `【经确认同步的复核】\n来源：${packet.sourceName || '来源对话'}\n同步信息与问题：${packet.task}\n影响：${packet.reason}\n\n${result || '未返回可用结论。'}`,
    foldedDetails,
    sourceDelivery: packet.targetPlan }) : null;
  const receipt = await enqueueSyncResult({ sessionId: source.id, responseId: 'routing-return:' + packet.id,
    text, foldedDetails, sourceDelivery: packet.returnPlan });
  await save(source.id, data => Object.assign(data.proposals.find(p => p.id === packet.id),
    { state: 'return-queued', result, resultState: record.result?.state, returnDeliveryId: receipt.id, returnRunId: receipt.runId, targetDeliveryId: targetReceipt?.id, targetReturnRunId: targetReceipt?.runId, runId: run.id }));
  await appendEvent(source.id, { type: 'work_event', action: 'routing-sync-result', proposalId: packet.id,
    targetSessionId: packet.targetSessionId, result, deliveryId: receipt.id });
}
export async function buildGroupRoutingContext(session, sourceContext, { inputReplyContract = false, messageRoutingPolicy } = {}) {
  if (sourceContext?.feishuThreadSessionVersion === 1 && session.conversation?.target?.conversationKind === 'main') {
    return [
      '## 新回复话题与独立 Session',
      '群主线默认在本 Session 处理并 inline 回复。用户明确另开话题，或工作确需独立保存上下文、推进和续接时，使用现有 work route 的 mode:new 创建当前消息的 thread 和独立 Session，再由目标 Session 承担工作与回复。使用工具、问题长短和执行耗时本身不构成拆分理由。已有 thread/话题中的补充、纠正、追加工作及完成后的追问，直接在其绑定 Session 继续。',
      '调用 node "$REMOTELAB_PROJECT_ROOT/cli.js" work route --file <JSON绝对路径> --json，JSON: {sourceRequestId:"本条已接受的Request ID",mode:"new",task:"原问题、必要上下文与交付要求",reason:"需要独立话题展开",name:"话题名"}。可用 requestIds 合并本轮已接受的相关补充。保留原问题和附件，不重复执行已经完成的动作。',
      '创建和提交成功后由目标话题回复，主线结束当前输入，不重复开场、答案或会话入口。失败留在原处说明；未知结果按原请求重试，不另建话题。本入口仅允许为当前输入新开 thread，不授权向其他现有 Session 分流或同步。replyMode:thread 本身不再代替创建 Session。',
    ].join('\n');
  }
  if (sourceContext?.connector !== 'feishu' || sourceContext.chatType !== 'group'
      || session.conversation?.connector !== 'feishu') return '';
  return [
    '## 主动分流试用已撤回',
    '在当前话题接续工作，不沿用历史中的主动误发识别、自动分流或主线 work reply 指令。并行分工仅按本条独立的并行设置与人的授权执行。正常话题回复和用户明确要求的新话题不受影响。',
    '用户明确要求转交且内容、目标已确定时，仍可用 work route handoff 并携带本条指令的 authorization；已批准草稿可按 proposalId 恢复。保留登记范围、身份和实际投递核验，不自行扩权。',
  ].join('\n');
}

export async function readGroupRoutingState(session) {
  if (!session.groupRouting) return null;
  const value = structuredClone(session.groupRouting);
  for (const p of value.proposals) {
    if (p.admissionRunId) {
      const request = await requests.byRunId(p.admissionRunId);
      p.admissionDeliveryState = request?.deliveries.find(d => d.id === p.admissionDeliveryId)?.state || 'unknown';
    }
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
  if (record.options?.confirmedHandoff) {
    const route = record.options.confirmedHandoff;
    const source = await findSessionMeta(route.sourceSessionId);
    const p = state(source || {}).proposals.find(p => p.id === route.proposalId);
    const target = await findSessionMeta(record.sessionId);
    if (!p || p.kind !== 'task-handoff' || !['approved', 'submitted'].includes(p.state)
        || !p.confirmationRequestId || p.targetSessionId !== target?.id || target.archived
        || !await routingSyncTargetAllowed(p.returnPlan, target.conversation, p.personId)) fail('已确认转交的范围不再有效，任务未执行。');
    return;
  }
  const route = record.options?.routingRethink;
  if (!route) return;
  const source = await findSessionMeta(route.sourceSessionId);
  const proposal = state(source || {}).proposals.find(p => p.id === route.proposalId);
  const target = await findSessionMeta(record.sessionId);
  if (!proposal || !['approved', 'submitted'].includes(proposal.state) || proposal.targetSessionId !== target?.id
      || target.archived || stamp(target) !== proposal.targetStamp) fail('目标讨论已变化，未执行过期复核；请根据最新内容重新确认。');
}
