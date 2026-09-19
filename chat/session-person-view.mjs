import {
  normalizeSessionGroup,
  normalizeSessionSpace,
} from './session-naming.mjs';
import { DEFAULT_PERSON_ID } from '../lib/auth-config.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSessionSidebarOrder(value) {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeSessionPersonView(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const space = normalizeSessionSpace(value.space || '');
  const group = normalizeSessionGroup(value.group || '');
  const sidebarOrder = normalizeSessionSidebarOrder(value.sidebarOrder);
  return {
    ...(space ? { space } : {}),
    ...(group ? { group } : {}),
    ...(sidebarOrder ? { sidebarOrder } : {}),
  };
}

export function normalizeSessionPersonViews(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [rawPersonId, rawView] of Object.entries(value)) {
    const personId = trimString(rawPersonId);
    if (!personId) continue;
    const view = normalizeSessionPersonView(rawView);
    if (Object.keys(view).length > 0) result[personId] = view;
  }
  return result;
}

export function getSessionPersonView(session, personId) {
  const normalizedPersonId = trimString(personId);
  if (!normalizedPersonId) return {};
  return normalizeSessionPersonView(session?.personViews?.[normalizedPersonId]);
}

export function projectSessionPersonView(session, personId) {
  if (!session || typeof session !== 'object') return session;
  if (!trimString(personId)) {
    return {
      ...session,
      ...getSessionPersonView(session, DEFAULT_PERSON_ID),
    };
  }
  const projected = { ...session };
  delete projected.personViews;
  delete projected.space;
  delete projected.group;
  delete projected.sidebarOrder;
  return {
    ...projected,
    ...getSessionPersonView(session, personId),
  };
}

export function updateSessionPersonView(session, personId, patch = {}) {
  const normalizedPersonId = trimString(personId);
  if (!session || typeof session !== 'object' || !normalizedPersonId) return false;
  const currentViews = normalizeSessionPersonViews(session.personViews);
  const current = currentViews[normalizedPersonId] || {};
  const next = { ...current };

  if (Object.prototype.hasOwnProperty.call(patch, 'space')) {
    const value = normalizeSessionSpace(patch.space || '');
    if (value) next.space = value;
    else delete next.space;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'group')) {
    const value = normalizeSessionGroup(patch.group || '');
    if (value) next.group = value;
    else delete next.group;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'sidebarOrder')) {
    const value = normalizeSessionSidebarOrder(patch.sidebarOrder);
    if (value) next.sidebarOrder = value;
    else delete next.sidebarOrder;
  }

  const normalizedNext = normalizeSessionPersonView(next);
  const changed = JSON.stringify(current) !== JSON.stringify(normalizedNext)
    || JSON.stringify(session.personViews || {}) !== JSON.stringify(currentViews);
  if (!changed) return false;
  if (Object.keys(normalizedNext).length > 0) currentViews[normalizedPersonId] = normalizedNext;
  else delete currentViews[normalizedPersonId];
  if (Object.keys(currentViews).length > 0) session.personViews = currentViews;
  else delete session.personViews;
  return true;
}
