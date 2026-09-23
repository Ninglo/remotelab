import {
  findConnectorMessageIndexRecord,
  upsertConnectorMessageIndexRecord,
} from '../../lib/connector-message-index.mjs';
import {
  FEISHU_CONNECTOR_ID,
  buildFeishuMessageIndexRecord,
  buildFeishuOutboundMessageIndexRecord,
  buildFeishuTopicId,
} from './index.mjs';
import { sameConversation } from '../../lib/conversation-target.mjs';
import { buildFeishuSessionConversationTarget } from './reply-routing.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getFeishuAccountId(summary) {
  return trimString(summary?.tenantKey || summary?.sender?.tenantKey);
}

function getFeishuThreadId(summary, explicitThreadId = '') {
  return trimString(explicitThreadId)
    || (summary?.startThread === true ? trimString(summary?.messageId) : '')
    || buildFeishuTopicId(summary)
    || (summary?.conversationKind === 'thread'
      ? trimString(summary?.rootId) || trimString(summary?.parentId) || trimString(summary?.messageId)
      : '');
}

function buildFeishuThreadBindingMessageId(threadId) {
  const normalized = trimString(threadId);
  return normalized ? `thread:${normalized}` : '';
}

function withExternalTriggerId(record, externalTriggerId) {
  const normalized = trimString(externalTriggerId);
  return normalized ? { ...record, externalTriggerId: normalized } : record;
}

export async function recordFeishuMessageSession(runtime, summary, sessionId, {
  externalTriggerId = '',
} = {}) {
  const pathname = trimString(runtime?.storagePaths?.messageIndexPath);
  const record = buildFeishuMessageIndexRecord(summary, sessionId);
  if (!pathname || !record) return null;
  return upsertConnectorMessageIndexRecord(pathname, withExternalTriggerId(record, externalTriggerId));
}

export async function recordFeishuOutboundMessageSession(runtime, summary, sessionId, outboundMessageId, {
  externalTriggerId = '',
} = {}) {
  const pathname = trimString(runtime?.storagePaths?.messageIndexPath);
  const record = buildFeishuOutboundMessageIndexRecord(summary, sessionId, outboundMessageId);
  if (!pathname || !record) return null;
  return upsertConnectorMessageIndexRecord(pathname, withExternalTriggerId(record, externalTriggerId));
}

export async function recordFeishuThreadSessionBinding(runtime, summary, sessionId, {
  threadId = '',
  externalTriggerId = '',
} = {}) {
  const pathname = trimString(runtime?.storagePaths?.messageIndexPath);
  const normalizedSessionId = trimString(sessionId);
  const normalizedThreadId = getFeishuThreadId(summary, threadId);
  const messageId = buildFeishuThreadBindingMessageId(normalizedThreadId);
  if (!pathname || !normalizedSessionId || !messageId) return null;
  return upsertConnectorMessageIndexRecord(pathname, {
    connector: FEISHU_CONNECTOR_ID,
    ...(getFeishuAccountId(summary) ? { accountId: getFeishuAccountId(summary) } : {}),
    messageId,
    sessionId: normalizedSessionId,
    ...(trimString(summary?.chatId) ? { chatId: trimString(summary.chatId) } : {}),
    conversationId: normalizedThreadId,
    ...(trimString(externalTriggerId) ? { externalTriggerId: trimString(externalTriggerId) } : {}),
    direction: 'binding',
  });
}

export async function findFeishuThreadSessionBinding(runtime, summary) {
  const pathname = trimString(runtime?.storagePaths?.messageIndexPath);
  const threadId = getFeishuThreadId(summary);
  const messageId = buildFeishuThreadBindingMessageId(threadId);
  const chatId = trimString(summary?.chatId);
  if (!messageId || !chatId) return null;
  const conversation = { connector: FEISHU_CONNECTOR_ID,
    sourceRouteId: runtime.config?.sourceRouteId || 'default', target: buildFeishuSessionConversationTarget(summary) };
  const request = runtime.requestRemoteLab;
  if (request) {
    const result = await request('/api/session-conversations/resolve', { method: 'POST', body: { conversation } });
    if (!result.response.ok) throw new Error(result.json?.error || 'Unable to resolve Session conversation');
    if (result.json.sessionId) return { sessionId: result.json.sessionId, direction: 'binding', chatId, conversationId: threadId };
  }
  if (!pathname) return null;
  const binding = await findConnectorMessageIndexRecord(pathname, {
    connector: FEISHU_CONNECTOR_ID,
    accountId: getFeishuAccountId(summary),
    messageId,
    chatId,
    conversationId: threadId,
  });
  if (binding?.direction !== 'binding' || binding.chatId !== chatId || binding.conversationId !== threadId) return null;
  if (request) {
    // One-time adoption of pre-conversation connector state. Once a Session
    // has this field (including an explicit null), the old index has no authority.
    const result = await request(`/api/sessions/${binding.sessionId}`);
    if (result.response.status === 404) return null;
    if (!result.response.ok) throw new Error(result.json?.error || 'Unable to read legacy bound Session');
    const session = result.json.session;
    if (Object.hasOwn(session, 'conversation')) return sameConversation(session.conversation, conversation) ? binding : null;
    const adopted = await request(`/api/sessions/${binding.sessionId}`, { method: 'PATCH', body: { conversation } });
    if (!adopted.response.ok) throw new Error(adopted.json?.error || 'Unable to adopt legacy conversation');
  }
  return binding;
}
