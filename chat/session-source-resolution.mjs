/**
 * Session source, visitor, and template context resolution.
 *
 * Extracted from session-manager.mjs — pure functions for resolving
 * session source (app, fork, direct), visitor display names,
 * and template context content.
 */

import {
  DEFAULT_APP_ID,
  getBuiltinApp,
  normalizeAppId,
} from './apps.mjs';

// ── Name normalization ───────────────────────────────────────────────

export function normalizeSessionTemplateName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeSessionSourceName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeSessionVisitorName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeSessionUserName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

export function formatSessionSourceNameFromId(sourceId) {
  const normalized = typeof sourceId === 'string' ? sourceId.trim() : '';
  if (!normalized) return 'Chat';
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// ── Source resolution ────────────────────────────────────────────────

export function resolveSessionSourceId(meta) {
  const explicitSourceId = normalizeAppId(meta?.sourceId);
  if (explicitSourceId) return explicitSourceId;
  return DEFAULT_APP_ID;
}

export function resolveSessionSourceName(meta, sourceId = resolveSessionSourceId(meta)) {
  const explicitSourceName = normalizeSessionSourceName(meta?.sourceName);
  if (explicitSourceName) return explicitSourceName;

  const builtinSource = getBuiltinApp(sourceId);
  if (builtinSource?.name) return builtinSource.name;

  return formatSessionSourceNameFromId(sourceId);
}

export function hasRequestedSessionSourceHint(extra = {}) {
  const explicitSourceId = normalizeAppId(extra?.sourceId);
  return !!explicitSourceId;
}

export function resolveRequestedSessionSourceId(extra = {}) {
  const explicitSourceId = normalizeAppId(extra?.sourceId);
  if (explicitSourceId) return explicitSourceId;

  return DEFAULT_APP_ID;
}

export function resolveRequestedSessionSourceName(extra = {}, sourceId = resolveRequestedSessionSourceId(extra)) {
  const explicitSourceName = normalizeSessionSourceName(extra?.sourceName);
  if (explicitSourceName) return explicitSourceName;

  const builtinSource = getBuiltinApp(sourceId);
  if (builtinSource?.name) return builtinSource.name;

  return formatSessionSourceNameFromId(sourceId);
}

// ── Template resolution ──────────────────────────────────────────────

export function resolveSessionTemplateId(meta) {
  return normalizeAppId(meta?.templateId);
}

export function resolveSessionTemplateName(meta) {
  return normalizeSessionTemplateName(meta?.templateName);
}

// ── Template context helpers ─────────────────────────────────────────

export function buildSavedTemplateContextContent(prepared) {
  if (!prepared) return '';

  const summary = typeof prepared.summary === 'string' ? prepared.summary.trim() : '';
  const continuationBody = typeof prepared.continuationBody === 'string'
    ? prepared.continuationBody.trim()
    : '';
  const parts = [];

  if (summary) {
    parts.push(`[Conversation summary]\n\n${summary}`);
  }
  if (continuationBody) {
    parts.push(continuationBody);
  }

  return parts.join('\n\n---\n\n').trim();
}

export function parseTimestampMs(value) {
  const timestamp = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}
