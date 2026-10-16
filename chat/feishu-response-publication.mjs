import { readFeishuResponseDecision } from '../lib/feishu-response-decision.mjs';
import { hasPilotInputReplyContract } from '../lib/group-routing-pilot.mjs';
import { isFinalAssistantMessage, isReplyMessage } from '../lib/assistant-message-phase.mjs';
import { assistantSurfaceMessageId } from '../lib/assistant-surface-messages.mjs';
import { buildReplyPublicationPayload } from './reply-publication.mjs';
import { publishFeishuResponse } from './feishu-response.mjs';
import { requests } from './requests.mjs';

// A final's content and input coverage are one publication. No second tool
// call, prose classifier, or assumption that all steered inputs were answered.
export async function publishNativeFeishuResponses(record, history, run, {
  store = requests, session, fullHistory = history, prepareFinal = async event => event,
} = {}) {
  if (!hasPilotInputReplyContract(record) || run.state !== 'completed') return record;
  const candidates = history.filter(isReplyMessage);
  const finals = candidates.filter(isFinalAssistantMessage);
  const selected = [];
  const covered = new Set();
  // A later final can revise an answer before terminal publication. Preserve
  // the latest decision; unrelated explicit input sets remain independent.
  for (const event of (finals.length ? finals : candidates.slice(-1)).slice().reverse()) {
    const decision = readFeishuResponseDecision(event.content);
    if (!decision.specified) continue;
    const ids = decision.requestIds || [record.requestId];
    if (!decision.error && ids.every(id => covered.has(id))) continue;
    if (!decision.error && ids.some(id => covered.has(id))) decision.error = 'Final response input sets partially overlap';
    ids.forEach(id => covered.add(id));
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
      const prepared = await prepareFinal(event);
      if (!prepared) throw new Error('Response attachments are not ready');
      const payload = buildReplyPublicationPayload([prepared], run, { session, fullHistory, includeSessionEntry: false,
        finalDirectiveContent: event.content });
      await publishFeishuResponse(owner, { text: payload.text, requestIds: ids,
        ...(decision.replyMode ? { replyMode: decision.replyMode } : {}),
        ...(decision.reaction ? { reaction: decision.reaction } : {}),
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
