import { readFeishuResponseDecision, hasFeishuInputReplyContract } from '../lib/feishu-response-decision.mjs';
import { isFinalAssistantMessage, isReplyMessage } from '../lib/assistant-message-phase.mjs';
import { assistantSurfaceMessageId } from '../lib/assistant-surface-messages.mjs';
import { sameConversation } from '../lib/conversation-target.mjs';
import { buildReplyPublicationPayload } from './reply-publication.mjs';
import { publishFeishuResponse } from './feishu-response.mjs';
import { requests } from './requests.mjs';

// A final's content and input coverage are one publication. No second tool
// call, prose classifier, or assumption that all steered inputs were answered.
export async function publishNativeFeishuResponses(record, history, run, {
  store = requests, session, fullHistory = history, prepareFinal = async event => event, running = false,
} = {}) {
  if (!hasFeishuInputReplyContract(record) || (!running && run.state !== 'completed')) return record;
  const candidates = history.filter(isReplyMessage);
  const finals = candidates.filter(isFinalAssistantMessage);
  const selected = [];
  const covered = new Set();
  // Completed native items can answer an input while steering keeps its Run
  // alive. Revisions in the same unread batch still select the latest answer;
  // already committed input replies retain their original delivery identity.
  for (const event of (finals.length ? finals : running ? [] : candidates.slice(-1)).slice().reverse()) {
    const decision = readFeishuResponseDecision(event.content);
    if (!decision.specified) {
      // A completed answer already has an accepted source address. New bound-
      // topic inputs default to that conversation; omitting display metadata
      // must not discard the answer or require another model round trip.
      if (record.options?.sourceContext?.feishuThreadSessionVersion !== 1
          || !isFinalAssistantMessage(event) || (!decision.text && !event.attachments?.length)) continue;
      decision.replyMode ||= 'inline';
    }
    let ids = decision.requestIds || [record.requestId];
    if (!decision.error) {
      // Question answers are accepted context, not independent reply owners.
      // Resolve real records; never discard an ID merely by its prefix.
      const owners = [];
      let alreadyAnswered = false;
      for (const id of ids) {
        const input = await store.byRequest(record.sessionId, id);
        const origin = record.deliveryPlan || record.options?.sourceDelivery;
        const source = input?.deliveryPlan || input?.options?.sourceDelivery;
        // A continuation may name the earlier task as well as the new input.
        // Settled human inputs in this conversation are context, not new reply
        // owners. Retain their original results and deliver only for this Run's
        // explicitly selected inputs; unknown or foreign IDs still fail below.
        if (input?.sequence < record.sequence && input.result
            && (input.nativeDispatchRunId || input.runId) !== run.id
            && hasFeishuInputReplyContract(input) && !input.routingHandoff
            && !input.options.nativeQuestionId && !input.options.internalOperation
            && !input.options.workReference && !input.options.deliveryOnly
            && (!input.nativeDispatchRunId || input.nativeReceipt?.accepted === true)
            && input.options.sourceContext?.connector === 'feishu'
            && input.options.sourceContext?.sender?.senderType === 'user'
            && source?.target?.tenantKey === origin?.target?.tenantKey
            && sameConversation(source, origin)) continue;
        if (source?.connector === 'feishu' && source.sourceRouteId === origin?.sourceRouteId
            && source.target?.chatId === origin?.target?.chatId
            && source.target?.tenantKey === origin?.target?.tenantKey
            && input?.options?.nativeQuestionId && input.nativeDispatchRunId === run.id
            && input.nativeReceipt?.accepted === true && input.nativeReceipt.mode === 'question_answer'
            && input.nativeReceipt.questionId === input.options.nativeQuestionId
            && input.nativeReceipt.origin === 'user'
            && input.options.sourceContext?.connector === 'feishu'
            && input.options.sourceContext?.sender?.senderType === 'user') continue;
        // A later combined answer may include the root already sent live.
        // Publish its newly answered inputs without replacing the old receipt.
        // Keep unknown/foreign inputs for the normal whole-packet validation.
        if (source?.connector === 'feishu' && source.sourceRouteId === origin?.sourceRouteId
            && source.target?.chatId === origin?.target?.chatId
            && source.target?.tenantKey === origin?.target?.tenantKey
            && (input.nativeDispatchRunId || input.runId) === run.id
            && input.mainlineReply?.contract.providerMessageId
            && input.mainlineReply.contract.providerMessageId !== assistantSurfaceMessageId(event)) {
          alreadyAnswered = true;
          continue;
        }
        owners.push(id);
      }
      if (!owners.length) {
        // Only native question answers are not independent reply owners.
        if (alreadyAnswered) continue;
        decision.error = 'Response needs an accepted message owner';
      }
      // A later final owns overlapping inputs; retain the earlier final for
      // the inputs it explicitly answered that the later final did not claim.
      ids = owners.filter(id => !covered.has(id));
      if (!decision.error && !ids.length) continue;
    }
    if (!decision.error) ids.forEach(id => covered.add(id));
    selected.unshift({ event, decision, ids });
  }
  for (const { event, decision, ids } of selected) {
    const messageId = assistantSurfaceMessageId(event) || `seq:${event.seq}`;
    record = await store.get(record.key) || record;
    if (record.responseDecisionMessageIds?.includes(messageId)) continue;
    try {
      if (decision.error) throw new Error(decision.error);
      const owner = await store.byRequest(record.sessionId, ids[0]);
      if (!owner || (owner.nativeDispatchRunId || owner.runId) !== run.id) throw new Error('Response input is outside this execution');
      const silentHandoff = ids.length === 1 && owner.routingHandoff?.state === 'submitted'
        && decision.noTextReason && !decision.text && decision.reaction === undefined
        && !event.attachments?.length;
      if (silentHandoff) {
        await store.mutate(record.key, current => {
          const errors = { ...current.responseDecisionErrors }; delete errors[messageId];
          return { ...current, responseDecisionErrors: errors,
            responseDecisionMessageIds: [...new Set([...(current.responseDecisionMessageIds || []), messageId])] };
        });
        continue;
      }
      const prepared = await prepareFinal(event);
      if (!prepared) throw new Error('Response attachments are not ready');
      const payload = buildReplyPublicationPayload([prepared], run, { session, fullHistory, includeSessionEntry: false,
        finalDirectiveContent: event.content });
      await publishFeishuResponse(owner, { text: payload.text, requestIds: ids,
        ...(decision.replyMode ? { replyMode: decision.replyMode } : {}),
        ...(decision.reaction !== undefined ? { reaction: decision.reaction } : {}),
        ...(decision.participationReason ? { participationReason: decision.participationReason } : {}),
        ...(decision.noTextReason ? { noTextReason: decision.noTextReason } : {}),
      }, { store, preparedPayload: payload, providerMessageId: messageId });
      await store.mutate(record.key, current => {
        const errors = { ...current.responseDecisionErrors };
        delete errors[messageId];
        return { ...current, responseDecisionErrors: errors,
          responseDecisionMessageIds: [...new Set([...(current.responseDecisionMessageIds || []), messageId])],
          streamedFinalReplyIds: [...new Set([...(current.streamedFinalReplyIds || []), messageId])],
        };
      });
    } catch (error) {
      // Keep the answer in history and a concrete structural error. Never
      // guess coverage or let terminal fallback publish the invalid answer.
      await store.mutate(record.key, current => ({ ...current,
        responseDecisionErrors: { ...current.responseDecisionErrors, [messageId]: error.message },
      }));
    }
  }
  return await store.get(record.key) || record;
}
