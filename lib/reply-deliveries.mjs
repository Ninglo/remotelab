import { FEISHU_OUTCOME_REACTIONS } from './feishu-reaction-directive.mjs';

// Message role and Run state distinguish an opening/question from the result.
// A result label never claims that the task's acceptance criteria are complete.
function labelFeishuReply(text, running, surfaceKind, automationTitle) {
  if (typeof running !== 'boolean' || !text?.trim()) return text;
  const taskName = typeof automationTitle === 'string' ? automationTitle.replace(/\s+/g, ' ').trim() : '';
  const label = !running ? taskName || '最终答复' : surfaceKind === 'question' ? '待你回复'
    : surfaceKind === 'opening' ? '开始处理' : '进展';
  const content = text.trim();
  return `【${label}】\n\n${content.replace(/^(?:【进展】|【交付】|【待你确认】|【待你回复】|【开始处理】|【最终答复】)\s*/, '')}`;
}

// Pure reply-to-delivery conversion shared by live publication and offline migration.
export function buildReplyDeliveries(plan, payload, { requireFeishuOutcome = false, running, surfaceKind, automationTitle } = {}) {
  if (!plan) return [];
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
    ? labelFeishuReply(payload.text, running, surfaceKind, automationTitle) : payload.text });
  for (const attachment of payload.attachments || []) parts.push({ ...plan, kind: 'attachment', text: '', attachment });
  return parts;
}
