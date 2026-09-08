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
  return [{
    ...plan,
    kind: 'session_entry',
    text: appendSessionEntryFooter('会话已创建。', entry),
  }];
}
