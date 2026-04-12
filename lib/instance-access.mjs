import { readFile } from 'fs/promises';
import { basename } from 'path';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePathSegment(value) {
  return trimString(value).replace(/^\/+|\/+$/g, '');
}

function normalizeBaseUrlTemplate(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  if (trimmed.includes('{name}')) return trimmed.replace(/\/+$/, '');
  return normalizeBaseUrl(trimmed);
}

export function normalizeBaseUrl(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function appendUrlPath(baseUrl, segment) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedSegment = normalizePathSegment(segment);
  if (!normalizedBaseUrl) return '';
  if (!normalizedSegment) return normalizedBaseUrl;
  return `${normalizedBaseUrl}/${normalizedSegment}`;
}

export function buildAccessUrl(baseUrl, token = '') {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return '';
  return token ? `${normalizedBaseUrl}/?token=${token}` : normalizedBaseUrl;
}

function inferInstanceName({ instanceName = '', instanceRoot = '' } = {}) {
  const normalizedName = normalizePathSegment(instanceName);
  if (normalizedName) return normalizedName;
  const normalizedRoot = trimString(instanceRoot);
  if (!normalizedRoot) return '';
  return normalizePathSegment(basename(normalizedRoot));
}

async function readJsonFile(filePath, fallbackValue) {
  const normalizedPath = trimString(filePath);
  if (!normalizedPath) return fallbackValue;
  try {
    return JSON.parse(await readFile(normalizedPath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

export function normalizeInstanceAccessDefaults(raw = {}) {
  const publicDomain = trimString(
    raw.publicDomain
    || raw.publicDomainSuffix
    || '',
  ).replace(/^\.+|\.+$/g, '').toLowerCase();
  const bridgeBaseUrlTemplate = normalizeBaseUrlTemplate(raw.bridgeBaseUrlTemplate || '');
  const bridgeRootBaseUrl = normalizeBaseUrl(raw.bridgeRootBaseUrl || '');

  return {
    publicDomain,
    bridgeBaseUrlTemplate,
    bridgeRootBaseUrl,
  };
}

export async function loadInstanceAccessDefaults({
  defaultsFilePath = '',
  env = process.env,
} = {}) {
  const persisted = await readJsonFile(defaultsFilePath, {});
  return normalizeInstanceAccessDefaults({
    ...persisted,
    publicDomain: trimString(
      env?.REMOTELAB_GUEST_PUBLIC_DOMAIN
      || persisted?.publicDomain
      || persisted?.publicDomainSuffix
      || '',
    ),
    bridgeBaseUrlTemplate: trimString(
      env?.REMOTELAB_BRIDGE_BASE_URL_TEMPLATE
      || persisted?.bridgeBaseUrlTemplate
      || '',
    ),
    bridgeRootBaseUrl: trimString(
      env?.REMOTELAB_BRIDGE_ROOT_BASE_URL
      || persisted?.bridgeRootBaseUrl
      || '',
    ),
  });
}

export function resolveBaseUrlTemplate(template = '', {
  instanceName = '',
  instanceRoot = '',
} = {}) {
  const normalizedTemplate = normalizeBaseUrlTemplate(template);
  if (!normalizedTemplate) return '';
  if (!normalizedTemplate.includes('{name}')) return normalizeBaseUrl(normalizedTemplate);

  const resolvedInstanceName = inferInstanceName({ instanceName, instanceRoot });
  if (!resolvedInstanceName) return '';

  return normalizeBaseUrl(
    normalizedTemplate.replaceAll('{name}', resolvedInstanceName),
  );
}

export function resolveBridgeBaseUrl({
  instanceName = '',
  instanceRoot = '',
  explicitBaseUrl = '',
  bridgeBaseUrlTemplate = '',
  bridgeRootBaseUrl = '',
} = {}) {
  const normalizedExplicitBaseUrl = normalizeBaseUrl(explicitBaseUrl);
  if (normalizedExplicitBaseUrl) return normalizedExplicitBaseUrl;

  const resolvedTemplateBaseUrl = resolveBaseUrlTemplate(bridgeBaseUrlTemplate, {
    instanceName,
    instanceRoot,
  });
  if (resolvedTemplateBaseUrl) return resolvedTemplateBaseUrl;

  const normalizedRootBaseUrl = normalizeBaseUrl(bridgeRootBaseUrl);
  if (!normalizedRootBaseUrl) return '';

  const resolvedInstanceName = inferInstanceName({ instanceName, instanceRoot });
  return resolvedInstanceName
    ? appendUrlPath(normalizedRootBaseUrl, resolvedInstanceName)
    : normalizedRootBaseUrl;
}

export function buildBridgeBaseUrl(name, defaults = null) {
  return resolveBridgeBaseUrl({
    instanceName: name,
    bridgeBaseUrlTemplate: defaults?.bridgeBaseUrlTemplate,
    bridgeRootBaseUrl: defaults?.bridgeRootBaseUrl,
  });
}

function createAccessChannel({
  key,
  label,
  baseUrl,
  token = '',
  remote = false,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const accessUrl = buildAccessUrl(normalizedBaseUrl, token);
  if (!normalizedBaseUrl && !accessUrl) return null;
  return {
    key: trimString(key),
    label: trimString(label),
    baseUrl: normalizedBaseUrl,
    accessUrl,
    remote,
  };
}

export function buildInstanceAccessChannels({
  publicBaseUrl = '',
  bridgeBaseUrl = '',
  localBaseUrl = '',
  token = '',
} = {}) {
  return [
    createAccessChannel({
      key: 'public',
      label: 'Public',
      baseUrl: publicBaseUrl,
      token,
      remote: true,
    }),
    createAccessChannel({
      key: 'bridge',
      label: 'Bridge',
      baseUrl: bridgeBaseUrl,
      token,
      remote: true,
    }),
    createAccessChannel({
      key: 'local',
      label: 'Local',
      baseUrl: localBaseUrl,
      token,
      remote: false,
    }),
  ].filter(Boolean);
}

export function getAccessChannel(channels = [], key = '') {
  const normalizedKey = trimString(key);
  return (Array.isArray(channels) ? channels : []).find((channel) => trimString(channel?.key) === normalizedKey) || null;
}

export function pickBestAccessUrl(value = []) {
  if (value && !Array.isArray(value) && typeof value === 'object') {
    const directUrl = trimString(value.publicAccessUrl)
      || trimString(value.bridgeAccessUrl)
      || trimString(value.localAccessUrl)
      || trimString(value.accessUrl);
    if (directUrl) return directUrl;
  }
  const channels = Array.isArray(value)
    ? value
    : buildInstanceAccessChannels(value);
  return trimString(getAccessChannel(channels, 'public')?.accessUrl)
    || trimString(getAccessChannel(channels, 'bridge')?.accessUrl)
    || trimString(getAccessChannel(channels, 'local')?.accessUrl)
    || '';
}

export function attachInstanceAccess(record = {}, {
  token = '',
  bridgeBaseUrl = '',
} = {}) {
  const publicBaseUrl = normalizeBaseUrl(record.publicBaseUrl);
  const localBaseUrl = normalizeBaseUrl(record.localBaseUrl);
  const resolvedBridgeBaseUrl = normalizeBaseUrl(
    bridgeBaseUrl
    || record.bridgeBaseUrl
    || record.bridgeAccessBaseUrl
    || '',
  );
  const accessChannels = buildInstanceAccessChannels({
    publicBaseUrl,
    bridgeBaseUrl: resolvedBridgeBaseUrl,
    localBaseUrl,
    token,
  });
  const publicAccessUrl = trimString(getAccessChannel(accessChannels, 'public')?.accessUrl);
  const bridgeAccessUrl = trimString(getAccessChannel(accessChannels, 'bridge')?.accessUrl);
  const localAccessUrl = trimString(getAccessChannel(accessChannels, 'local')?.accessUrl);

  return {
    ...record,
    publicBaseUrl,
    localBaseUrl,
    publicAccessUrl,
    localAccessUrl,
    bridgeBaseUrl: resolvedBridgeBaseUrl,
    bridgeAccessUrl,
    accessChannels,
    accessUrl: pickBestAccessUrl(accessChannels),
  };
}
