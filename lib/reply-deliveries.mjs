import { FEISHU_OUTCOME_REACTIONS } from './feishu-reaction-directive.mjs';

// Pure reply-to-delivery conversion shared by live publication and offline migration.
export function buildReplyDeliveries(plan, payload, { requireFeishuOutcome = false } = {}) {
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
  if (payload.text) parts.push({ ...plan, kind: 'content', text: payload.text });
  for (const attachment of payload.attachments || []) parts.push({ ...plan, kind: 'attachment', text: '', attachment });
  return parts;
}
