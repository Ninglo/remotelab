import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdir } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PROJECT_ROOT = process.env.REMOTELAB_SOURCE_PROJECT_ROOT || join(__dirname, '..');

function validPort(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function validMs(val, min, max, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function validInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveOverridePath(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function normalizeBaseUrl(value) {
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

function envFlagEnabled(value, fallback = false) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return fallback;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function isVolcengineTosHost(hostname) {
  return /(^|\.)tos-[^.]+\.volces\.com$/i.test(trimString(hostname));
}

function normalizeFileAssetStorageProvider(value, urls = []) {
  const explicit = trimString(value).toLowerCase();
  if (['tos', 'volcengine-tos', 'volces-tos'].includes(explicit)) return 'tos';
  if (['s3', 'aws-s3', 's3-compatible', 'r2'].includes(explicit)) return 's3';

  for (const candidate of urls) {
    const normalized = normalizeBaseUrl(candidate);
    if (!normalized) continue;
    try {
      if (isVolcengineTosHost(new URL(normalized).hostname)) return 'tos';
    } catch {}
  }

  return 's3';
}

function normalizeTosBaseUrl(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    if (!isVolcengineTosHost(parsed.hostname)) return normalized;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return normalized;

    const bucket = segments[0];
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(bucket)) return normalized;
    if (parsed.hostname.toLowerCase().startsWith(`${bucket.toLowerCase()}.`)) return normalized;

    parsed.hostname = `${bucket}.${parsed.hostname}`;
    parsed.pathname = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return normalized;
  }
}

function normalizeFileAssetStorageUrl(value, provider) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return '';
  if (provider === 'tos') return normalizeTosBaseUrl(normalized);
  return normalized;
}

function extractOrigin(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return '';
  try {
    return new URL(normalized).origin;
  } catch {
    return '';
  }
}

export const SESSION_EXPIRY = validMs(
  process.env.SESSION_EXPIRY,
  60 * 1000,          // min: 1 minute
  30 * 24 * 60 * 60 * 1000, // max: 30 days
  24 * 60 * 60 * 1000  // default: 24 hours
);
export const SECURE_COOKIES = process.env.SECURE_COOKIES !== '0';

export const INSTANCE_ROOT = resolveOverridePath(process.env.REMOTELAB_INSTANCE_ROOT) || null;
export const CONFIG_DIR = resolveOverridePath(process.env.REMOTELAB_CONFIG_DIR)
  || (INSTANCE_ROOT ? join(INSTANCE_ROOT, 'config') : join(homedir(), '.config', 'remotelab'));
const configDir = CONFIG_DIR;
await mkdir(configDir, { recursive: true });

export const CHAT_PORT = validPort(process.env.CHAT_PORT, 7690);
export const CHAT_BIND_HOST = process.env.CHAT_BIND_HOST || '127.0.0.1';
export const SHARED_STARTUP_DEFAULTS_ENABLED = envFlagEnabled(
  process.env.REMOTELAB_ENABLE_SHARED_STARTUP_DEFAULTS,
  true,
);

export const AUTH_FILE = join(configDir, 'auth.json');
export const TOOLS_FILE = join(configDir, 'tools.json');
export const SHARED_TOOLS_DIR = resolveOverridePath(process.env.REMOTELAB_SHARED_TOOLS_DIR)
  || join(homedir(), '.remotelab', 'shared-tools');
export const TOOLS_ENABLED_FILE = resolveOverridePath(process.env.REMOTELAB_TOOLS_ENABLED_FILE)
  || join(configDir, 'tools-enabled.md');
export const TOOL_OVERLAYS_DIR = resolveOverridePath(process.env.REMOTELAB_TOOL_OVERLAYS_DIR)
  || join(configDir, 'tool-overlays');
export const AUTH_SESSIONS_FILE = join(configDir, 'auth-sessions.json');
export const INSTALL_HANDOFFS_FILE = join(configDir, 'install-handoffs.json');
export const CHAT_SESSIONS_FILE = join(configDir, 'chat-sessions.json');
export const CHAT_TRIGGERS_FILE = join(configDir, 'chat-triggers.json');
export const TASKS_FILE = join(configDir, 'tasks.json');
export const REPORTS_DIR = join(configDir, 'reports');
export const REPORTS_META_FILE = join(configDir, 'reports.json');
export const CHAT_HISTORY_DIR = join(configDir, 'chat-history');
export const CHAT_RUNS_DIR = join(configDir, 'chat-runs');
export const CHAT_IMAGES_DIR = join(configDir, 'images');
export const CHAT_FILE_ASSETS_DIR = join(configDir, 'file-assets');
export const CHAT_FILE_ASSET_CACHE_DIR = join(configDir, 'file-assets-cache');
export const API_REQUEST_LOGS_DIR = join(configDir, 'api-logs');
export const CHAT_SHARE_SNAPSHOTS_DIR = join(configDir, 'shared-snapshots');
export const VAPID_KEYS_FILE = join(configDir, 'vapid-keys.json');
export const PUSH_SUBSCRIPTIONS_FILE = join(configDir, 'push-subscriptions.json');
export const APPS_FILE = join(configDir, 'apps.json');
export const USERS_FILE = join(configDir, 'users.json');
export const VISITORS_FILE = join(configDir, 'visitors.json');
export const UI_RUNTIME_SELECTION_FILE = join(configDir, 'ui-runtime-selection.json');
export const CODEX_MANAGED_HOME_DIR = join(configDir, 'provider-runtime-homes', 'codex');

const rawFileAssetStorageBaseUrl = normalizeBaseUrl(process.env.REMOTELAB_ASSET_STORAGE_BASE_URL);
const rawFileAssetPublicBaseUrl = normalizeBaseUrl(process.env.REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL);
export const FILE_ASSET_STORAGE_PROVIDER = normalizeFileAssetStorageProvider(
  process.env.REMOTELAB_ASSET_STORAGE_PROVIDER,
  [rawFileAssetStorageBaseUrl, rawFileAssetPublicBaseUrl],
);
export const FILE_ASSET_STORAGE_BASE_URL = normalizeFileAssetStorageUrl(rawFileAssetStorageBaseUrl, FILE_ASSET_STORAGE_PROVIDER);
export const FILE_ASSET_PUBLIC_BASE_URL = normalizeFileAssetStorageUrl(rawFileAssetPublicBaseUrl, FILE_ASSET_STORAGE_PROVIDER);
export const FILE_ASSET_STORAGE_REGION = trimString(process.env.REMOTELAB_ASSET_STORAGE_REGION) || 'auto';
export const FILE_ASSET_STORAGE_ACCESS_KEY_ID = trimString(process.env.REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID);
export const FILE_ASSET_STORAGE_SECRET_ACCESS_KEY = trimString(process.env.REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY);
export const FILE_ASSET_STORAGE_KEY_PREFIX = (trimString(process.env.REMOTELAB_ASSET_STORAGE_KEY_PREFIX) || 'session-assets')
  .replace(/^\/+/, '')
  .replace(/\/+$/, '');
export const FILE_ASSET_STORAGE_PRESIGN_TTL_SECONDS = validInt(
  process.env.REMOTELAB_ASSET_STORAGE_PRESIGN_TTL_SECONDS,
  60,
  7 * 24 * 60 * 60,
  60 * 60,
);
export const FILE_ASSET_STORAGE_ENABLED = !!(
  FILE_ASSET_STORAGE_BASE_URL
  && FILE_ASSET_STORAGE_ACCESS_KEY_ID
  && FILE_ASSET_STORAGE_SECRET_ACCESS_KEY
  && FILE_ASSET_STORAGE_REGION
);
export const FILE_ASSET_DIRECT_UPLOAD_ENABLED = FILE_ASSET_STORAGE_ENABLED
  && envFlagEnabled(process.env.REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED, true);
export const FILE_ASSET_ALLOWED_ORIGINS = [...new Set([
  extractOrigin(FILE_ASSET_STORAGE_BASE_URL),
  extractOrigin(FILE_ASSET_PUBLIC_BASE_URL),
].filter(Boolean))];

// RemoteLab memory directories (model-managed persistent storage)
// User-level: private to this machine (preferences, local paths, personal habits)
export const MEMORY_DIR = resolveOverridePath(process.env.REMOTELAB_MEMORY_DIR)
  || (INSTANCE_ROOT ? join(INSTANCE_ROOT, 'memory') : join(homedir(), '.remotelab', 'memory'));
// System-level: universal learnings stored in the code repo (shared across deployments)
export const SYSTEM_MEMORY_DIR = join(SOURCE_PROJECT_ROOT, 'memory');
