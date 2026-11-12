import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, createRecordStore } from '../../lib/durable-records.mjs';
import { normalizeConversationTarget, sameConversationScope } from '../../lib/conversation-target.mjs';
import { getSummaryFeishuResources } from './inbound-envelope.mjs';
import { feishuAccessRole } from './restricted-access.mjs';

const key = id => createHash('sha256').update(id).digest('hex').slice(0, 24);
const storeFor = runtime => runtime.roleDeliveryContexts ||= createRecordStore(
  join(runtime.config.storageDir, 'role-delivery-contexts'));

// The generic outbox stores addresses, not provider identity or query text.
// Keep authorization at the connector that authenticated the original event.
export async function recordRoleDeliveryContext(runtime, summary, { responseId, sessionId = 'outbound', target = summary }) {
  if (runtime.config.accessPolicy?.mode !== 'roles') return;
  const role = feishuAccessRole(runtime.config.accessPolicy, summary);
  if (!['hr', 'collaborator', 'interviewer', 'recruiting_intern'].includes(role) || !responseId || !summary.messageId
      || (['interviewer', 'recruiting_intern'].includes(role) && sessionId !== 'outbound')) throw new Error('Invalid role delivery context');
  const context = { responseId, sessionId, sourceRouteId: runtime.config.sourceRouteId || 'default',
    target: normalizeConversationTarget(target), summary: {
      appId: summary.appId, tenantKey: summary.tenantKey, sender: {
        openId: summary.sender.openId, senderType: summary.sender.senderType, tenantKey: summary.sender.tenantKey },
      eventType: summary.eventType, messageType: summary.messageType, messageId: summary.messageId,
      messageText: summary.messageText, chatId: summary.chatId, chatType: summary.chatType,
      ...(summary.messageType === 'file' ? {resources: getSummaryFeishuResources(summary)} : {}),
    } };
  await storeFor(runtime).mutate(key(responseId), existing => {
    if (existing) {
      const { schema, key: recordKey, revision, ...saved } = existing;
      if (canonicalJson(saved) !== canonicalJson(context)) throw new Error('Role delivery context conflict');
      return existing;
    }
    return context;
  });
}

export async function authorizeRoleDelivery(runtime, delivery) {
  if (!delivery.responseId) return null;
  const context = await storeFor(runtime).get(key(delivery.responseId));
  if (!context || context.responseId !== delivery.responseId || context.sessionId !== delivery.sessionId
      || context.sourceRouteId !== delivery.sourceRouteId) return null;
  const plan = target => ({ connector: 'feishu', sourceRouteId: context.sourceRouteId, target });
  if (!sameConversationScope(plan(context.target), plan(delivery.target))
      || context.target.tenantKey !== delivery.target?.tenantKey) return null;
  const role = feishuAccessRole(runtime.config.accessPolicy, context.summary);
  if (runtime.config.appId !== context.summary.appId) return null;
  if (['hr', 'collaborator'].includes(role)) return { role, summary: context.summary };
  if (!['interviewer', 'recruiting_intern'].includes(role) || delivery.sessionId !== 'outbound' || delivery.attachment
      || delivery.kind !== 'content'
      || canonicalJson(context.target) !== canonicalJson(normalizeConversationTarget(delivery.target))) return null;
  return { role, summary: context.summary };
}
