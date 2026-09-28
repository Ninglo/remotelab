import { normalizeConversation } from '../lib/conversation-target.mjs';
import { parseFeishuReactionDirective } from '../lib/feishu-reaction-directive.mjs';

const THREAD_DIRECTIVE = '<private>feishu-reply:thread</private>';

export function resolveAmbientFeishuReplyPlan(record, plan, history = []) {
  if (record?.options?.sourceContext?.feishuParticipation !== 'ambient') return plan;
  const conversation = normalizeConversation(plan);
  const target = conversation?.target;
  if (conversation?.connector !== 'feishu' || target?.conversationKind !== 'main'
      || !target.chatId || !target.messageId) return plan;
  const lastAssistant = [...history].reverse().find(event => event?.type === 'message' && event.role === 'assistant');
  const final = String(lastAssistant?.content || '').trimStart();
  const content = parseFeishuReactionDirective(final)?.text || final;
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
