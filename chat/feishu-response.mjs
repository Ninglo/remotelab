import { requests, appendDeliveries } from './requests.mjs';
import { appendEvent } from './history.mjs';
import { buildReplyDeliveries, isFinalAnswerDelivery } from '../lib/reply-deliveries.mjs';
import { readFeishuResponseDecision, normalizeFeishuResponsePayload, validateFeishuResponseFields, hasFeishuInputReplyContract } from '../lib/feishu-response-decision.mjs';
import { resolveAmbientFeishuReplyPlan, requiresFeishuReplyPlacement } from './ambient-feishu-reply.mjs';

const fail = message => { throw new Error(message); };
const queues = new Map();
export async function withFeishuResponseLock(id, fn) {
  const prior = queues.get(id) || Promise.resolve();
  const current = prior.catch(() => {}).then(fn); queues.set(id, current);
  try { return await current; } finally { if (queues.get(id) === current) queues.delete(id); }
}
const sameGroup = (a, b) => a?.connector === 'feishu' && b?.connector === 'feishu'
  && a.sourceRouteId === b.sourceRouteId && a.target?.chatId === b.target?.chatId
  && a.target?.tenantKey === b.target?.tenantKey;
const hasAnswerDelivery = input => input.deliveries?.some(isFinalAnswerDelivery);
// The root also indexes finals owned by other inputs in the same native run.
// Only legacy/unassigned streamed finals occupy this input's reply slot.
const hasUnassignedFinal = input => input.streamedFinalReplyIds?.some(
  id => !input.responseDecisionMessageIds?.includes(id));

async function commitInputReply(input, reply, store = requests) {
  return store.mutate(input.key, current => {
    if (current.mainlineReply) {
      if (JSON.stringify(current.mainlineReply.contract) !== JSON.stringify(reply)) fail('Retry must preserve the input set and reply');
      return current;
    }
    if (current.result || current.routingHandoff || hasUnassignedFinal(current)
        || hasAnswerDelivery(current)) fail('Input is no longer available for a local reply');
    const plans = input.requestId === reply.ownerRequestId
      ? buildReplyDeliveries(reply.deliveryPlan || input.deliveryPlan || input.options.sourceDelivery,
        normalizeFeishuResponsePayload(reply.payload), { running: false,
          reactionPlan: input.deliveryPlan || input.options.sourceDelivery }).map(part => ({ ...part,
          ...(reply.providerMessageId ? { providerMessageId: reply.providerMessageId, surfaceKind: 'final' } : {}) })) : [];
    return { ...current, options: { ...current.options, suppressSourceDelivery: true },
      mainlineReply: { contract: reply, queuedAt: new Date().toISOString() },
      deliveries: appendDeliveries(current, plans) };
  });
}

// The validated packet is reserved on the root before any member is written.
// Terminal recovery completes an interrupted combined reply without losing its
// remaining input markers or publishing its owner twice.
export async function recoverPilotReplies(root, store = requests) {
  for (const reply of root.mainlineReplyPlans || []) {
    for (const id of reply.requestIds) {
      const input = await store.byRequest(root.sessionId, id);
      if (!input || (input.nativeDispatchRunId || input.runId) !== root.runId) fail('Reserved reply input is unavailable');
      await commitInputReply(input, reply, store);
    }
  }
  return await store.get(root.key) || root;
}

// A local answer is owned by the selected accepted inputs, not the root Run.
// Persist the packet before its per-input outbox parts; replay cannot send twice.
export async function publishFeishuResponse(record, body, { store = requests, validateInput, preparedPayload, providerMessageId } = {}) {
  return withFeishuResponseLock(record.sessionId, async () => {
    record = await store.get(record.key) || record;
    const session = { id: record.sessionId };
    const origin = record.deliveryPlan || record.options?.sourceDelivery;
    if (validateInput) await validateInput(record);
    if (!hasFeishuInputReplyContract(record) || origin?.connector !== 'feishu') {
      fail('Local per-input replies require the Feishu response protocol');
    }
    const decision = readFeishuResponseDecision(body.text);
    if (decision.error) fail(decision.error);
    body = { ...decision, ...body };
    const fields = Object.fromEntries(['replyMode', 'requestIds', 'reaction', 'noTextReason', 'participationReason']
      .filter(key => body[key] !== undefined).map(key => [key, body[key]]));
    validateFeishuResponseFields(fields);
    const text = decision.text;
    const noTextReason = body.noTextReason?.trim() || '';
    const reaction = body.reaction;
    if ((!preparedPayload && text.length > 12000) || (!text && !noTextReason && reaction === undefined && !preparedPayload?.attachments?.length)) fail('Provide reply text (tool replies allow up to 12000 characters) or a reason no text is needed');
    if ((text || preparedPayload?.attachments?.length) && noTextReason) fail('Select a text reply or a no-text decision');
    const ids = body.requestIds || [record.requestId];
    if (!ids.includes(record.requestId)) fail('Response input IDs must include the current input');
    const inputs = await Promise.all(ids.map(id => store.byRequest(session.id, id)));
    const payload = normalizeFeishuResponsePayload({ ...(preparedPayload || {}), text,
      attachments: preparedPayload?.attachments || [], ...(reaction !== undefined ? { reaction, reactionStage: 2 } : {}) });
    const root = await store.byRunId(record.nativeDispatchRunId || record.runId);
    if (!root || root.result) fail('Active Feishu execution is required');
    if (body.replyMode !== undefined && !['inline', 'thread'].includes(body.replyMode)) fail('replyMode must be inline or thread');
    const ownerPlan = inputs[0]?.deliveryPlan || inputs[0]?.options?.sourceDelivery;
    const deliveryPlan = resolveAmbientFeishuReplyPlan(root, ownerPlan,
      [{ type: 'message', role: 'assistant', content: body.replyMode
        ? `<private>feishu-response:${JSON.stringify({ replyMode: body.replyMode })}</private>${text}` : text }]);
    if ((text || payload.attachments.length) && !deliveryPlan) fail('Choose replyMode inline or thread before sending a reply; related inputs may share requestIds');
    // A pre-upgrade reservation keeps its exact retry contract and destination.
    const reserved = root.mainlineReplyPlans?.find(item => item.requestIds.some(id => ids.includes(id)));
    const legacyReservation = reserved && !Object.hasOwn(reserved, 'deliveryPlan') && body.replyMode === undefined;
    const reply = { requestIds: ids, ownerRequestId: ids[0], payload,
      ...(providerMessageId ? { providerMessageId } : {}),
      ...((deliveryPlan || ownerPlan) && !legacyReservation ? { deliveryPlan: deliveryPlan || ownerPlan } : {}), ...(noTextReason ? { noTextReason } : {}),
      ...(body.participationReason ? { participationReason: body.participationReason } : {}) };
    for (const input of inputs) {
      if (!input || !hasFeishuInputReplyContract(input)
          || (input.nativeDispatchRunId || input.runId) !== (record.nativeDispatchRunId || record.runId)) {
        fail('Source input does not belong to this active Feishu execution');
      }
      if (validateInput) await validateInput(input);
      const source = { origin: input.deliveryPlan || input.options?.sourceDelivery };
      if (input.options?.nativeQuestionId || input.options?.internalOperation || input.options?.workReference
          || (input.nativeDispatchRunId && input.nativeReceipt?.accepted !== true)
          || input.result || input.releasedAt || input.options?.sourceContext?.connector !== 'feishu'
          || ['app', 'bot'].includes(input.options?.sourceContext?.sender?.senderType)) fail('Only accepted human inputs can own a response');
      if (!sameGroup(origin, source.origin) || input.routingHandoff
          || (input.mainlineReply && JSON.stringify(input.mainlineReply.contract) !== JSON.stringify(reply))
          || (!input.mainlineReply && (hasUnassignedFinal(input)
            || hasAnswerDelivery(input)))) {
        fail('Input already has a different reply or handoff');
      }
    }
    await store.mutate(root.key, current => {
      if (current.result) fail('Active Feishu execution is required');
      const prior = (current.mainlineReplyPlans || []).filter(p => p.requestIds.some(id => ids.includes(id)));
      if (prior.length && (prior.length !== 1 || JSON.stringify(prior[0]) !== JSON.stringify(reply))) {
        fail('Input already has a different reserved reply');
      }
      return prior.length ? current : { ...current,
        ...((text || payload.attachments.length) && deliveryPlan && (body.replyMode || requiresFeishuReplyPlacement(root))
          ? { replyPlacement: current.replyPlacement || deliveryPlan } : {}),
        mainlineReplyPlans: [...(current.mainlineReplyPlans || []), reply] };
    });
    const receipts = [];
    for (const input of inputs) {
      const saved = await commitInputReply(input, reply, store);
      receipts.push({ requestId: saved.requestId, deliveryIds: saved.deliveries.map(d => d.id) });
    }
    if (inputs.some(input => !input.mainlineReply)) await appendEvent(session.id, {
      type: 'work_event', action: 'mainline-input-reply', requestIds: ids, ownerRequestId: ids[0], receipts });
    return { requestIds: ids, receipts, state: text || reaction || payload.attachments.length ? 'queued' : 'recorded', scope: 'Input reply decision recorded; delivery and business completion are separate.' };
  });
}

export function pilotInputResult(record, run) {
  if (record.mainlineReply) return { state: 'completed', payload: record.mainlineReply.contract.payload,
    executionRunId: run.id, executionState: run.state, replyOwnerRequestId: record.mainlineReply.contract.ownerRequestId };
  if (record.routingHandoff?.state === 'submitted') return { state: 'completed', payload: { text: '', attachments: [] },
    executionRunId: run.id, executionState: run.state, routingHandoff: record.routingHandoff };
  const text = run.state === 'cancelled' ? '本轮已取消，这条消息尚未完成分流或独立回复。'
    : '这条消息已接收，但本轮未保存它的分流或独立回复，处理尚未完成。';
  // Missing bookkeeping is an internal failure, not a model-authored reply.
  // Execution failure/cancellation is reported by its owning request. It does
  // not authorize another reply to every unclaimed supplemental message.
  return { state: run.state === 'cancelled' ? 'cancelled' : 'failed',
    payload: { text: '', attachments: [] },
    executionRunId: run.id, error: text };
}
