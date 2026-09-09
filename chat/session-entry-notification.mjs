import { appendSessionEntryFooter, buildSessionEntry } from '../lib/session-navigation.mjs';
import { normalizeSourceDeliveryPlan } from './source-deliveries.mjs';

// This is a transport notification, separate from model history and its result.
// Adapters using the durable outbox need no special sender for session links.
export function buildSessionEntryDeliveries(session, snapshot, options = {}) {
  if (options.internalOperation || options.recordUserMessage === false || snapshot.userMessageCount > 0) return [];
  const plan = normalizeSourceDeliveryPlan(options.sourceDelivery);
  // Email has one final message per request, not a separate creation email.
  // The first result can still include the usual session navigation footer.
  if (plan?.connector === 'email') return [];
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
