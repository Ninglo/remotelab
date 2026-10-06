import { FEISHU_OUTCOME_REACTIONS } from './feishu-reaction-directive.mjs';

// Complex group work is routed into a Thread before publication. Mainline
// answers to a human message are brief replies and publish only the result.
export function isFeishuMainlineReply(plan) {
  const target = plan?.target;
  return plan?.connector === 'feishu' && target?.conversationKind === 'main'
    && Boolean(target.messageId) && target.chatType === 'group'
    && !target.commentId && !target.replyInThread && !target.threadId && !target.topicId
    && !['topic', 'thread'].includes(target.chatMode)
    && !['topic', 'thread'].includes(target.groupMessageType);
}

// Message role and Run state distinguish an opening/question from the result.
// A result label never claims that the task's acceptance criteria are complete.
function labelFeishuReply(text, running, surfaceKind, automationTitle, plainFinalReply = false) {
  if (typeof running !== 'boolean' || !text?.trim()) return text;
  const taskName = typeof automationTitle === 'string' ? automationTitle.replace(/\s+/g, ' ').trim() : '';
  const label = !running ? taskName || '最终答复' : surfaceKind === 'question' ? '待你回复'
    : surfaceKind === 'opening' ? '开始处理' : '进展';
  const content = text.trim().replace(/^(?:【进展】|【交付】|【待你确认】|【待你回复】|【开始处理】|【最终答复】|【最终回复】)\s*/, '');
  // A mainline reply publishes just the answer, so it needs no phase heading.
  if (!running && plainFinalReply && !taskName) return content;
  return `【${label}】\n\n${content}`;
}

// Pure reply-to-delivery conversion shared by live publication and offline migration.
export function buildReplyDeliveries(plan, payload, { requireFeishuOutcome = false, running, surfaceKind, automationTitle } = {}) {
  if (!plan) return [];
  if (isFeishuMainlineReply(plan) && running === true && surfaceKind !== 'question') return [];
  const documentComment = plan.connector === 'feishu' && Boolean(plan.target?.commentId);
  // Document threads receive the completed answer, not chat progress chatter.
  if (documentComment && running === true) return [];
  // Email: one combined delivery; the email worker sends a single message with text + attachments.
  if (plan.connector === 'email') {
    const text = payload.text || '';
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (!text && attachments.length === 0) return [];
    return [{ ...plan, kind: 'content', text, attachments }];
  }
  // All other connectors: split text and attachments into separate deliveries.
  const parts = [];
  const outcome = FEISHU_OUTCOME_REACTIONS.includes(payload.reaction)
    ? payload.reaction : requireFeishuOutcome ? 'EatingFood' : '';
  if (plan.connector === 'feishu' && outcome
      && plan.target?.messageId) {
    parts.push({ ...plan, kind: 'reaction', emojiType: outcome, text: '' });
  }
  if (payload.text) parts.push({ ...plan, kind: 'content', text: plan.connector === 'feishu' && !documentComment
    ? labelFeishuReply(payload.text, running, surfaceKind, automationTitle, isFeishuMainlineReply(plan)) : payload.text });
  for (const attachment of payload.attachments || []) parts.push({ ...plan, kind: 'attachment', text: '', attachment });
  return parts;
}
