import { PUBLIC_BASE_URL } from './config.mjs';

export const SESSION_ENTRY_LABEL = '查看会话详情和进度';

const NON_LINKABLE_SOURCE_IDS = new Set([
  '',
  'chat',
  'observer',
  'share_link',
  'shortcut',
  'siri-shortcut',
  'voice',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildSessionNavigationHref(sessionId, {
  publicBaseUrl = PUBLIC_BASE_URL,
  requireAbsolute = false,
} = {}) {
  const normalizedSessionId = trimString(sessionId);
  const path = !normalizedSessionId
    ? '/?tab=sessions'
    : `/?session=${encodeURIComponent(normalizedSessionId)}&tab=sessions`;
  const normalizedBaseUrl = trimString(publicBaseUrl).replace(/\/+$/, '');
  if (normalizedBaseUrl) return `${normalizedBaseUrl}${path}`;
  return requireAbsolute ? '' : path;
}

export function shouldOfferSessionEntry(session) {
  if (!session || typeof session !== 'object') return false;
  if (trimString(session.internalRole) || trimString(session.visitorId)) return false;
  return !NON_LINKABLE_SOURCE_IDS.has(trimString(session.sourceId).toLowerCase());
}

export function buildSessionEntry(session, options = {}) {
  if (!shouldOfferSessionEntry(session)) return null;
  const url = buildSessionNavigationHref(session.id, {
    ...options,
    requireAbsolute: true,
  });
  if (!url) return null;
  return {
    url,
    label: SESSION_ENTRY_LABEL,
  };
}

export function appendSessionEntryFooter(text, sessionEntry) {
  const normalizedText = trimString(text);
  const url = trimString(sessionEntry?.url);
  if (!url || normalizedText.includes(url)) return normalizedText;
  const label = trimString(sessionEntry?.label) || SESSION_ENTRY_LABEL;
  return [normalizedText, `${label}：${url}`].filter(Boolean).join('\n\n');
}
