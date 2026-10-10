import { normalizeConversation } from '../lib/conversation-target.mjs';
import { parseFeishuReactionDirective } from '../lib/feishu-reaction-directive.mjs';

const THREAD_DIRECTIVE = '<private>feishu-reply:thread</private>';

export function resolveAmbientFeishuReplyPlan(record, plan, history = []) {
  if (record?.options?.sourceContext?.feishuParticipation !== 'ambient') return plan;
  const conversation = normalizeConversation(plan);
  const target = conversation?.target;
  if (conversation?.connector !== 'feishu' || target?.conversationKind !== 'main'
      || !target.chatId || !target.messageId) return plan;
  // Once a visible part is queued, its durable destination owns this turn.
  // Reactions do not choose placement. Later markers cannot split a reply
  // between the main timeline and a new Thread, including after recovery.
  const prior = record.deliveries?.find(delivery => delivery.connector === 'feishu'
    && delivery.sourceRouteId === conversation.sourceRouteId
    && delivery.target?.chatId === target.chatId
    && ['content', 'attachment'].includes(delivery.kind));
  if (prior) return normalizeConversation({ ...conversation, target: {
    ...target, ...prior.target, messageId: prior.target.messageId || target.messageId,
  } });
  if (record.replyPlacement?.connector === conversation.connector
      && record.replyPlacement.sourceRouteId === conversation.sourceRouteId
      && record.replyPlacement.target?.chatId === target.chatId) return normalizeConversation(record.replyPlacement);
  if (record.options.messageRoutingPolicy?.mechanism === 'none') return plan;
  const selected = history.some(event => {
    if (event?.type !== 'message' || event.role !== 'assistant') return false;
    const text = String(event.content || '').trimStart();
    return (parseFeishuReactionDirective(text)?.text || text).startsWith(THREAD_DIRECTIVE);
  });
  if (!selected) return plan;
  return normalizeConversation({
    ...conversation,
    target: {
      ...target,
      conversationKind: 'thread',
      rootId: target.messageId,
      replyInThread: true,
      sourceKind: 'ambient_thread_open',
    },
  });
}

// Persist placement before presentation suppresses an opening. A queued visible
// part still takes precedence; reactions and hidden openers never create replies.
export async function rememberAmbientFeishuReplyPlan(record, plan, history, store) {
  const selected = resolveAmbientFeishuReplyPlan(record, plan, history);
  if (record?.options?.sourceContext?.feishuParticipation !== 'ambient' || !selected) return record;
  if (selected.target?.conversationKind !== 'thread' || record.replyPlacement) return record;
  return await store.mutate(record.key, current => current.replyPlacement ? current
    : { ...current, replyPlacement: resolveAmbientFeishuReplyPlan(current, plan, history) });
}
