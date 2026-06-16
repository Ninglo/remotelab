import { sanitizeGuestInstanceName } from './guest-instance.mjs';

export const DEFAULT_GUEST_ROUTE_TARGET_HOST = '127.0.0.1';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRouteHost(value) {
  return trimString(value).toLowerCase().replace(/\.+$/, '');
}

export function stripHostPort(value) {
  const normalized = normalizeRouteHost(value);
  if (!normalized) return '';
  if (normalized.startsWith('[')) {
    const closingIndex = normalized.indexOf(']');
    if (closingIndex >= 0) return normalized.slice(1, closingIndex);
  }
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon > 0 && normalized.indexOf(':') === lastColon) {
    return normalized.slice(0, lastColon);
  }
  return normalized;
}

export function firstHostnameLabel(value) {
  const normalized = stripHostPort(value);
  return sanitizeGuestInstanceName(normalized.split('.').filter(Boolean)[0] || '');
}

function resolveBaseHostname({ hostname = '', publicBaseUrl = '' } = {}) {
  const normalizedHostname = normalizeRouteHost(hostname);
  if (normalizedHostname) return normalizedHostname;
  const normalizedBaseUrl = trimString(publicBaseUrl);
  if (!normalizedBaseUrl) return '';
  try {
    return normalizeRouteHost(new URL(normalizedBaseUrl).hostname);
  } catch {
    return '';
  }
}

export function buildGuestExposedHostname({
  hostname = '',
  publicBaseUrl = '',
  label = '',
} = {}) {
  const normalizedLabel = sanitizeGuestInstanceName(label);
  if (!normalizedLabel) return '';

  const baseHostname = resolveBaseHostname({ hostname, publicBaseUrl });
  if (!baseHostname || !baseHostname.includes('.')) return '';

  const parts = baseHostname.split('.').filter(Boolean);
  if (parts.length < 2) return '';

  const baseLabel = sanitizeGuestInstanceName(parts[0]);
  if (!baseLabel) return '';

  return `${baseLabel}-${normalizedLabel}.${parts.slice(1).join('.')}`;
}

export function buildGuestRouteKey(record = {}) {
  const instanceName = sanitizeGuestInstanceName(record.instanceName || record.name);
  const label = sanitizeGuestInstanceName(record.label);
  return instanceName && label ? `${instanceName}:${label}` : '';
}

export function normalizeGuestRouteRecord(record = {}) {
  const createdAt = trimString(record.createdAt) || new Date().toISOString();
  return {
    instanceName: sanitizeGuestInstanceName(record.instanceName || record.name),
    label: sanitizeGuestInstanceName(record.label),
    port: Number.parseInt(record.port, 10) || 0,
    hostname: normalizeRouteHost(record.hostname),
    targetHost: stripHostPort(record.targetHost) || DEFAULT_GUEST_ROUTE_TARGET_HOST,
    createdAt,
    updatedAt: trimString(record.updatedAt) || createdAt,
  };
}

export function isPersistableGuestRouteRecord(record = {}) {
  const normalized = normalizeGuestRouteRecord(record);
  return Boolean(
    normalized.instanceName
    && normalized.label
    && normalized.hostname
    && normalized.targetHost
    && normalized.port >= 1
    && normalized.port <= 65535,
  );
}

export function mergePersistedGuestRouteRegistry(existingRecords = [], nextRecords = []) {
  const normalizedExisting = Array.isArray(existingRecords)
    ? existingRecords.map((record) => normalizeGuestRouteRecord(record)).filter((record) => isPersistableGuestRouteRecord(record))
    : [];
  const normalizedNext = Array.isArray(nextRecords)
    ? nextRecords.map((record) => normalizeGuestRouteRecord(record)).filter((record) => isPersistableGuestRouteRecord(record))
    : [];
  const nextByKey = new Map(normalizedNext.map((record) => [buildGuestRouteKey(record), record]));
  return [
    ...normalizedNext,
    ...normalizedExisting.filter((record) => !nextByKey.has(buildGuestRouteKey(record))),
  ].sort((leftRecord, rightRecord) => {
    const leftKey = `${leftRecord.instanceName}:${leftRecord.label}`;
    const rightKey = `${rightRecord.instanceName}:${rightRecord.label}`;
    return leftKey.localeCompare(rightKey, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

export function buildGuestRouteServiceTarget(record = {}) {
  const normalized = normalizeGuestRouteRecord(record);
  if (!isPersistableGuestRouteRecord(normalized)) return '';
  return `http://${normalized.targetHost}:${normalized.port}`;
}
