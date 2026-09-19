/**
 * Pure helpers for normalizing the transport/source attached to a Session.
 * A source is display metadata only; it never changes Session visibility.
 */

export const DEFAULT_SESSION_SOURCE_ID = 'chat';

const BUILTIN_SOURCE_NAMES = new Map([
  ['chat', 'Chat'],
  ['email', 'Email'],
  ['feishu', 'Feishu'],
  ['wechat', 'WeChat'],
  ['github', 'GitHub'],
]);

export function normalizeSessionSourceId(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function normalizeSessionSourceName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

export function formatSessionSourceNameFromId(sourceId) {
  const normalized = normalizeSessionSourceId(sourceId);
  if (!normalized) return 'Chat';
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveSessionSourceId(meta) {
  return normalizeSessionSourceId(meta?.sourceId) || DEFAULT_SESSION_SOURCE_ID;
}

export function resolveSessionSourceName(meta, sourceId = resolveSessionSourceId(meta)) {
  return normalizeSessionSourceName(meta?.sourceName)
    || BUILTIN_SOURCE_NAMES.get(sourceId)
    || formatSessionSourceNameFromId(sourceId);
}

export function hasRequestedSessionSourceHint(extra = {}) {
  return !!normalizeSessionSourceId(extra?.sourceId);
}

export function resolveRequestedSessionSourceId(extra = {}) {
  return normalizeSessionSourceId(extra?.sourceId) || DEFAULT_SESSION_SOURCE_ID;
}

export function resolveRequestedSessionSourceName(extra = {}, sourceId = resolveRequestedSessionSourceId(extra)) {
  return normalizeSessionSourceName(extra?.sourceName)
    || BUILTIN_SOURCE_NAMES.get(sourceId)
    || formatSessionSourceNameFromId(sourceId);
}
