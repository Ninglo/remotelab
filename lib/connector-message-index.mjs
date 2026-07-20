import { readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeKeyPart(value) {
  return trimString(value).replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 160);
}

export function connectorMessageIndexKey(record = {}) {
  const connector = normalizeKeyPart(record.connector);
  const messageId = normalizeKeyPart(record.messageId);
  if (!connector || !messageId) return '';
  const accountId = normalizeKeyPart(record.accountId || record.tenantKey || '');
  return [connector, accountId, messageId].filter(Boolean).join(':');
}

export function normalizeConnectorMessageIndexRecord(record = {}) {
  const connector = trimString(record.connector);
  const messageId = trimString(record.messageId);
  const sessionId = trimString(record.sessionId);
  if (!connector || !messageId || !sessionId) return null;
  return {
    connector,
    messageId,
    sessionId,
    ...(trimString(record.accountId || record.tenantKey) ? { accountId: trimString(record.accountId || record.tenantKey) } : {}),
    ...(trimString(record.chatId) ? { chatId: trimString(record.chatId) } : {}),
    ...(trimString(record.conversationId || record.topicId) ? { conversationId: trimString(record.conversationId || record.topicId) } : {}),
    ...(trimString(record.externalTriggerId) ? { externalTriggerId: trimString(record.externalTriggerId) } : {}),
    ...(trimString(record.sourceMessageId) ? { sourceMessageId: trimString(record.sourceMessageId) } : {}),
    ...(trimString(record.direction) ? { direction: trimString(record.direction) } : {}),
    ...(Number.isInteger(record.eventSeq) ? { eventSeq: record.eventSeq } : {}),
    createdAt: trimString(record.createdAt) || nowIso(),
    updatedAt: trimString(record.updatedAt) || nowIso(),
  };
}

export async function loadConnectorMessageIndex(pathname) {
  const document = await readJson(pathname, { records: {} });
  return document && typeof document === 'object' && !Array.isArray(document)
    ? { records: document.records && typeof document.records === 'object' && !Array.isArray(document.records) ? document.records : {} }
    : { records: {} };
}

export async function upsertConnectorMessageIndexRecord(pathname, record) {
  const normalized = normalizeConnectorMessageIndexRecord(record);
  if (!normalized) return null;
  const key = connectorMessageIndexKey(normalized);
  if (!key) return null;
  const document = await loadConnectorMessageIndex(pathname);
  const existing = document.records[key] || {};
  const next = {
    ...existing,
    ...normalized,
    createdAt: trimString(existing.createdAt) || normalized.createdAt,
    updatedAt: nowIso(),
  };
  document.records[key] = next;
  await writeJsonAtomic(pathname, document);
  return next;
}

export async function findConnectorMessageIndexRecord(pathname, query = {}) {
  const connector = trimString(query.connector);
  const messageId = trimString(query.messageId);
  if (!connector || !messageId) return null;
  const accountId = trimString(query.accountId || query.tenantKey || '');
  const document = await loadConnectorMessageIndex(pathname);
  const directKey = connectorMessageIndexKey({ connector, accountId, messageId });
  const direct = directKey ? document.records[directKey] : null;
  const candidates = direct
    ? [direct]
    : Object.values(document.records).filter((record) => (
      trimString(record?.connector) === connector
      && trimString(record?.messageId) === messageId
    ));
  const chatId = trimString(query.chatId);
  const conversationId = trimString(query.conversationId || query.topicId || '');
  return candidates.find((record) => {
    if (accountId && trimString(record.accountId) && trimString(record.accountId) !== accountId) return false;
    if (chatId && trimString(record.chatId) && trimString(record.chatId) !== chatId) return false;
    if (conversationId && trimString(record.conversationId) && trimString(record.conversationId) !== conversationId) return false;
    return true;
  }) || null;
}
