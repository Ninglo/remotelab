import { appendSessionEntryFooter, buildSessionEntry } from '../lib/session-navigation.mjs';
import { normalizeConversation as normalizeSourceDeliveryPlan } from '../lib/conversation-target.mjs';

// This is a transport notification, separate from model history and its result.
// Adapters using the durable outbox need no special sender for session links.
export function buildSessionEntryDeliveries(session, snapshot, options = {}) {
  if (['ambient', 'feedback'].includes(options.sourceContext?.feishuParticipation)) return [];
  if (options.internalOperation || options.recordUserMessage === false || snapshot.userMessageCount > 0) return [];
  const plan = normalizeSourceDeliveryPlan(options.sourceDelivery);
  // Email has one result; Feishu puts navigation in the useful model opening
  // (or its final reply when no opening exists), without a template notice.
  if (['email', 'feishu'].includes(plan?.connector)) return [];
  const entry = buildSessionEntry(session);
  if (!plan || !entry) return [];
  const text = [
    '会话已创建。',
    `模型：${options.model || '默认（由 Harness 决定）'}`,
    `Effort：${options.effort || '默认（由 Harness 决定）'}`,
    `Harness：${options.tool || session.tool || '默认'}`,
  ].join('\n');
  return [{
    ...plan,
    kind: 'session_entry',
    text: appendSessionEntryFooter(text, entry),
  }];
}
