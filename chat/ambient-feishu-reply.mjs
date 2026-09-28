import { normalizeConversation } from '../lib/conversation-target.mjs';

const THREAD_DIRECTIVE = '<private>feishu-reply:thread</private>';

export function resolveAmbientFeishuReplyPlan(record, plan, history = []) {
  if (record?.options?.sourceContext?.feishuParticipation !== 'ambient') return plan;
  const conversation = normalizeConversation(plan);
  const target = conversation?.target;
  if (conversation?.connector !== 'feishu' || target?.conversationKind !== 'main'
      || !target.chatId || !target.messageId) return plan;
  const lastAssistant = [...history].reverse().find(event => event?.type === 'message' && event.role === 'assistant');
  const content = String(lastAssistant?.content || '').trimStart();
  if (!content.startsWith(THREAD_DIRECTIVE)) return plan;
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
