import { normalizeConversation, sameConversation, sameConversationScope, conversationAfterReceipt } from '../lib/conversation-target.mjs';
import { loadSessionsMeta, withSessionsMetaMutation } from './session-meta-store.mjs';
import { broadcastOwners } from './ws-clients.mjs';

export function requireConversation(value) {
  if (value === null || value === undefined) return null;
  const conversation = normalizeConversation(value);
  if (!conversation) throw new Error('Invalid conversation connector or target');
  return conversation;
}

export async function findSessionConversation(value) {
  const conversation = requireConversation(value);
  if (!conversation) return null;
  return (await loadSessionsMeta()).find(session => !session.visitorId && sameConversation(session.conversation, conversation)) || null;
}

export async function updateSessionConversation(sessionId, value, { receipt } = {}) {
  const requested = requireConversation(value);
  const session = await withSessionsMetaMutation(async (metas, save) => {
    const current = metas.find(meta => meta.id === sessionId);
    if (!current) throw new Error('Session not found');
    if (current.visitorId) throw new Error('Visitor Sessions cannot bind external conversations');
    let conversation = requested;
    if (receipt) {
      const bound = normalizeConversation(current.conversation);
      // Resolve against the current binding under the metadata mutation lock.
      // A late receipt must not restore an unbound or transferred conversation.
      if (!bound || (!sameConversation(bound, requested)
          && JSON.stringify(bound) !== JSON.stringify(requested))) return current;
      conversation = conversationAfterReceipt(bound, receipt);
      if (!conversation) return current;
    }
    const other = conversation && metas.find(meta => meta.id !== sessionId && sameConversation(meta.conversation, conversation));
    if (other) throw new Error('Conversation already belongs to another Session');
    if (JSON.stringify(current.conversation || null) === JSON.stringify(conversation)) return current;
    if (conversation) current.conversation = conversation;
    else current.conversation = null; // Tombstone prevents legacy indexes from reattaching it.
    current.updatedAt = new Date().toISOString();
    await save(metas);
    return current;
  });
  broadcastOwners({ type: 'session_invalidated', sessionId });
  return session;
}

// Original submitted options remain intact for idempotency. The resolved
// destination is an independent request snapshot, like runtimeSelection.
export function resolveSessionDeliveryPlan(session, options) {
  const explicit = normalizeConversation(options.sourceDelivery);
  const bound = normalizeConversation(session.conversation);
  if (options.internalOperation && options.internalOperation !== 'trigger_delivery') return explicit;
  if (!bound) return explicit;
  if (!explicit) return bound;
  const exact = JSON.stringify(bound) === JSON.stringify(explicit);
  const requestScopedFeishuReply = bound.connector === 'feishu' && sameConversationScope(bound, explicit);
  if (!exact && !sameConversation(bound, explicit) && !requestScopedFeishuReply) {
    throw new Error('sourceDelivery conflicts with the Session conversation: connector, source route, tenant, or chat differs');
  }
  // The Session binding preserves context identity. The explicit request plan
  // is an immutable reply snapshot and therefore wins within that identity's
  // Feishu chat (for example, a new root message in continue mode).
  return explicit;
}
