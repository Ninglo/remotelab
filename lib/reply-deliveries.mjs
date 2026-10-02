import { FEISHU_OUTCOME_REACTIONS } from './feishu-reaction-directive.mjs';

// These describe the message's publication phase, never task completion.
function labelFeishuReply(text, surfaceKind) {
  const label = surfaceKind === 'final' ? '交付'
    : ['opening', 'progress'].includes(surfaceKind) ? '进展' : '';
  if (!label || !text?.trim()) return text;
  const content = text.trim();
  // The Harness explicitly asks for input; transport cannot infer that need.
  if (content.startsWith('【待你确认】')) return content;
  return `【${label}】\n\n${content.replace(/^(?:【进展】|【交付】)\s*/, '')}`;
}

// Pure reply-to-delivery conversion shared by live publication and offline migration.
export function buildReplyDeliveries(plan, payload, { requireFeishuOutcome = false, surfaceKind = '' } = {}) {
  if (!plan) return [];
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
  if (payload.text) parts.push({ ...plan, kind: 'content', text: plan.connector === 'feishu'
    ? labelFeishuReply(payload.text, surfaceKind) : payload.text });
  for (const attachment of payload.attachments || []) parts.push({ ...plan, kind: 'attachment', text: '', attachment });
  return parts;
}
