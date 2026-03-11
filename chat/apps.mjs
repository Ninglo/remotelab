import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { APPS_FILE } from '../lib/config.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';

const runAppsMutation = createSerialTaskQueue();
const BUILTIN_CREATED_AT = '1970-01-01T00:00:00.000Z';

export const DEFAULT_APP_ID = 'chat';
export const BUILTIN_APPS = Object.freeze([
  Object.freeze({ id: DEFAULT_APP_ID, name: 'Chat', builtin: true, createdAt: BUILTIN_CREATED_AT }),
  Object.freeze({ id: 'feishu', name: 'Lark', builtin: true, createdAt: BUILTIN_CREATED_AT }),
  Object.freeze({ id: 'email', name: 'Email', builtin: true, createdAt: BUILTIN_CREATED_AT }),
  Object.freeze({ id: 'github', name: 'GitHub', builtin: true, createdAt: BUILTIN_CREATED_AT }),
  Object.freeze({ id: 'automation', name: 'Automation', builtin: true, createdAt: BUILTIN_CREATED_AT }),
]);

const BUILTIN_APP_MAP = new Map(BUILTIN_APPS.map((app) => [app.id, app]));

function cloneApp(app) {
  return app ? { ...app } : null;
}

export function normalizeAppId(appId, { fallbackDefault = false } = {}) {
  const trimmed = typeof appId === 'string' ? appId.trim() : '';
  if (!trimmed) {
    return fallbackDefault ? DEFAULT_APP_ID : '';
  }

  const builtinId = trimmed.toLowerCase();
  if (BUILTIN_APP_MAP.has(builtinId)) {
    return builtinId;
  }

  return trimmed;
}

export function resolveEffectiveAppId(appId) {
  return normalizeAppId(appId, { fallbackDefault: true });
}

export function isBuiltinAppId(appId) {
  const normalized = normalizeAppId(appId);
  return normalized ? BUILTIN_APP_MAP.has(normalized) : false;
}

export function getBuiltinApp(appId) {
  const normalized = normalizeAppId(appId);
  if (!normalized) return null;
  return cloneApp(BUILTIN_APP_MAP.get(normalized));
}

function mergeApps(list) {
  const merged = new Map(BUILTIN_APPS.map((app) => [app.id, cloneApp(app)]));
  for (const app of list) {
    if (!app || app.deleted || !app.id || merged.has(app.id)) continue;
    merged.set(app.id, cloneApp(app));
  }
  return [...merged.values()];
}

async function loadApps() {
  const apps = await readJson(APPS_FILE, []);
  return Array.isArray(apps) ? apps : [];
}

async function saveApps(list) {
  const dir = dirname(APPS_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(APPS_FILE, list);
}

export async function listApps() {
  return mergeApps(await loadApps());
}

export async function getApp(id) {
  const builtin = getBuiltinApp(id);
  if (builtin) return builtin;
  return (await loadApps()).find((app) => app.id === id && !app.deleted) || null;
}

export async function getAppByShareToken(shareToken) {
  if (!shareToken) return null;
  return (await loadApps()).find((app) => app.shareToken === shareToken && !app.deleted) || null;
}

export async function createApp({ name, systemPrompt, welcomeMessage, skills, tool }) {
  return runAppsMutation(async () => {
    const id = `app_${randomBytes(16).toString('hex')}`;
    const shareToken = `share_${randomBytes(32).toString('hex')}`;
    const app = {
      id,
      name: name || 'Untitled App',
      systemPrompt: systemPrompt || '',
      welcomeMessage: welcomeMessage || '',
      skills: skills || [],
      tool: tool || 'codex',
      shareToken,
      createdAt: new Date().toISOString(),
    };
    const apps = await loadApps();
    apps.push(app);
    await saveApps(apps);
    return app;
  });
}

export async function updateApp(id, updates) {
  if (isBuiltinAppId(id)) return null;
  return runAppsMutation(async () => {
    const apps = await loadApps();
    const idx = apps.findIndex((app) => app.id === id && !app.deleted);
    if (idx === -1) return null;
    const allowed = ['name', 'systemPrompt', 'welcomeMessage', 'skills', 'tool'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        apps[idx][key] = updates[key];
      }
    }
    apps[idx].updatedAt = new Date().toISOString();
    await saveApps(apps);
    return apps[idx];
  });
}

export async function deleteApp(id) {
  if (isBuiltinAppId(id)) return false;
  return runAppsMutation(async () => {
    const apps = await loadApps();
    const idx = apps.findIndex((app) => app.id === id && !app.deleted);
    if (idx === -1) return false;
    apps[idx].deleted = true;
    apps[idx].deletedAt = new Date().toISOString();
    await saveApps(apps);
    return true;
  });
}
