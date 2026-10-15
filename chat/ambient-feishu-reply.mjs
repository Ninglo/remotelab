import { normalizeConversation } from '../lib/conversation-target.mjs';
import { parseFeishuReactionDirective } from '../lib/feishu-reaction-directive.mjs';

const THREAD_DIRECTIVE = '<private>feishu-reply:thread</private>';
const INLINE_DIRECTIVE = '<private>feishu-reply:inline</private>';

export function requiresFeishuReplyPlacement(record) {
  return record?.options?.sourceContext?.feishuParticipation === 'ambient'
    && record.options.sourceContext.feishuReplyPlacementVersion === 1;
}

export function readFeishuReplyPlacement(history = []) {
  for (const event of history) {
    if (event?.type !== 'message' || event.role !== 'assistant') continue;
    const text = String(event.content || '').trimStart();
    const body = (parseFeishuReactionDirective(text)?.text || text).trimStart();
    if (body.startsWith(THREAD_DIRECTIVE)) return 'thread';
    if (body.startsWith(INLINE_DIRECTIVE)) return 'inline';
  }
  return null;
}

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
    && delivery.surfaceKind !== 'placement_error'
    && ['content', 'attachment'].includes(delivery.kind));
  if (prior) return normalizeConversation({ ...conversation, target: {
    ...target, ...prior.target, messageId: prior.target.messageId || target.messageId,
  } });
  if (record.replyPlacement?.connector === conversation.connector
      && record.replyPlacement.sourceRouteId === conversation.sourceRouteId
      && record.replyPlacement.target?.chatId === target.chatId) return normalizeConversation(record.replyPlacement);
  const selected = readFeishuReplyPlacement(history);
  if (!selected && requiresFeishuReplyPlacement(record)) return null;
  if (selected !== 'thread') return plan;
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
  if ((selected.target?.conversationKind !== 'thread' && !readFeishuReplyPlacement(history)) || record.replyPlacement) return record;
  return await store.mutate(record.key, current => current.replyPlacement ? current
    : { ...current, replyPlacement: resolveAmbientFeishuReplyPlan(current, plan, history) });
}
