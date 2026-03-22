import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { APPS_FILE, AUTH_FILE, CHAT_PORT, CHAT_SESSIONS_FILE, USERS_FILE, VISITORS_FILE } from '../lib/config.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';

const runAppsMutation = createSerialTaskQueue();
const BUILTIN_CREATED_AT = '1970-01-01T00:00:00.000Z';
const LEGACY_VIDEO_CUT_APP_ID = 'app_video_cut';
const LEGACY_VIDEO_CUT_SHARE_TOKEN = 'share_builtin_video_cut_84f1b7fa9de446c59994a1d4a57f1316';
const LEGACY_VIDEO_CUT_APP = Object.freeze({
  id: LEGACY_VIDEO_CUT_APP_ID,
  name: 'Video Cut',
  tool: 'codex',
  shareToken: LEGACY_VIDEO_CUT_SHARE_TOKEN,
  systemPrompt: [
    'You are the Video Cut app inside RemoteLab.',
    'This app is specifically for the local Video Cut Review skill and workflow on this machine.',
    'When the user asks to cut a video or uploads a source video, you should use the local video-cut workflow under ~/code/video-cut and follow the guidance in ~/.remotelab/skills/video-cut-review.md when needed.',
    'Treat the workflow as: video -> ASR -> transcript -> LLM cuts -> kept-content review -> FFmpeg render.',
    'Never skip the kept-content review gate before the real render.',
    'For remote or mobile review, paste a compressed kept-content draft directly into chat instead of only returning file paths.',
    'First gather or infer: what to keep, what to cut, target length, tone/style, and the desired final outcome.',
    'Before any render step, produce a concise review package with: kept moments, removed moments, ordered cut timeline, subtitle draft, open questions, and a simple confirmation prompt.',
    'If the request is underspecified, ask only the smallest number of follow-up questions needed to move forward.',
    'If the local workflow is blocked, say exactly which step is blocked and what artifact or input is missing.',
    'Keep the experience mobile-friendly and concrete.',
    'Always answer in the user\'s language.',
    'Do not claim the final video has been rendered unless that actually happened.',
  ].join(' '),
  welcomeMessage: [
    '请上传一段原始视频，并简单说明你想保留什么、想剪掉什么，以及目标成片大概多长。',
    '我会使用本机的 Video Cut Review / video-cut 工作流来处理这件事，而不是只做泛泛的聊天建议。',
    '我会先给你一版 review：保留内容、剪辑时间线、字幕草稿；等你确认后，再进入正式剪辑。',
  ].join('\n\n'),
  createdAt: BUILTIN_CREATED_AT,
});

export const DEFAULT_APP_ID = 'chat';
export const EMAIL_APP_ID = 'email';
export const BASIC_CHAT_APP_ID = 'app_basic_chat';
export const CREATE_APP_APP_ID = 'app_create_app';
export const DEFAULT_APP_TOOL = 'codex';
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
    id: BASIC_CHAT_APP_ID,
    name: 'Basic Chat',
    builtin: true,
    templateSelectable: true,
    shareEnabled: false,
    tool: DEFAULT_APP_TOOL,
    systemPrompt: '',
    welcomeMessage: '',
    createdAt: BUILTIN_CREATED_AT,
  }),
  Object.freeze({
    id: CREATE_APP_APP_ID,
    name: 'Create App',
    builtin: true,
    templateSelectable: true,
    shareEnabled: false,
    tool: DEFAULT_APP_TOOL,
    systemPrompt: [
      'You are the Create App starter app inside RemoteLab.',
      'Your job is to turn the user\'s rough SOP or workflow idea into a real RemoteLab app and finish the full creation flow with minimal back-and-forth.',
      'The user should only need to describe the business workflow: who the app is for, what input they provide, what steps the AI should follow, what output they expect, and any review gates, tone, constraints, examples, or edge cases.',
      'Do not make the user think about prompts, payloads, APIs, tools, share tokens, or other implementation details unless a real blocker forces it.',
      'Ask at most one focused batch of follow-up questions when essential information is missing. Infer reasonable defaults whenever possible.',
      'Before creating anything, synthesize the request into a concrete app definition with these sections: Name, Purpose, Target User, Inputs, Workflow, Output, Review Gates, Welcome Message, System Prompt, Default Tool, and Share Plan.',
      'Do not stop at writing the spec once the request is clear enough. Actually create or update the RemoteLab app in product state unless you are blocked by a real authorization or environment problem.',
      `Use the owner-authenticated RemoteLab app APIs for product-state changes: create with POST /api/apps, update with PATCH /api/apps/:id, inspect with GET /api/apps. The create or update payload should include name, welcomeMessage, systemPrompt, and tool. Default to ${DEFAULT_APP_TOOL} unless the workflow clearly needs a different tool.`,
      'If the user is clearly iterating on an existing app, prefer updating that app instead of creating a duplicate.',
      `When you need a direct local base URL on this machine, use the primary RemoteLab plane at http://127.0.0.1:${CHAT_PORT} unless the current deployment context clearly provides another origin.`,
      `If you need owner auth for API calls and do not already have a valid owner cookie, bootstrap one via GET /?token=... using the local owner token from ${AUTH_FILE}, store the returned session_token in a cookie jar, and reuse it for later API calls.`,
      'After the app is created successfully, read the returned shareToken and construct the app share link on the same origin as the API call: /app/{shareToken}. Return that full link directly to the user and explain in simple product language that they can send this link to other people to use the app.',
      'Encourage a quick self-test in a private or incognito window before broad sharing, but do not hold the flow open waiting for that test unless the user asks.',
      'If the user explicitly wants person-specific distribution instead of a general app link, you may create a dedicated visitor link with POST /api/visitors using the shareable app id and return the resulting /visitor/{shareToken} URL.',
      'Keep user-facing replies mobile-friendly and outcome-oriented: summarize the app, confirm it was created or updated, and provide the next action or share link.',
      'Always answer in the user\'s language.',
      'Do not pretend the app has been created in product state unless that action was actually performed.',
    ].join(' '),
    welcomeMessage: [
      '直接告诉我这个 App 的 SOP / 工作流就行。',
      '最好一次性讲清楚：它给谁用、用户会提供什么输入、AI 应该按什么步骤执行、需要什么审核或确认、最终交付什么结果，以及语气、限制、示例或边界条件。',
      '你不需要自己设计提示词、配置项或分享方式；我会把这些整理成一个可落地的 RemoteLab App，尽量直接帮你创建出来，并把分享给别人的链接一起准备好。',
      '如果还有关键缺失信息，我会一次性补问；如果信息已经够了，我会直接继续完成创建和分享准备。',
    ].join('\n\n'),
    createdAt: BUILTIN_CREATED_AT,
  }),
]);

const BUILTIN_APP_MAP = new Map(BUILTIN_APPS.map((app) => [app.id, app]));

function cloneApp(app) {
  return app ? JSON.parse(JSON.stringify(app)) : null;
}

function findLegacyVideoCutAppRecord(apps = []) {
  return apps.find((app) => app && (app.id === LEGACY_VIDEO_CUT_APP_ID || app.shareToken === LEGACY_VIDEO_CUT_SHARE_TOKEN)) || null;
}

async function hasLegacyVideoCutReferences() {
  const [users, visitors, sessions] = await Promise.all([
    readJson(USERS_FILE, []),
    readJson(VISITORS_FILE, []),
    readJson(CHAT_SESSIONS_FILE, []),
  ]);
  const normalizedUsers = Array.isArray(users) ? users : [];
  if (normalizedUsers.some((user) => user && !user.deleted && (
    user.defaultAppId === LEGACY_VIDEO_CUT_APP_ID
    || (Array.isArray(user.appIds) && user.appIds.includes(LEGACY_VIDEO_CUT_APP_ID))
  ))) {
    return true;
  }

  const normalizedVisitors = Array.isArray(visitors) ? visitors : [];
  if (normalizedVisitors.some((visitor) => visitor && !visitor.deleted && visitor.appId === LEGACY_VIDEO_CUT_APP_ID)) {
    return true;
  }

  const normalizedSessions = Array.isArray(sessions) ? sessions : [];
  return normalizedSessions.some((session) => session && !session.deleted && normalizeAppId(session.appId) === LEGACY_VIDEO_CUT_APP_ID);
}

async function materializeLegacyVideoCutApp({ force = false } = {}) {
  return runAppsMutation(async () => {
    const apps = await loadApps();
    const existing = findLegacyVideoCutAppRecord(apps);
    if (existing) {
      return existing.deleted ? null : cloneApp(existing);
    }
    if (!force && !await hasLegacyVideoCutReferences()) {
      return null;
    }
    const app = cloneApp(LEGACY_VIDEO_CUT_APP);
    apps.push(app);
    await saveApps(apps);
    return app;
  });
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
  await materializeLegacyVideoCutApp();
  return mergeApps(await loadApps());
}

export async function getApp(id) {
  const builtin = getBuiltinApp(id);
  if (builtin) return builtin;
  const apps = await loadApps();
  const existing = apps.find((app) => app.id === id);
  if (existing) return existing.deleted ? null : existing;
  if (normalizeAppId(id) === LEGACY_VIDEO_CUT_APP_ID) {
    return materializeLegacyVideoCutApp();
  }
  return null;
}

export async function getAppByShareToken(shareToken) {
  if (!shareToken) return null;
  const builtin = BUILTIN_APPS.find((app) => app.shareToken === shareToken);
  if (builtin) return cloneApp(builtin);
  const apps = await loadApps();
  const existing = apps.find((app) => app.shareToken === shareToken);
  if (existing) return existing.deleted ? null : existing;
  if (shareToken === LEGACY_VIDEO_CUT_SHARE_TOKEN) {
    return materializeLegacyVideoCutApp({ force: true });
  }
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
    const app = {
      id,
      name: name || 'Untitled App',
      systemPrompt: systemPrompt || '',
      welcomeMessage: welcomeMessage || '',
      skills: skills || [],
      tool: tool || DEFAULT_APP_TOOL,
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
