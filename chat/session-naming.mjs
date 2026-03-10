export const DEFAULT_SESSION_NAME = 'new session';
const TEMP_SESSION_NAME_MAX_CHARS = 12;
const SESSION_GROUP_MAX_CHARS = 32;
const SESSION_DESCRIPTION_MAX_CHARS = 160;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimSessionLabelDecorators(value) {
  return value
    .replace(/^[\s\-–—:：|/·•,，.]+/u, '')
    .replace(/[\s\-–—:：|/·•,，.]+$/u, '')
    .trim();
}

function normalizeSessionText(value, maxChars) {
  const normalized = typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return '';
  return Array.from(normalized).slice(0, maxChars).join('');
}

export function normalizeSessionName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

export function normalizeSessionGroup(group) {
  return normalizeSessionText(group, SESSION_GROUP_MAX_CHARS);
}

export function normalizeSessionDescription(description) {
  return normalizeSessionText(description, SESSION_DESCRIPTION_MAX_CHARS);
}

export function normalizeGeneratedSessionTitle(title, group) {
  const normalizedTitle = normalizeSessionName(title);
  const normalizedGroup = normalizeSessionGroup(group);
  if (!normalizedTitle || !normalizedGroup) return normalizedTitle;

  const escapedGroup = escapeRegExp(normalizedGroup);
  let nextTitle = normalizedTitle
    .replace(new RegExp(`^${escapedGroup}(?:[\\s\\-–—:：|/·•,，.]+)?`, 'iu'), '')
    .replace(new RegExp(`(?:[\\s\\-–—:：|/·•,，.]+)?${escapedGroup}$`, 'iu'), '')
    .replace(/\s+/gu, ' ')
    .trim();

  nextTitle = trimSessionLabelDecorators(nextTitle);
  return nextTitle || normalizedTitle;
}

export function resolveInitialSessionName(name) {
  const normalized = normalizeSessionName(name);
  return {
    name: normalized || DEFAULT_SESSION_NAME,
    autoRenamePending: !normalized,
  };
}

export function isSessionAutoRenamePending(session) {
  if (!session) return true;
  if (typeof session === 'object' && Object.prototype.hasOwnProperty.call(session, 'autoRenamePending')) {
    return session.autoRenamePending === true;
  }
  const name = typeof session === 'string' ? session : session.name;
  return !normalizeSessionName(name) || normalizeSessionName(name) === DEFAULT_SESSION_NAME;
}

export function buildTemporarySessionName(text, maxChars = TEMP_SESSION_NAME_MAX_CHARS) {
  const normalized = typeof text === 'string'
    ? text.replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return '';

  const chars = Array.from(normalized);
  const head = chars.slice(0, maxChars).join('');
  return chars.length > maxChars ? `${head}…` : head;
}
