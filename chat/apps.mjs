import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { APPS_FILE } from '../lib/config.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { resolveDefaultStarterToolId } from './starter-session-content.mjs';

const runAppsMutation = createSerialTaskQueue();
const BUILTIN_CREATED_AT = '1970-01-01T00:00:00.000Z';

export const DEFAULT_APP_ID = 'chat';
export const EMAIL_APP_ID = 'email';
export const BUILTIN_APPS = Object.freeze([
  Object.freeze({
    id: DEFAULT_APP_ID,
    name: 'Chat',
    builtin: true,
    templateSelectable: false,
    createdAt: BUILTIN_CREATED_AT,
  }),
  Object.freeze({
    id: EMAIL_APP_ID,
    name: 'Email',
    builtin: true,
    templateSelectable: false,
    showInSidebarWhenEmpty: false,
    createdAt: BUILTIN_CREATED_AT,
  }),
]);

const BUILTIN_APP_MAP = new Map(BUILTIN_APPS.map((app) => [app.id, app]));

function cloneApp(app) {
  return app ? JSON.parse(JSON.stringify(app)) : null;
}

async function resolveDefaultAppToolId() {
  return resolveDefaultStarterToolId();
}

async function materializeApp(app, { defaultToolId = '' } = {}) {
  const cloned = cloneApp(app);
  if (!cloned) return null;
  if (!cloned.tool) {
    cloned.tool = defaultToolId || await resolveDefaultAppToolId();
  }
  return cloned;
}

function normalizeTemplateContext(templateContext) {
  const content = typeof templateContext?.content === 'string'
    ? templateContext.content.trim()
    : '';
  if (!content) return null;
  return {
    content,
    sourceSessionId: typeof templateContext?.sourceSessionId === 'string'
      ? templateContext.sourceSessionId.trim()
      : '',
    sourceSessionName: typeof templateContext?.sourceSessionName === 'string'
      ? templateContext.sourceSessionName.trim()
      : '',
    sourceSessionUpdatedAt: typeof templateContext?.sourceSessionUpdatedAt === 'string'
      ? templateContext.sourceSessionUpdatedAt.trim()
      : '',
    updatedAt: typeof templateContext?.updatedAt === 'string' && templateContext.updatedAt.trim()
      ? templateContext.updatedAt.trim()
      : new Date().toISOString(),
  };
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
  const defaultToolId = await resolveDefaultAppToolId();
  return Promise.all(mergeApps(await loadApps()).map((app) => materializeApp(app, { defaultToolId })));
}

export async function getApp(id) {
  const builtin = getBuiltinApp(id);
  if (builtin) return materializeApp(builtin);
  const apps = await loadApps();
  const existing = apps.find((app) => app.id === id);
  if (existing) return existing.deleted ? null : existing;
  return null;
}

export async function getAppByShareToken(shareToken) {
  if (!shareToken) return null;
  const builtin = BUILTIN_APPS.find((app) => app.shareToken === shareToken);
  if (builtin) return materializeApp(builtin);
  const apps = await loadApps();
  const existing = apps.find((app) => app.shareToken === shareToken);
  if (existing) return existing.deleted ? null : existing;
  return null;
}

export async function createApp(input = {}) {
  const {
    name,
    systemPrompt,
    welcomeMessage,
    skills,
    tool,
    templateContext,
  } = input;
  return runAppsMutation(async () => {
    const id = `app_${randomBytes(16).toString('hex')}`;
    const shareToken = `share_${randomBytes(32).toString('hex')}`;
    const resolvedTool = typeof tool === 'string' && tool.trim()
      ? tool.trim()
      : await resolveDefaultAppToolId();
    const app = {
      id,
      name: name || 'Untitled Agent',
      systemPrompt: systemPrompt || '',
      welcomeMessage: welcomeMessage || '',
      skills: skills || [],
      tool: resolvedTool,
      shareToken,
      createdAt: new Date().toISOString(),
    };
    const normalizedTemplateContext = normalizeTemplateContext(templateContext);
    if (normalizedTemplateContext) {
      app.templateContext = normalizedTemplateContext;
    }
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
    if (Object.prototype.hasOwnProperty.call(updates, 'templateContext')) {
      const templateContext = normalizeTemplateContext(updates.templateContext);
      if (templateContext) {
        apps[idx].templateContext = templateContext;
      } else {
        delete apps[idx].templateContext;
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

export const listAgents = listApps;
export const getAgent = getApp;
export const getAgentByShareToken = getAppByShareToken;
export const createAgent = createApp;
export const updateAgent = updateApp;
export const deleteAgent = deleteApp;
