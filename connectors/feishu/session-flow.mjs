import {
  findConnectorMessageIndexRecord,
  upsertConnectorMessageIndexRecord,
} from '../../lib/connector-message-index.mjs';
import {
  FEISHU_CONNECTOR_ID,
  buildFeishuMessageIndexRecord,
  buildFeishuOutboundMessageIndexRecord,
} from './index.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getFeishuAccountId(summary) {
  return trimString(summary?.tenantKey || summary?.sender?.tenantKey);
}

function getFeishuThreadId(summary, explicitThreadId = '') {
  return trimString(explicitThreadId || summary?.threadId || summary?.topicId);
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
  if (!pathname || !messageId) return null;
  return findConnectorMessageIndexRecord(pathname, {
    connector: FEISHU_CONNECTOR_ID,
    accountId: getFeishuAccountId(summary),
    messageId,
    chatId: trimString(summary?.chatId),
    conversationId: threadId,
  });
}
