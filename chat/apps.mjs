import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { APPS_FILE } from '../lib/config.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';

const runAppsMutation = createSerialTaskQueue();
const BUILTIN_CREATED_AT = '1970-01-01T00:00:00.000Z';

export const DEFAULT_APP_ID = 'chat';
export const EMAIL_APP_ID = 'email';
export const CREATE_APP_APP_ID = 'app_create_app';
export const VIDEO_CUT_APP_ID = 'app_video_cut';
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
  Object.freeze({
    id: CREATE_APP_APP_ID,
    name: 'Create App',
    builtin: true,
    templateSelectable: true,
    tool: 'codex',
    shareToken: 'share_builtin_create_app_6b2f4d06ad0b4b8cb3cb6255c7d35b95',
    systemPrompt: [
      'You are the Create App starter app inside RemoteLab.',
      'Help the user turn a rough idea into a concrete app specification with minimal back-and-forth.',
      'Collect only the essential missing details: app name, target user, source/connector if relevant, input shape, desired workflow, output, review/approval steps, and success criteria.',
      'Once the request is clear enough, produce a compact app spec with these sections: Name, Purpose, Source/Connector, Welcome Message, System Prompt, Default Tool, and Notes.',
      'Prefer a lightweight mobile-friendly flow. Ask focused follow-up questions only when required.',
      'Always answer in the user\'s language.',
      'Do not pretend the app has been created in product state unless that action was actually performed.',
    ].join(' '),
    welcomeMessage: [
      '告诉我你想创建什么 App。',
      '最好一起说明：它是给谁用的、用户会提供什么输入、你希望它完成什么流程、最终产出是什么。',
      '我会先帮你整理成一版可落地的 App 规格，包括欢迎语和系统提示词。',
    ].join('\n\n'),
    createdAt: BUILTIN_CREATED_AT,
  }),
  Object.freeze({
    id: VIDEO_CUT_APP_ID,
    name: 'Video Cut',
    builtin: true,
    templateSelectable: true,
    tool: 'codex',
    shareToken: 'share_builtin_video_cut_84f1b7fa9de446c59994a1d4a57f1316',
    systemPrompt: [
      'You are the Video Cut app inside RemoteLab.',
      'Your job is to help the user turn an uploaded source video and rough editing intent into a review-first editing plan.',
      'First gather or infer: what to keep, what to cut, target length, tone/style, and the desired final outcome.',
      'Before any render step, produce a concise review package with: kept moments, removed moments, ordered cut timeline, subtitle draft, open questions, and a simple confirmation prompt.',
      'If the request is underspecified, ask only the smallest number of follow-up questions needed to move forward.',
      'Keep the experience mobile-friendly and concrete.',
      'Always answer in the user\'s language.',
      'Do not claim the final video has been rendered unless that actually happened.',
    ].join(' '),
    welcomeMessage: [
      '请上传一段原始视频，并简单说明你想保留什么、想剪掉什么，以及目标成片大概多长。',
      '我会先给你一版 review：保留内容、剪辑时间线、字幕草稿。',
      '等你确认后，再进入正式剪辑。',
    ].join('\n\n'),
    createdAt: BUILTIN_CREATED_AT,
  }),
]);

const BUILTIN_APP_MAP = new Map(BUILTIN_APPS.map((app) => [app.id, app]));

function cloneApp(app) {
  return app ? JSON.parse(JSON.stringify(app)) : null;
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
  return mergeApps(await loadApps());
}

export async function getApp(id) {
  const builtin = getBuiltinApp(id);
  if (builtin) return builtin;
  return (await loadApps()).find((app) => app.id === id && !app.deleted) || null;
}

export async function getAppByShareToken(shareToken) {
  if (!shareToken) return null;
  const builtin = BUILTIN_APPS.find((app) => app.shareToken === shareToken);
  if (builtin) return cloneApp(builtin);
  return (await loadApps()).find((app) => app.shareToken === shareToken && !app.deleted) || null;
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
