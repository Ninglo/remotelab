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

export function buildLangSmithCaseNavigationHref(sessionId, {
  publicBaseUrl = PUBLIC_BASE_URL,
  requireAbsolute = false,
} = {}) {
  if (!/^[0-9a-f]{32}$/.test(sessionId || '')) return '';
  const path = `/api/sessions/${sessionId}/langsmith`;
  const base = trimString(publicBaseUrl).replace(/\/+$/, '');
  return base ? `${base}${path}` : requireAbsolute ? '' : path;
}

export function shouldOfferSessionEntry(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.conversation && (!session.internalRole || session.internalRole === 'scheduled_execution')) return true;
  if (trimString(session.internalRole)) return false;
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
    ...((session.sourceId === 'feishu' || session.conversation?.connector === 'feishu') ? {
      runtimeDescription: formatSessionRuntimeDescription(options.runtimeSelection || session),
    } : {}),
  };
}

export function formatSessionRuntimeDescription(selection = {}) {
  const delegated = '默认（由 Harness 决定）';
  return `模型：${trimString(selection.model) || delegated} · 思考强度：${trimString(selection.effort) || delegated} · 执行工具：${trimString(selection.tool) || delegated}`;
}

export function appendSessionEntryFooter(text, sessionEntry) {
  const normalizedText = trimString(text);
  const url = trimString(sessionEntry?.url);
  if (!url) return normalizedText;
  const runtimeDescription = trimString(sessionEntry?.runtimeDescription);
  const label = trimString(sessionEntry?.label) || SESSION_ENTRY_LABEL;
  return [normalizedText,
    runtimeDescription && !normalizedText.includes(runtimeDescription) ? runtimeDescription : '',
    normalizedText.includes(url) ? '' : `${label}：${url}`,
  ].filter(Boolean).join('\n\n');
}
