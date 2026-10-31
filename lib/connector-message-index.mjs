import { resolve } from 'node:path';
import { sqliteState } from './sqlite-state.mjs';

const initialized = new Map();
export function initializeConnectorMessageIndex(pathname) {
  const key = resolve(pathname);
  if (!initialized.has(key)) initialized.set(key, sqliteState(key, 'initialize', {
    indexes: [['connector', 'messageId'], ['chatId']],
  }).catch(error => { initialized.delete(key); throw error; }));
  return initialized.get(key);
}

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
    ...(trimString(record.conversationKind) ? { conversationKind: trimString(record.conversationKind) } : {}),
    ...(trimString(record.rootId) ? { rootId: trimString(record.rootId) } : {}),
    ...(trimString(record.externalTriggerId) ? { externalTriggerId: trimString(record.externalTriggerId) } : {}),
    ...(trimString(record.sourceMessageId) ? { sourceMessageId: trimString(record.sourceMessageId) } : {}),
    ...(trimString(record.direction) ? { direction: trimString(record.direction) } : {}),
    ...(Number.isInteger(record.eventSeq) ? { eventSeq: record.eventSeq } : {}),
    createdAt: trimString(record.createdAt) || nowIso(),
    updatedAt: trimString(record.updatedAt) || nowIso(),
  };
}

export async function loadConnectorMessageIndex(pathname) {
  await initializeConnectorMessageIndex(pathname);
  return sqliteState(pathname, 'load');
}

export async function upsertConnectorMessageIndexRecord(pathname, record) {
  const normalized = normalizeConnectorMessageIndexRecord(record);
  if (!normalized) return null;
  const key = connectorMessageIndexKey(normalized);
  if (!key) return null;
  await initializeConnectorMessageIndex(pathname);
  return sqliteState(pathname, 'merge', {
    key, value: { ...normalized, updatedAt: nowIso() }, preserve: ['createdAt'],
  });
}

export async function findConnectorMessageIndexRecord(pathname, query = {}) {
  const connector = trimString(query.connector), messageId = trimString(query.messageId);
  if (!connector || !messageId) return null;
  await initializeConnectorMessageIndex(pathname);
  const accountId = trimString(query.accountId || query.tenantKey);
  const filters = { accountId, chatId: trimString(query.chatId),
    conversationId: trimString(query.conversationId || query.topicId) };
  const direct = await sqliteState(pathname, 'get', { key: connectorMessageIndexKey({ connector, accountId, messageId }) });
  if (direct) return Object.entries(filters).every(([field, value]) => !value || !trimString(direct[field])
    || trimString(direct[field]) === value) ? direct : null;
  const clauses = ["trim(coalesce(json_extract(value,'$.connector'),''))=?", "trim(coalesce(json_extract(value,'$.messageId'),''))=?"];
  const params = [connector, messageId];
  for (const [field, value] of Object.entries(filters)) if (value) {
    clauses.push(`trim(coalesce(json_extract(value,'$.${field}'),'')) IN ('',?)`); params.push(value);
  }
  return sqliteState(pathname, 'find', { sql: `SELECT value FROM records WHERE ${clauses.join(' AND ')} ORDER BY ordinal LIMIT 1`, params });
}
