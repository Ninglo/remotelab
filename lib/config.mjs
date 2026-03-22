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

export const AUTH_FILE = join(configDir, 'auth.json');
export const TOOLS_FILE = join(configDir, 'tools.json');
export const AUTH_SESSIONS_FILE = join(configDir, 'auth-sessions.json');
export const CHAT_SESSIONS_FILE = join(configDir, 'chat-sessions.json');
export const CHAT_TRIGGERS_FILE = join(configDir, 'chat-triggers.json');
export const CHAT_HISTORY_DIR = join(configDir, 'chat-history');
export const CHAT_RUNS_DIR = join(configDir, 'chat-runs');
export const CHAT_IMAGES_DIR = join(configDir, 'images');
export const API_REQUEST_LOGS_DIR = join(configDir, 'api-logs');
export const CHAT_SHARE_SNAPSHOTS_DIR = join(configDir, 'shared-snapshots');
export const VAPID_KEYS_FILE = join(configDir, 'vapid-keys.json');
export const PUSH_SUBSCRIPTIONS_FILE = join(configDir, 'push-subscriptions.json');
export const APPS_FILE = join(configDir, 'apps.json');
export const USERS_FILE = join(configDir, 'users.json');
export const VISITORS_FILE = join(configDir, 'visitors.json');
export const UI_RUNTIME_SELECTION_FILE = join(configDir, 'ui-runtime-selection.json');
export const VOICE_INPUT_CONFIG_FILE = join(configDir, 'voice-input.json');
export const CODEX_MANAGED_HOME_DIR = join(configDir, 'provider-runtime-homes', 'codex');

// RemoteLab memory directories (model-managed persistent storage)
// User-level: private to this machine (preferences, local paths, personal habits)
export const MEMORY_DIR = resolveOverridePath(process.env.REMOTELAB_MEMORY_DIR)
  || (INSTANCE_ROOT ? join(INSTANCE_ROOT, 'memory') : join(homedir(), '.remotelab', 'memory'));
// System-level: universal learnings stored in the code repo (shared across deployments)
export const SYSTEM_MEMORY_DIR = join(SOURCE_PROJECT_ROOT, 'memory');
