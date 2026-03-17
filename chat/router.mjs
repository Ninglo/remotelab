import { readFile, readdir } from 'fs/promises';
import { readFileSync, readdirSync, statSync, watch } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname, basename, extname, relative, isAbsolute, sep } from 'path';
import { parse as parseUrl, fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { SESSION_EXPIRY, CHAT_IMAGES_DIR, SECURE_COOKIES } from '../lib/config.mjs';
import {
  sessions, saveAuthSessionsAsync,
  verifyTokenAsync, verifyPasswordAsync, generateToken,
  parseCookies, setCookie, clearCookie,
  setVisitorCookie, clearVisitorCookie,
  getAuthSession, getVisitorAuthSession, refreshAuthSession,
} from '../lib/auth.mjs';
import { saveUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { getAvailableToolsAsync, saveSimpleToolAsync } from '../lib/tools.mjs';
import {
  applyAppTemplateToSession,
  cancelActiveRun,
  compactSession,
  createSession,
  delegateSession,
  dropToolUse,
  forkSession,
  getHistory,
  getRunState,
  getSession,
  getSessionEventsAfter,
  getSessionTimelineEvents,
  listSessions,
  renameSession,
  saveSessionAsTemplate,
  sendMessage,
  setSessionArchived,
  setSessionPinned,
  submitHttpMessage,
  updateSessionLastReviewedAt,
  updateSessionWorkflowClassification,
  updateSessionRuntimePreferences,
} from './session-manager.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import { appendEvent, readEventBody } from './history.mjs';
import { messageEvent } from './normalizer.mjs';
import { getPublicKey, addSubscription } from './push.mjs';
import { getModelsForTool } from './models.mjs';
import {
  listApps,
  getApp,
  getAppByShareToken,
  createApp,
  updateApp,
  deleteApp,
  isBuiltinAppId,
} from './apps.mjs';
import {
  createUser,
  deleteUser,
  getUser,
  listUsers,
  updateUser,
} from './users.mjs';
import {
  createVisitor,
  deleteVisitor,
  getVisitorByShareToken,
  listVisitors,
  updateVisitor,
} from './visitors.mjs';
import { createShareSnapshot, getShareAsset, getShareSnapshot } from './shares.mjs';
import { createSessionDetail, createSessionListItem } from './session-api-shapes.mjs';
import { buildEventBlockEvents, buildSessionDisplayEvents } from './session-display-events.mjs';
import { parseSessionGetRoute } from './session-route-utils.mjs';
import { readBody } from '../lib/utils.mjs';
import {
  getClientIp, isRateLimited, recordFailedAttempt, clearFailedAttempts,
  setSecurityHeaders, generateNonce, requireAuth,
} from './middleware.mjs';
import { pathExists, statOrNull } from './fs-utils.mjs';
import { broadcastAll } from './ws-clients.mjs';

// Paths (files are read from disk on each request for hot-reload)
const __dirname = dirname(fileURLToPath(import.meta.url));
const chatTemplatePath = join(__dirname, '..', 'templates', 'chat.html');
const loginTemplatePath = join(__dirname, '..', 'templates', 'login.html');
const shareTemplatePath = join(__dirname, '..', 'templates', 'share.html');
const staticDir = join(__dirname, '..', 'static');
const packageJsonPath = join(__dirname, '..', 'package.json');
const serviceBuildRoots = [
  join(__dirname, '..', 'chat'),
  join(__dirname, '..', 'lib'),
  join(__dirname, '..', 'chat-server.mjs'),
  packageJsonPath,
];

function isTemplateAppScopeId(appId) {
  return /^app[_-]/i.test(typeof appId === 'string' ? appId.trim() : '');
}
const serviceBuildStatusPaths = ['chat', 'lib', 'chat-server.mjs', 'package.json'];

const BUILD_INFO = loadBuildInfo();
const pageBuildRoots = [
  join(__dirname, '..', 'templates'),
  staticDir,
];
const VISITOR_BROWSER_COOKIE_NAME = 'visitor_browser_id';
const VISITOR_BROWSER_COOKIE_MAX_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const VISITOR_BROWSER_COOKIE_MAX_AGE_SECONDS = Math.max(1, Math.floor(VISITOR_BROWSER_COOKIE_MAX_AGE_MS / 1000));
const VISITOR_BROWSER_COOKIE_SAME_SITE = 'Lax';
let cachedPageBuildInfo = null;
const frontendBuildWatchers = [];
let frontendBuildInvalidationTimer = null;

async function listSessionsForClient(options = {}) {
  const sessions = await listSessions(options);
  return sessions.map(createClientSessionDetail);
}

async function listSessionListItemsForClient(options = {}) {
  const sessions = await listSessions(options);
  return sessions.map(createSessionListItem);
}

async function getSessionForClient(id, options = {}) {
  return createClientSessionDetail(await getSession(id, options));
}

async function getSessionListItemForClient(id, options = {}) {
  return createSessionListItem(await getSession(id, options));
}

function createClientSessionDetail(session) {
  return createSessionDetail(session);
}

const staticMimeTypesByExtension = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const staticDirResolved = resolve(staticDir);
const MESSAGE_SUBMISSION_MAX_BYTES = 256 * 1024 * 1024;
const uploadedMediaMimeTypes = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  m4a: 'audio/mp4',
  m4v: 'video/x-m4v',
  md: 'text/markdown; charset=utf-8',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain; charset=utf-8',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  zip: 'application/zip',
};

function bodyTooLargeError() {
  return Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' });
}

function getMultipartBodyLength(req) {
  const rawLength = Array.isArray(req.headers['content-length'])
    ? req.headers['content-length'][0]
    : req.headers['content-length'];
  const parsedLength = Number.parseInt(rawLength || '', 10);
  return Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : null;
}

function parseFormString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function readSessionMessagePayload(req, pathname) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) {
    const body = await readBody(req, MESSAGE_SUBMISSION_MAX_BYTES);
    return JSON.parse(body);
  }

  const contentLength = getMultipartBodyLength(req);
  if (contentLength !== null && contentLength > MESSAGE_SUBMISSION_MAX_BYTES) {
    throw bodyTooLargeError();
  }

  const formRequest = new Request(`http://127.0.0.1${pathname}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: 'half',
  });
  const formData = await formRequest.formData();
  const images = [];
  for (const entry of formData.getAll('images')) {
    if (!entry || typeof entry.arrayBuffer !== 'function') continue;
    images.push({
      buffer: Buffer.from(await entry.arrayBuffer()),
      mimeType: typeof entry.type === 'string' ? entry.type : '',
      originalName: typeof entry.name === 'string' ? entry.name : '',
    });
  }

  return {
    requestId: parseFormString(formData.get('requestId')),
    text: parseFormString(formData.get('text')),
    tool: parseFormString(formData.get('tool')),
    model: parseFormString(formData.get('model')),
    effort: parseFormString(formData.get('effort')),
    thinking: parseFormString(formData.get('thinking')) === 'true',
    images,
  };
}

function getLatestMtimeMsSync(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }

  const ownMtime = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
  if (!stat.isDirectory()) return ownMtime;

  let entries = [];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return ownMtime;
  }

  return entries.reduce((latestMtime, entry) => {
    if (entry.name.startsWith('.')) return latestMtime;
    return Math.max(latestMtime, getLatestMtimeMsSync(join(path, entry.name)));
  }, ownMtime);
}

function formatMtimeFingerprint(mtimeMs, fallbackSeed = Date.now()) {
  const numericValue = Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : fallbackSeed;
  return Math.round(numericValue).toString(36);
}

function hasDirtyRepoPaths(paths) {
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
  } catch {
    return false;
  }
}

function loadBuildInfo() {
  let version = 'dev';
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (pkg?.version) version = String(pkg.version);
  } catch {}

  let commit = '';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}

  const serviceDirty = hasDirtyRepoPaths(serviceBuildStatusPaths);
  const serviceFingerprint = serviceDirty
    ? formatMtimeFingerprint(serviceBuildRoots.reduce(
      (latestMtime, root) => Math.max(latestMtime, getLatestMtimeMsSync(root)),
      0,
    ))
    : '';
  const serviceRevisionBase = commit || '';
  const serviceRevisionLabel = serviceRevisionBase
    ? (serviceDirty ? `${serviceRevisionBase}*` : serviceRevisionBase)
    : (serviceDirty ? 'working*' : '');
  const serviceLabelParts = [`Ver ${version}`];
  if (serviceRevisionLabel) serviceLabelParts.push(serviceRevisionLabel);
  const serviceLabel = serviceLabelParts.join(' · ');
  const serviceAssetVersion = sanitizeAssetVersion([
    version,
    commit || 'working',
    serviceDirty && serviceFingerprint ? `dirty-${serviceFingerprint}` : 'clean',
  ].filter(Boolean).join('-'));
  const serviceTitleParts = [`Service v${version}`];
  if (serviceRevisionLabel) serviceTitleParts.push(serviceRevisionLabel);
  if (serviceFingerprint) serviceTitleParts.push(`srv:${serviceFingerprint}`);
  const serviceTitle = serviceTitleParts.join(' · ');
  return {
    version,
    commit,
    assetVersion: serviceAssetVersion,
    label: serviceLabel,
    title: serviceTitle,
    serviceVersion: version,
    serviceCommit: commit,
    serviceDirty,
    serviceFingerprint,
    serviceAssetVersion,
    serviceLabel,
    serviceTitle,
  };
}

function renderPageTemplate(template, nonce, replacements = {}) {
  const merged = {
    NONCE: nonce,
    ASSET_VERSION: BUILD_INFO.assetVersion,
    BUILD_LABEL: BUILD_INFO.label,
    BUILD_TITLE: BUILD_INFO.title,
    BUILD_JSON: serializeJsonForScript(BUILD_INFO),
    BODY_CLASS: '',
    BOOTSTRAP_JSON: serializeJsonForScript({ auth: null }),
    EXTRA_BOOTSTRAP_SCRIPTS: '',
    ...replacements,
  };
  if (!Object.prototype.hasOwnProperty.call(replacements, 'BOOTSTRAP_SCRIPT_TAGS')) {
    merged.BOOTSTRAP_SCRIPT_TAGS = [
      `<script nonce="${merged.NONCE}">window.__REMOTELAB_BUILD__ = ${merged.BUILD_JSON};</script>`,
      `<script nonce="${merged.NONCE}">window.__REMOTELAB_BOOTSTRAP__ = ${merged.BOOTSTRAP_JSON};</script>`,
    ].join('\n');
  }
  return Object.entries(merged).reduce(
    (output, [key, value]) => output.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? '')),
    template,
  );
}

function buildTemplateReplacements(buildInfo) {
  return {
    ASSET_VERSION: buildInfo.assetVersion,
    BUILD_LABEL: buildInfo.label,
    BUILD_TITLE: buildInfo.title,
    BUILD_JSON: serializeJsonForScript(buildInfo),
  };
}

function buildAuthInfo(authSession) {
  if (!authSession) return null;
  const info = { role: authSession.role === 'visitor' ? 'visitor' : 'owner' };
  if (info.role === 'visitor') {
    info.appId = authSession.appId;
    info.sessionId = authSession.sessionId;
    info.visitorId = authSession.visitorId;
  }
  return info;
}

function buildChatPageBootstrap(authSession) {
  return {
    auth: buildAuthInfo(authSession),
  };
}

function normalizeTemplateAppIds(appIds) {
  if (!Array.isArray(appIds)) return [];
  return [...new Set(appIds
    .map((appId) => (typeof appId === 'string' ? appId.trim() : ''))
    .filter(Boolean))];
}

async function resolveTemplateApps(appIds) {
  const resolved = [];
  for (const appId of normalizeTemplateAppIds(appIds)) {
    const app = await getApp(appId);
    if (!app || !isTemplateAppScopeId(app.id)) continue;
    resolved.push(app);
  }
  return resolved;
}

async function normalizeSessionFolderInput(folder) {
  const trimmed = typeof folder === 'string' && folder.trim() ? folder.trim() : '~';
  const resolvedFolder = trimmed.startsWith('~')
    ? join(homedir(), trimmed.slice(1))
    : resolve(trimmed);
  if (!await isDirectoryPath(resolvedFolder)) return null;
  return trimmed.startsWith('~') ? trimmed : resolvedFolder;
}

async function createOwnerTemplatedSession({ folder = '~', tool = '', name = '', app, userId = '', userName = '' } = {}) {
  if (!app?.id || !isTemplateAppScopeId(app.id)) return null;
  let session = await createSession(
    folder,
    tool || app.tool || 'codex',
    name || app.name || 'Session',
    {
      appId: app.id,
      appName: app.name || '',
      sourceId: 'chat',
      sourceName: 'Chat',
      userId,
      userName,
    },
  );
  session = await applyAppTemplateToSession(session.id, app.id) || session;
  if (app.welcomeMessage) {
    await appendEvent(session.id, messageEvent('assistant', app.welcomeMessage));
    session = await getSessionForClient(session.id) || session;
  }
  return session;
}

async function ensureUserSeedSession(user, { folder = '~', tool = '' } = {}) {
  if (!user?.id) return null;
  const existing = (await listSessionsForClient({ includeVisitor: true })).find((session) => session.userId === user.id);
  if (existing) return existing;
  const app = await getApp(user.defaultAppId || user.appIds?.[0] || '');
  if (!app || !isTemplateAppScopeId(app.id)) return null;
  return createOwnerTemplatedSession({
    folder,
    tool: tool || app.tool || 'codex',
    name: `${user.name || 'User'} · ${app.name || 'Session'}`,
    app,
    userId: user.id,
    userName: user.name || '',
  });
}

function getVisitorBrowserId(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return typeof cookies[VISITOR_BROWSER_COOKIE_NAME] === 'string'
    ? cookies[VISITOR_BROWSER_COOKIE_NAME].trim()
    : '';
}

function createVisitorBrowserId() {
  return `browser_${generateToken().slice(0, 24)}`;
}

function setVisitorBrowserCookie(browserId) {
  const secure = SECURE_COOKIES ? '; Secure' : '';
  const expiry = new Date(Date.now() + VISITOR_BROWSER_COOKIE_MAX_AGE_MS);
  return `${VISITOR_BROWSER_COOKIE_NAME}=${browserId}; HttpOnly${secure}; SameSite=${VISITOR_BROWSER_COOKIE_SAME_SITE}; Path=/; Max-Age=${VISITOR_BROWSER_COOKIE_MAX_AGE_SECONDS}; Expires=${expiry.toUTCString()}`;
}

function buildAppShareVisitorId(appId, browserId) {
  const digest = createHash('sha256')
    .update(`${appId || ''}:${browserId || ''}`)
    .digest('hex');
  return `visitor_${digest.slice(0, 24)}`;
}

function buildVisitorSessionExternalTriggerId(appId, visitorId) {
  return `visitor_session:${appId || 'app'}:${visitorId || 'visitor'}`;
}

async function findReusableVisitorSession(appId, visitorId) {
  if (!appId || !visitorId) return null;
  const sessionsForApp = await listSessionsForClient({ includeVisitor: true, appId });
  return sessionsForApp.find((session) => session.visitorId === visitorId && !session.archived)
    || sessionsForApp.find((session) => session.visitorId === visitorId)
    || null;
}

async function bootstrapPublicVisitorSession(app, { visitorId, visitorName = '', sessionName = '' } = {}) {
  const existingSession = await findReusableVisitorSession(app?.id, visitorId);
  const chatSession = await createSession(
    '~',
    app.tool || 'codex',
    sessionName || app.name,
    {
      appId: app.id,
      appName: app.name,
      sourceId: 'chat',
      sourceName: 'Chat',
      visitorId,
      visitorName,
      systemPrompt: app.systemPrompt,
      externalTriggerId: buildVisitorSessionExternalTriggerId(app.id, visitorId),
    }
  );
  if (!existingSession && app.welcomeMessage) {
    await appendEvent(chatSession.id, messageEvent('assistant', app.welcomeMessage));
  }
  const sessionToken = generateToken();
  sessions.set(sessionToken, {
    expiry: Date.now() + SESSION_EXPIRY,
    role: 'visitor',
    appId: app.id,
    visitorId,
    visitorName,
    sessionId: chatSession.id,
  });
  await saveAuthSessionsAsync();
  return { chatSession, sessionToken };
}

async function getLatestMtimeMs(path) {
  const stat = await statOrNull(path);
  if (!stat) return 0;

  const ownMtime = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
  if (!stat.isDirectory()) return ownMtime;

  let entries = [];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return ownMtime;
  }

  const nestedTimes = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => getLatestMtimeMs(join(path, entry.name))),
  );

  return Math.max(ownMtime, ...nestedTimes, 0);
}

function sanitizeAssetVersion(value) {
  return String(value || 'dev').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export async function getPageBuildInfo() {
  const now = Date.now();
  if (cachedPageBuildInfo && now - cachedPageBuildInfo.cachedAt < 250) {
    return cachedPageBuildInfo.info;
  }

  let latestMtimeMs = 0;
  for (const root of pageBuildRoots) {
    latestMtimeMs = Math.max(latestMtimeMs, await getLatestMtimeMs(root));
  }

  const frontendFingerprint = latestMtimeMs > 0
    ? Math.round(latestMtimeMs).toString(36)
    : now.toString(36);
  const frontendLabel = `ui:${frontendFingerprint}`;
  const frontendTitle = `Frontend ${frontendLabel}`;
  const assetVersion = sanitizeAssetVersion([
    BUILD_INFO.serviceAssetVersion || BUILD_INFO.assetVersion || 'service',
    frontendFingerprint,
  ].filter(Boolean).join('-'));
  const info = {
    ...BUILD_INFO,
    assetVersion,
    frontendFingerprint,
    frontendLabel,
    frontendTitle,
    label: `${BUILD_INFO.serviceLabel} · ${frontendLabel}`,
    title: `${BUILD_INFO.serviceTitle} · ${frontendTitle}`,
  };

  cachedPageBuildInfo = {
    cachedAt: now,
    info,
  };
  return info;
}

function scheduleFrontendBuildInvalidation() {
  cachedPageBuildInfo = null;
  if (frontendBuildInvalidationTimer) return;
  frontendBuildInvalidationTimer = setTimeout(async () => {
    frontendBuildInvalidationTimer = null;
    try {
      const buildInfo = await getPageBuildInfo();
      broadcastAll({ type: 'build_info', buildInfo });
    } catch (error) {
      console.error(`[build] frontend update broadcast failed: ${error.message}`);
    }
  }, 120);
  if (typeof frontendBuildInvalidationTimer.unref === 'function') {
    frontendBuildInvalidationTimer.unref();
  }
}

function startFrontendBuildWatchers() {
  if (frontendBuildWatchers.length > 0) return;
  for (const root of pageBuildRoots) {
    try {
      const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        const changedPath = String(filename || '');
        if (changedPath) {
          const segments = changedPath.split(/[\\/]+/).filter(Boolean);
          if (segments.some((segment) => segment.startsWith('.'))) {
            return;
          }
        }
        scheduleFrontendBuildInvalidation();
      });
      watcher.on('error', (error) => {
        console.error(`[build] frontend watcher error for ${root}: ${error.message}`);
      });
      frontendBuildWatchers.push(watcher);
    } catch (error) {
      console.warn(`[build] frontend watcher disabled for ${root}: ${error.message}`);
    }
  }
}

startFrontendBuildWatchers();

function getSingleQueryValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

function hasVersionedAssetTag(query = {}) {
  return getSingleQueryValue(query?.v).trim().length > 0;
}

async function resolveStaticAsset(pathname, query = {}) {
  if (!pathname.startsWith('/')) return null;

  const staticName = pathname.slice(1);
  if (!staticName || staticName.endsWith('/')) return null;

  const segments = staticName.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment.startsWith('.'))) {
    return null;
  }

  const filepath = resolve(staticDirResolved, staticName);
  const relativePath = relative(staticDirResolved, filepath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  if (relativePath.split(sep).some((segment) => segment === '..' || segment.startsWith('.'))) {
    return null;
  }

  const stat = await statOrNull(filepath);
  if (!stat?.isFile()) return null;

  const filename = basename(filepath).toLowerCase();
  const extension = extname(filename);
  const contentType = filename === 'manifest.json'
    ? 'application/manifest+json'
    : staticMimeTypesByExtension[extension] || 'application/octet-stream';

  return {
    filepath,
    cacheControl: filename === 'sw.js'
      ? 'no-store, max-age=0, must-revalidate'
      : hasVersionedAssetTag(query)
        ? 'public, max-age=31536000, immutable'
        : 'public, no-cache, max-age=0, must-revalidate',
    contentType,
  };
}

function buildHeaders(headers = {}) {
  return {
    'X-RemoteLab-Build': BUILD_INFO.title,
    ...headers,
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, buildHeaders({ 'Content-Type': 'application/json' }));
  res.end(JSON.stringify(payload));
}

function createJsonBody(value) {
  return JSON.stringify(value);
}

function createEtag(value) {
  return `"${createHash('sha1').update(value).digest('hex')}"`;
}

function normalizeEtag(value) {
  return String(value || '').trim().replace(/^W\//, '');
}

function requestHasFreshEtag(req, etag) {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  const candidates = String(header)
    .split(',')
    .map((value) => normalizeEtag(value))
    .filter(Boolean);
  if (candidates.includes('*')) return true;
  return candidates.includes(normalizeEtag(etag));
}

function writeCachedResponse(req, res, {
  statusCode = 200,
  contentType,
  body,
  cacheControl,
  vary,
  headers: extraHeaders = {},
} = {}) {
  const etag = createEtag(body);
  const headers = {
    'Cache-Control': cacheControl,
    ETag: etag,
    'X-RemoteLab-Build': BUILD_INFO.title,
    ...extraHeaders,
  };
  if (vary) headers.Vary = vary;

  if (requestHasFreshEtag(req, etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (contentType) headers['Content-Type'] = contentType;
  res.writeHead(statusCode, headers);
  res.end(body);
}

function writeJsonCached(req, res, payload, {
  statusCode = 200,
  cacheControl = 'private, no-cache',
  vary = 'Cookie',
  headers,
} = {}) {
  writeCachedResponse(req, res, {
    statusCode,
    contentType: 'application/json',
    body: createJsonBody(payload),
    cacheControl,
    vary,
    headers,
  });
}

function createSessionSummaryPayload(session) {
  return { session: createSessionListItem(session) };
}

function createSessionSummaryEtag(session) {
  return createEtag(createJsonBody(createSessionSummaryPayload(session)));
}

function createSessionSummaryRef(session) {
  const projected = createSessionListItem(session);
  return {
    id: projected?.id,
    summaryEtag: createSessionSummaryEtag(projected),
  };
}

function writeFileCached(req, res, contentType, body, {
  cacheControl = 'public, no-cache',
  vary,
} = {}) {
  writeCachedResponse(req, res, {
    statusCode: 200,
    contentType,
    body,
    cacheControl,
    vary,
  });
}

const IMMUTABLE_PRIVATE_EVENT_CACHE_CONTROL = 'private, max-age=1296000, immutable';
const SHARE_RESOURCE_CACHE_CONTROL = 'public, no-cache, max-age=0, must-revalidate';

function canAccessSession(authSession, sessionId) {
  if (!authSession) return false;
  if (authSession.role !== 'visitor') return true;
  return authSession.sessionId === sessionId;
}

function requireSessionAccess(res, authSession, sessionId) {
  if (canAccessSession(authSession, sessionId)) return true;
  writeJson(res, 403, { error: 'Access denied' });
  return false;
}

async function isDirectoryPath(path) {
  return (await statOrNull(path))?.isDirectory() === true;
}

function setShareSnapshotHeaders(res, nonce = '') {
  const scriptSrc = ["'self'"];
  if (typeof nonce === 'string' && nonce) {
    scriptSrc.push(`'nonce-${nonce}'`);
  }
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "connect-src 'none'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'none'",
  ].join('; '));
}

function buildShareSnapshotClientPayload(snapshot) {
  const timelineEvents = Array.isArray(snapshot?.events)
    ? snapshot.events
      .filter((event) => event && typeof event === 'object')
      .map((event, index) => ({
        ...event,
        seq: Number.isInteger(event.seq) && event.seq > 0 ? event.seq : index + 1,
      }))
    : [];
  const displayEvents = buildSessionDisplayEvents(timelineEvents, {
    sessionRunning: false,
  });
  const eventBlocks = Object.create(null);
  for (const event of displayEvents) {
    if (event?.type !== 'thinking_block') continue;
    const startSeq = Number.isInteger(event?.blockStartSeq) ? event.blockStartSeq : 0;
    const endSeq = Number.isInteger(event?.blockEndSeq) ? event.blockEndSeq : 0;
    if (startSeq < 1 || endSeq < startSeq) continue;
    const key = `${startSeq}-${endSeq}`;
    if (eventBlocks[key]) continue;
    eventBlocks[key] = buildEventBlockEvents(timelineEvents, startSeq, endSeq);
  }

  return {
    id: snapshot?.id,
    version: snapshot?.version,
    createdAt: snapshot?.createdAt || null,
    session: snapshot?.session && typeof snapshot.session === 'object'
      ? snapshot.session
      : {},
    view: snapshot?.view && typeof snapshot.view === 'object'
      ? snapshot.view
      : {},
    eventCount: timelineEvents.length,
    displayEvents,
    eventBlocks,
  };
}

async function writeSnapshotPage(req, res, shareId, {
  cacheControl,
  headers = {},
  failureText = 'Failed to load snapshot page',
} = {}) {
  const pageNonce = '';
  setShareSnapshotHeaders(res, pageNonce);
  try {
    const pageBuildInfo = await getPageBuildInfo();
    const sharePage = await readFile(chatTemplatePath, 'utf8');
    const body = renderPageTemplate(sharePage, pageNonce, {
      ...buildTemplateReplacements(pageBuildInfo),
      BODY_CLASS: 'visitor-mode share-snapshot-mode',
      BOOTSTRAP_SCRIPT_TAGS: `<script src="/share-payload/${shareId}.js"></script>`,
    });
    writeCachedResponse(req, res, {
      statusCode: 200,
      contentType: 'text/html; charset=utf-8',
      body,
      cacheControl,
      headers,
    });
  } catch {
    res.writeHead(500, buildHeaders({ 'Content-Type': 'text/plain' }));
    res.end(failureText);
  }
}

function serializeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function isOwnerOnlyRoute(pathname, method) {
  if (pathname === '/api/sessions' && (method === 'GET' || method === 'POST')) return true;
  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/share') && method === 'POST') return true;
  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/fork') && method === 'POST') return true;
  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/delegate') && method === 'POST') return true;
  if (pathname.startsWith('/api/sessions/') && method === 'PATCH') return true;
  if (pathname === '/api/models' && method === 'GET') return true;
  if (pathname === '/api/tools' && (method === 'GET' || method === 'POST')) return true;
  if (pathname === '/api/autocomplete' && method === 'GET') return true;
  if (pathname === '/api/browse' && method === 'GET') return true;
  if (pathname === '/api/push/vapid-public-key' && method === 'GET') return true;
  if (pathname === '/api/push/subscribe' && method === 'POST') return true;
  if (pathname === '/api/apps') return true;
  if (pathname.startsWith('/api/apps/')) return true;
  if (pathname === '/api/users') return true;
  if (pathname.startsWith('/api/users/')) return true;
  return false;
}

function parseSharePayloadRoute(pathname) {
  const match = /^\/share-payload\/(snap_[a-f0-9]{48})\.js$/.exec(pathname || '');
  return match ? match[1] : null;
}

function parseShareAssetRoute(pathname) {
  const match = /^\/share-asset\/(snap_[a-f0-9]{48})\/(asset_[a-f0-9]{24})$/.exec(pathname || '');
  if (!match) return null;
  return { shareId: match[1], assetId: match[2] };
}

export async function handleRequest(req, res) {
  const parsedUrl = parseUrl(req.url, true);
  const pathname = parsedUrl.pathname;

  // Static assets (read from disk each time for hot-reload)
  const staticAsset = await resolveStaticAsset(pathname, parsedUrl.query);
  if (staticAsset) {
    try {
      const content = await readFile(staticAsset.filepath);
      writeFileCached(req, res, staticAsset.contentType, content, {
        cacheControl: staticAsset.cacheControl,
      });
    } catch {
      res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Not Found');
    }
    return;
  }

  const nonce = generateNonce();
  setSecurityHeaders(res, nonce);

  // Token auth via query
  const queryToken = parsedUrl.query.token;
  if (queryToken) {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
      res.end('Too many failed attempts. Please try again later.');
      return;
    }
    if (await verifyTokenAsync(queryToken)) {
      clearFailedAttempts(ip);
      const sessionToken = generateToken();
      sessions.set(sessionToken, { expiry: Date.now() + SESSION_EXPIRY, role: 'owner' });
      await saveAuthSessionsAsync();
      res.writeHead(302, { 'Location': '/', 'Set-Cookie': setCookie(sessionToken) });
      res.end();
    } else {
      recordFailedAttempt(ip);
      res.writeHead(302, { 'Location': '/login' });
      res.end();
    }
    return;
  }

  // Login — POST (form submit)
  if (pathname === '/login' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
      res.end('Too many failed attempts. Please try again later.');
      return;
    }
    let body;
    try { body = await readBody(req, 4096); } catch { body = ''; }
    const params = new URLSearchParams(body);
    const type = params.get('type');
    let valid = false;
    if (type === 'token') {
      valid = await verifyTokenAsync(params.get('token') || '');
    } else if (type === 'password') {
      valid = await verifyPasswordAsync(params.get('username') || '', params.get('password') || '');
    }
    if (valid) {
      clearFailedAttempts(ip);
      const sessionToken = generateToken();
      sessions.set(sessionToken, { expiry: Date.now() + SESSION_EXPIRY, role: 'owner' });
      await saveAuthSessionsAsync();
      res.writeHead(302, { 'Location': '/', 'Set-Cookie': setCookie(sessionToken) });
    } else {
      recordFailedAttempt(ip);
      const mode = type === 'password' ? 'pw' : 'token';
      res.writeHead(302, { 'Location': `/login?error=1&mode=${mode}` });
    }
    res.end();
    return;
  }

  // Login — GET (show form)
  if (pathname === '/login') {
    const hasError = parsedUrl.query.error === '1';
    const mode = parsedUrl.query.mode === 'token' ? 'token' : 'pw';
    let loginHtml;
    const pageBuildInfo = await getPageBuildInfo();
    try { loginHtml = await readFile(loginTemplatePath, 'utf8'); } catch { loginHtml = '<h1>Login template missing</h1>'; }
    res.writeHead(200, buildHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    }));
    res.end(renderPageTemplate(loginHtml, nonce, {
      ...buildTemplateReplacements(pageBuildInfo),
      ERROR_CLASS: hasError ? '' : 'hidden',
      MODE: mode,
    }));
    return;
  }

  // Logout — clear both owner and visitor session cookies
  if (pathname === '/logout') {
    const cookies = parseCookies(req.headers.cookie || '');
    const ownerToken = cookies.session_token;
    const visitorToken = cookies.visitor_session_token;
    if (ownerToken) { sessions.delete(ownerToken); }
    if (visitorToken) { sessions.delete(visitorToken); }
    if (ownerToken || visitorToken) { await saveAuthSessionsAsync(); }
    res.writeHead(302, {
      'Location': '/login',
      'Set-Cookie': [clearCookie(), clearVisitorCookie()],
    });
    res.end();
    return;
  }

  // ---- App visitor entry point (before auth check — visitors aren't authenticated yet) ----
  if (pathname.startsWith('/app/') && req.method === 'GET') {
    const shareToken = pathname.slice('/app/'.length);
    if (!shareToken) {
      res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Not Found');
      return;
    }
    const app = await getAppByShareToken(shareToken);
    if (!app) {
      res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('App not found');
      return;
    }
    const visitorBrowserId = getVisitorBrowserId(req) || createVisitorBrowserId();
    const visitorId = buildAppShareVisitorId(app.id, visitorBrowserId);
    const { sessionToken } = await bootstrapPublicVisitorSession(app, { visitorId, sessionName: app.name });
    res.writeHead(302, {
      'Location': '/?visitor=1',
      'Set-Cookie': [
        setVisitorCookie(sessionToken),
        setVisitorBrowserCookie(visitorBrowserId),
      ],
    });
    res.end();
    return;
  }

  if (pathname.startsWith('/visitor/') && req.method === 'GET') {
    const shareToken = pathname.slice('/visitor/'.length);
    if (!shareToken) {
      res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Not Found');
      return;
    }
    const visitor = await getVisitorByShareToken(shareToken);
    if (!visitor) {
      res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Visitor link not found');
      return;
    }
    const app = await getApp(visitor.appId);
    if (!app || app.shareEnabled === false) {
      res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Assigned app not found');
      return;
    }
    const { sessionToken } = await bootstrapPublicVisitorSession(app, {
      visitorId: visitor.id,
      visitorName: visitor.name || '',
      sessionName: `${visitor.name || 'Visitor'} · ${app.name || 'App'}`,
    });
    res.writeHead(302, {
      'Location': '/?visitor=1',
      'Set-Cookie': setVisitorCookie(sessionToken),
    });
    res.end();
    return;
  }

  const sharePayloadId = parseSharePayloadRoute(pathname);
  if (sharePayloadId && req.method === 'GET') {
    const snapshot = await getShareSnapshot(sharePayloadId);
    if (!snapshot) {
      res.writeHead(404, buildHeaders({
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      }));
      res.end('Shared snapshot not found');
      return;
    }
    const pageBuildInfo = await getPageBuildInfo();
    const clientPayload = buildShareSnapshotClientPayload(snapshot);
    const bootstrap = {
      auth: null,
      shareSnapshot: {
        id: sharePayloadId,
        badge: 'Read-only snapshot',
        titleSuffix: 'Shared Snapshot',
        note: 'This link exposes only this captured conversation snapshot. It cannot send messages, join a live session, or browse any other RemoteLab content.',
      },
    };
    const body = [
      `window.__REMOTELAB_BUILD__ = ${serializeJsonForScript(pageBuildInfo)};`,
      `window.__REMOTELAB_BOOTSTRAP__ = ${serializeJsonForScript(bootstrap)};`,
      `window.__REMOTELAB_SHARE__ = ${serializeJsonForScript(clientPayload)};`,
    ].join('\n');
    writeCachedResponse(req, res, {
      statusCode: 200,
      contentType: 'application/javascript; charset=utf-8',
      body,
      cacheControl: SHARE_RESOURCE_CACHE_CONTROL,
      headers: {
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      },
    });
    return;
  }

  const shareAssetRoute = parseShareAssetRoute(pathname);
  if (shareAssetRoute && req.method === 'GET') {
    const asset = await getShareAsset(shareAssetRoute.shareId, shareAssetRoute.assetId);
    if (!asset) {
      res.writeHead(404, buildHeaders({
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      }));
      res.end('Shared asset not found');
      return;
    }
    try {
      const content = await readFile(asset.filepath);
      writeFileCached(req, res, asset.mimeType, content, {
        cacheControl: SHARE_RESOURCE_CACHE_CONTROL,
      });
    } catch {
      res.writeHead(404, buildHeaders({
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      }));
      res.end('Shared asset not found');
    }
    return;
  }

  if (pathname.startsWith('/share/') && req.method === 'GET') {
    const shareId = pathname.slice('/share/'.length);
    const snapshot = await getShareSnapshot(shareId);
    if (!snapshot) {
      res.writeHead(404, buildHeaders({
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      }));
      res.end('Shared snapshot not found');
      return;
    }
    await writeSnapshotPage(req, res, shareId, {
      cacheControl: SHARE_RESOURCE_CACHE_CONTROL,
      failureText: 'Failed to load share page',
    });
    return;
  }

  if (pathname === '/api/build-info' && req.method === 'GET') {
    const pageBuildInfo = await getPageBuildInfo();
    writeJsonCached(req, res, pageBuildInfo, {
      cacheControl: 'no-store, max-age=0, must-revalidate',
      vary: '',
      headers: {
        'X-RemoteLab-Asset-Version': pageBuildInfo.assetVersion,
        'X-RemoteLab-Service-Build': pageBuildInfo.serviceTitle,
        'X-RemoteLab-Frontend-Build': pageBuildInfo.frontendTitle,
      },
    });
    return;
  }

  // Auth required from here on
  if (!requireAuth(req, res)) return;
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner' && isOwnerOnlyRoute(pathname, req.method)) {
    writeJson(res, 403, { error: 'Owner access required' });
    return;
  }

  // ---- API endpoints ----

  const sessionGetRoute = req.method === 'GET' ? parseSessionGetRoute(pathname) : null;

  if (sessionGetRoute?.kind === 'list' || sessionGetRoute?.kind === 'archived-list') {
    const includeVisitor = authSession?.role === 'owner'
      && ['1', 'true', 'yes'].includes(String(parsedUrl.query.includeVisitor || '').toLowerCase());
    const view = typeof parsedUrl.query.view === 'string'
      ? String(parsedUrl.query.view || '').trim().toLowerCase()
      : '';
    const sessionList = await listSessionListItemsForClient({
      includeVisitor,
      includeArchived: true,
      appId: typeof parsedUrl.query.appId === 'string' ? parsedUrl.query.appId : '',
      sourceId: typeof parsedUrl.query.sourceId === 'string' ? parsedUrl.query.sourceId : '',
    });
    const folderFilter = parsedUrl.query.folder;
    const filtered = folderFilter
      ? sessionList.filter((session) => session.folder === folderFilter)
      : sessionList;
    const archivedSessions = filtered.filter((session) => session?.archived === true);
    const activeSessions = filtered.filter((session) => session?.archived !== true);
    const targetSessions = sessionGetRoute.kind === 'archived-list'
      ? archivedSessions
      : activeSessions;
    const sessionRefs = targetSessions.map(createSessionSummaryRef).filter((ref) => ref?.id);
    if (view === 'refs') {
      writeJsonCached(req, res, {
        sessionRefs,
        archivedCount: archivedSessions.length,
      });
      return;
    }
    writeJsonCached(req, res, {
      sessions: targetSessions,
      archivedCount: archivedSessions.length,
    });
    return;
  }

  if (sessionGetRoute?.kind === 'detail') {
    const { sessionId } = sessionGetRoute;
    if (!requireSessionAccess(res, authSession, sessionId)) return;
    const view = typeof parsedUrl.query.view === 'string'
      ? String(parsedUrl.query.view || '').trim().toLowerCase()
      : '';
    const session = view === 'summary' || view === 'sidebar'
      ? await getSessionListItemForClient(sessionId)
      : await getSessionForClient(sessionId, { includeQueuedMessages: true });
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return;
    }
    writeJsonCached(req, res, { session });
    return;
  }

  if (sessionGetRoute?.kind === 'events') {
    const { sessionId } = sessionGetRoute;
    if (!requireSessionAccess(res, authSession, sessionId)) return;
    const filter = typeof parsedUrl.query.filter === 'string'
      ? String(parsedUrl.query.filter || '').trim().toLowerCase()
      : '';
    if (filter === 'all') {
      const events = await getSessionEventsAfter(sessionId, 0);
      writeJsonCached(req, res, { sessionId, filter: 'all', events });
      return;
    }
    const session = await getSessionForClient(sessionId);
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return;
    }
    const timeline = await getSessionTimelineEvents(sessionId);
    const events = buildSessionDisplayEvents(timeline, {
      sessionRunning: session?.activity?.run?.state === 'running',
    });
    writeJsonCached(req, res, { sessionId, filter: 'visible', events });
    return;
  }

  if (sessionGetRoute?.kind === 'event-block') {
    const {
      sessionId,
      startSeq,
      endSeq,
    } = sessionGetRoute;
    if (!requireSessionAccess(res, authSession, sessionId)) return;
    const session = await getSessionForClient(sessionId);
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return;
    }
    const timeline = await getSessionTimelineEvents(sessionId);
    const events = buildEventBlockEvents(timeline, startSeq, endSeq);
    if (events.length === 0) {
      writeJson(res, 404, { error: 'Event block not found' });
      return;
    }
    writeJsonCached(req, res, { sessionId, startSeq, endSeq, events }, {
      cacheControl: IMMUTABLE_PRIVATE_EVENT_CACHE_CONTROL,
      vary: '',
    });
    return;
  }

  if (sessionGetRoute?.kind === 'event-body') {
    const { sessionId, seq } = sessionGetRoute;
    if (!requireSessionAccess(res, authSession, sessionId)) return;
    const body = await readEventBody(sessionId, seq);
    if (!body) {
      writeJson(res, 404, { error: 'Event body not found' });
      return;
    }
    writeJsonCached(req, res, { body }, {
      cacheControl: IMMUTABLE_PRIVATE_EVENT_CACHE_CONTROL,
      vary: '',
    });
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'PATCH') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'sessions' || !sessionId) {
      writeJson(res, 400, { error: 'Invalid session path' });
      return;
    }
    if (!requireSessionAccess(res, authSession, sessionId)) return;
    let body;
    try { body = await readBody(req, 10240); } catch {
      writeJson(res, 400, { error: 'Bad request' });
      return;
    }
    let patch;
    try { patch = JSON.parse(body); } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return;
    }
    const hasArchivedPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'archived');
    const hasPinnedPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'pinned');
    const hasToolPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'tool');
    const hasModelPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'model');
    const hasEffortPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'effort');
    const hasThinkingPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'thinking');
    const hasWorkflowStatePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'workflowState');
    const hasWorkflowPriorityPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'workflowPriority');
    const hasLastReviewedAtPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'lastReviewedAt');
    if (hasArchivedPatch && typeof patch.archived !== 'boolean') {
      writeJson(res, 400, { error: 'archived must be a boolean' });
      return;
    }
    if (hasPinnedPatch && typeof patch.pinned !== 'boolean') {
      writeJson(res, 400, { error: 'pinned must be a boolean' });
      return;
    }
    if (hasToolPatch && typeof patch.tool !== 'string') {
      writeJson(res, 400, { error: 'tool must be a string' });
      return;
    }
    if (hasModelPatch && typeof patch.model !== 'string') {
      writeJson(res, 400, { error: 'model must be a string' });
      return;
    }
    if (hasEffortPatch && typeof patch.effort !== 'string') {
      writeJson(res, 400, { error: 'effort must be a string' });
      return;
    }
    if (hasThinkingPatch && typeof patch.thinking !== 'boolean') {
      writeJson(res, 400, { error: 'thinking must be a boolean' });
      return;
    }
    if (hasWorkflowStatePatch && patch.workflowState !== null && typeof patch.workflowState !== 'string') {
      writeJson(res, 400, { error: 'workflowState must be a string or null' });
      return;
    }
    if (hasWorkflowPriorityPatch && patch.workflowPriority !== null && typeof patch.workflowPriority !== 'string') {
      writeJson(res, 400, { error: 'workflowPriority must be a string or null' });
      return;
    }
    if (hasLastReviewedAtPatch && patch.lastReviewedAt !== null && typeof patch.lastReviewedAt !== 'string') {
      writeJson(res, 400, { error: 'lastReviewedAt must be a string or null' });
      return;
    }
    if (
      hasWorkflowStatePatch
      && patch.workflowState !== null
      && String(patch.workflowState).trim()
      && !normalizeSessionWorkflowState(String(patch.workflowState))
    ) {
      writeJson(res, 400, { error: 'workflowState must be parked, waiting_user, or done' });
      return;
    }
    if (
      hasWorkflowPriorityPatch
      && patch.workflowPriority !== null
      && String(patch.workflowPriority).trim()
      && !normalizeSessionWorkflowPriority(String(patch.workflowPriority))
    ) {
      writeJson(res, 400, { error: 'workflowPriority must be high, medium, or low' });
      return;
    }
    if (
      hasLastReviewedAtPatch
      && patch.lastReviewedAt !== null
      && String(patch.lastReviewedAt).trim()
      && !Number.isFinite(Date.parse(String(patch.lastReviewedAt).trim()))
    ) {
      writeJson(res, 400, { error: 'lastReviewedAt must be a valid timestamp or null' });
      return;
    }
    let session = null;
    if (typeof patch.name === 'string' && patch.name.trim()) {
      session = await renameSession(sessionId, patch.name.trim());
    }
    if (hasArchivedPatch) {
      session = await setSessionArchived(sessionId, patch.archived) || session;
    }
    if (hasPinnedPatch) {
      session = await setSessionPinned(sessionId, patch.pinned) || session;
    }
    if (hasWorkflowStatePatch || hasWorkflowPriorityPatch) {
      session = await updateSessionWorkflowClassification(sessionId, {
        ...(hasWorkflowStatePatch ? { workflowState: patch.workflowState || '' } : {}),
        ...(hasWorkflowPriorityPatch ? { workflowPriority: patch.workflowPriority || '' } : {}),
      }) || session;
    }
    if (hasToolPatch || hasModelPatch || hasEffortPatch || hasThinkingPatch) {
      session = await updateSessionRuntimePreferences(sessionId, {
        ...(hasToolPatch ? { tool: patch.tool } : {}),
        ...(hasModelPatch ? { model: patch.model } : {}),
        ...(hasEffortPatch ? { effort: patch.effort } : {}),
        ...(hasThinkingPatch ? { thinking: patch.thinking } : {}),
      }) || session;
    }
    if (hasLastReviewedAtPatch) {
      session = await updateSessionLastReviewedAt(sessionId, patch.lastReviewedAt || '') || session;
    }
    if (!session) {
      session = await getSessionForClient(sessionId);
    }
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return;
    }
    writeJson(res, 200, { session: createClientSessionDetail(session) });
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    const action = parts[3] || null;
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'messages') {
      if (!requireSessionAccess(res, authSession, sessionId)) return;
      let body;
      try {
        body = await readSessionMessagePayload(req, pathname);
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return;
      }
      let payload = body;
      if (!payload || typeof payload !== 'object') {
        writeJson(res, 400, { error: 'Invalid request body' });
        return;
      }
      if (!payload?.text || typeof payload.text !== 'string') {
        writeJson(res, 400, { error: 'text is required' });
        return;
      }
      try {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
        const messageOptions = {
          tool: authSession?.role === 'visitor' ? undefined : payload.tool || undefined,
          thinking: authSession?.role === 'visitor' ? false : !!payload.thinking,
          model: authSession?.role === 'visitor' ? undefined : payload.model || undefined,
          effort: authSession?.role === 'visitor' ? undefined : payload.effort || undefined,
        };
        const outcome = requestId
          ? await submitHttpMessage(sessionId, payload.text.trim(), payload.images || [], {
              ...messageOptions,
              requestId,
            })
          : await sendMessage(sessionId, payload.text.trim(), payload.images || [], messageOptions);
      writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: requestId || outcome.run?.requestId || null,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          run: outcome.run,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode = error?.code === 'SESSION_ARCHIVED' ? 409 : 400;
        writeJson(res, statusCode, { error: error.message || 'Failed to submit message' });
      }
      return;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'cancel') {
      if (!requireSessionAccess(res, authSession, sessionId)) return;
      const run = await cancelActiveRun(sessionId);
      if (!run) {
        const session = await getSessionForClient(sessionId);
        if (session && session.activity?.run?.state !== 'running') {
          writeJson(res, 200, { run: null, session });
          return;
        }
        writeJson(res, 409, { error: 'No active run' });
        return;
      }
      writeJson(res, 200, { run });
      return;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'compact') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return;
      }
      if (!await compactSession(sessionId)) {
        writeJson(res, 409, { error: 'Unable to compact session' });
        return;
      }
      writeJson(res, 200, { ok: true, session: await getSessionForClient(sessionId) });
      return;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'drop-tools') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return;
      }
      if (!await dropToolUse(sessionId)) {
        writeJson(res, 409, { error: 'Unable to drop tool results' });
        return;
      }
      writeJson(res, 200, { ok: true, session: await getSessionForClient(sessionId) });
      return;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'apply-template') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return;
      }
      if (!requireSessionAccess(res, authSession, sessionId)) return;
      let body;
      try { body = await readBody(req, 10240); } catch {
        writeJson(res, 400, { error: 'Bad request' });
        return;
      }
      let payload;
      try { payload = JSON.parse(body); } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return;
      }
      const appId = typeof payload?.appId === 'string' ? payload.appId.trim() : '';
      if (!appId) {
        writeJson(res, 400, { error: 'appId is required' });
        return;
      }
      const session = await getSessionForClient(sessionId);
      if (!session) {
        writeJson(res, 404, { error: 'Session not found' });
        return;
      }
      if (session.activity?.run?.state === 'running') {
        writeJson(res, 409, { error: 'Session is running' });
        return;
      }
      if ((session.messageCount || 0) > 0) {
        writeJson(res, 409, { error: 'Templates can only be applied before the first message' });
        return;
      }
      const updated = await applyAppTemplateToSession(sessionId, appId);
      if (!updated) {
        writeJson(res, 409, { error: 'Unable to apply template' });
        return;
      }
      writeJson(res, 200, { session: createClientSessionDetail(updated) });
      return;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'save-template') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return;
      }
      if (!requireSessionAccess(res, authSession, sessionId)) return;
      let body = '';
      try { body = await readBody(req, 10240); } catch {
        writeJson(res, 400, { error: 'Bad request' });
        return;
      }
      let payload = {};
      if (body) {
        try { payload = JSON.parse(body); } catch {
          writeJson(res, 400, { error: 'Invalid request body' });
          return;
        }
      }
      const session = await getSessionForClient(sessionId);
      if (!session) {
        writeJson(res, 404, { error: 'Session not found' });
        return;
      }
      if (session.activity?.run?.state === 'running') {
        writeJson(res, 409, { error: 'Session is running' });
        return;
      }
      const app = await saveSessionAsTemplate(sessionId, typeof payload?.name === 'string' ? payload.name.trim() : '');
      if (!app) {
        writeJson(res, 409, { error: 'Unable to save template' });
        return;
      }
      writeJson(res, 201, { app });
      return;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'fork') {
      if (!requireSessionAccess(res, authSession, sessionId)) return;
      const source = await getSessionForClient(sessionId);
      if (!source) {
        writeJson(res, 404, { error: 'Session not found' });
        return;
      }
      if (source.visitorId) {
        writeJson(res, 409, { error: 'Visitor sessions cannot be forked' });
        return;
      }
      if (source.activity?.run?.state === 'running') {
        writeJson(res, 409, { error: 'Session is running' });
        return;
      }
      const session = await forkSession(sessionId);
      if (!session) {
        writeJson(res, 409, { error: 'Unable to fork session' });
        return;
      }
      writeJson(res, 201, { session: createClientSessionDetail(session) });
      return;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'delegate') {
      if (!requireSessionAccess(res, authSession, sessionId)) return;
      const source = await getSessionForClient(sessionId);
      if (!source) {
        writeJson(res, 404, { error: 'Session not found' });
        return;
      }
      if (source.visitorId) {
        writeJson(res, 409, { error: 'Visitor sessions cannot be delegated' });
        return;
      }

      let payload = {};
      try {
        const body = await readBody(req, 32768);
        payload = body ? JSON.parse(body) : {};
      } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return;
      }

      const task = typeof payload?.task === 'string' ? payload.task.trim() : '';
      if (!task) {
        writeJson(res, 400, { error: 'task is required' });
        return;
      }

      try {
        const outcome = await delegateSession(sessionId, {
          task,
          name: typeof payload?.name === 'string' ? payload.name.trim() : '',
        });
        if (!outcome?.session) {
          writeJson(res, 409, { error: 'Unable to delegate session' });
          return;
        }
        writeJson(res, 201, {
          session: createClientSessionDetail(outcome.session),
          run: outcome.run || null,
        });
      } catch (error) {
        writeJson(res, 400, { error: error.message || 'Failed to delegate session' });
      }
      return;
    }
  }

  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/share') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const id = parts[2];
    if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'sessions' || parts[3] !== 'share' || !id) {
      writeJson(res, 400, { error: 'Invalid session share path' });
      return;
    }

    const session = await getSessionForClient(id);
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return;
    }

    const snapshot = await createShareSnapshot(session, await getHistory(id));
    writeJson(res, 201, {
      share: {
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        url: `/share/${snapshot.id}`,
      },
    });
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 10240); } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      throw err;
    }
    try {
      const {
        folder,
        tool,
        name,
        appId,
        appName,
        userId,
        userName,
        sourceId,
        sourceName,
        group,
        description,
        systemPrompt,
        completionTargets,
        externalTriggerId,
      } = JSON.parse(body);
      if (!folder || !tool) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'folder and tool are required' }));
        return;
      }
      const resolvedFolder = folder.startsWith('~')
        ? join(homedir(), folder.slice(1))
        : resolve(folder);
      if (!await isDirectoryPath(resolvedFolder)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder does not exist' }));
        return;
      }
      const requestedUserId = typeof userId === 'string' ? userId.trim() : '';
      const resolvedUser = requestedUserId ? await getUser(requestedUserId) : null;
      if (requestedUserId && !resolvedUser) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }
      let resolvedApp = typeof appId === 'string' && appId.trim()
        ? await getApp(appId.trim())
        : null;
      if (resolvedUser) {
        const userAppId = resolvedApp?.id || resolvedUser.defaultAppId || resolvedUser.appIds?.[0] || '';
        if (!resolvedUser.appIds.includes(userAppId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Selected app is not allowed for this user' }));
          return;
        }
        resolvedApp = await getApp(userAppId);
        if (!resolvedApp || !isTemplateAppScopeId(resolvedApp.id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'User sessions require a valid template app' }));
          return;
        }
      }
      let session = await createSession(resolvedFolder, tool, name || '', {
        appId: resolvedApp?.id || (typeof appId === 'string' ? appId : ''),
        appName: resolvedApp?.name || (typeof appName === 'string' ? appName : ''),
        userId: resolvedUser?.id || '',
        userName: resolvedUser?.name || (typeof userName === 'string' ? userName : ''),
        sourceId: typeof sourceId === 'string' ? sourceId : '',
        sourceName: typeof sourceName === 'string' ? sourceName : '',
        group: group || '',
        description: description || '',
        systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : '',
        completionTargets: Array.isArray(completionTargets) ? completionTargets : [],
        externalTriggerId: typeof externalTriggerId === 'string' ? externalTriggerId : '',
      });

      const requestedApp = resolvedApp || (
        typeof appId === 'string' && appId.trim()
          ? await getApp(appId.trim())
          : null
      );
      if (requestedApp && isTemplateAppScopeId(requestedApp.id) && Number(session?.messageCount || 0) === 0) {
        session = await applyAppTemplateToSession(session.id, requestedApp.id) || session;
        if (requestedApp.welcomeMessage) {
          await appendEvent(session.id, messageEvent('assistant', requestedApp.welcomeMessage));
          session = await getSessionForClient(session.id) || session;
        }
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: createClientSessionDetail(session) }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname === '/api/runtime-selection' && req.method === 'POST') {
    if (authSession?.role === 'visitor') {
      writeJson(res, 403, { error: 'Owner access required' });
      return;
    }
    let body;
    try { body = await readBody(req, 4096); } catch (err) {
      writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return;
    }
    try {
      const selection = await saveUiRuntimeSelection(payload || {});
      writeJson(res, 200, { selection });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to save runtime selection' });
    }
    return;
  }

  if (pathname.startsWith('/api/runs/') && req.method === 'GET') {
    const parts = pathname.split('/').filter(Boolean);
    const runId = parts[2];
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'runs' || !runId) {
      writeJson(res, 400, { error: 'Invalid run path' });
      return;
    }
    const run = await getRunState(runId);
    if (!run) {
      writeJson(res, 404, { error: 'Run not found' });
      return;
    }
    if (!requireSessionAccess(res, authSession, run.sessionId)) return;
    writeJsonCached(req, res, { run });
    return;
  }

  if (pathname.startsWith('/api/runs/') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const runId = parts[2];
    const action = parts[3];
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'runs' && action === 'cancel' && runId) {
      const run = await getRunState(runId);
      if (!run) {
        writeJson(res, 404, { error: 'Run not found' });
        return;
      }
      if (!requireSessionAccess(res, authSession, run.sessionId)) return;
      const updated = await cancelActiveRun(run.sessionId);
      if (!updated) {
        const refreshed = await getRunState(runId);
        if (refreshed && refreshed.state !== 'running' && refreshed.state !== 'accepted') {
          writeJson(res, 200, { run: refreshed });
          return;
        }
        writeJson(res, 409, { error: 'No active run' });
        return;
      }
      writeJson(res, 200, { run: updated });
      return;
    }
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const toolId = parsedUrl.query ? parsedUrl.query.tool || '' : '';
    const result = await getModelsForTool(toolId);
    writeJsonCached(req, res, result);
    return;
  }

  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = await getAvailableToolsAsync();
    writeJsonCached(req, res, { tools });
    return;
  }

  if (pathname === '/api/tools' && req.method === 'POST') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }

    let body;
    try { body = await readBody(req, 65536); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }

    try {
      const { name, command, runtimeFamily, models, reasoning } = JSON.parse(body);
      const tool = await saveSimpleToolAsync({ name, command, runtimeFamily, models, reasoning });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tool }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Invalid request body' }));
    }
    return;
  }

  if (pathname === '/api/autocomplete' && req.method === 'GET') {
    const query = parsedUrl.query.q || '';
    const suggestions = [];
    try {
      const resolvedQuery = query.startsWith('~') ? join(homedir(), query.slice(1)) : query;
      const parentDir = dirname(resolvedQuery);
      const prefix = basename(resolvedQuery);
      if (await isDirectoryPath(parentDir)) {
        for (const entry of await readdir(parentDir)) {
          if (!prefix.startsWith('.') && entry.startsWith('.')) continue;
          const fullPath = join(parentDir, entry);
          if (await isDirectoryPath(fullPath)) {
            if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
              suggestions.push(fullPath);
            }
          }
        }
      }
    } catch {}
    writeJsonCached(req, res, { suggestions: suggestions.slice(0, 20) });
    return;
  }

  if (pathname === '/api/browse' && req.method === 'GET') {
    const pathQuery = parsedUrl.query.path || '~';
    try {
      const resolvedPath = pathQuery === '~' || pathQuery === ''
        ? homedir()
        : pathQuery.startsWith('~')
          ? join(homedir(), pathQuery.slice(1))
          : resolve(pathQuery);
      const children = [];
      let parent = null;
      if (await isDirectoryPath(resolvedPath)) {
        const parentPath = dirname(resolvedPath);
        parent = parentPath !== resolvedPath ? parentPath : null;
        for (const entry of await readdir(resolvedPath)) {
          if (entry.startsWith('.')) continue;
          const fullPath = join(resolvedPath, entry);
          try {
            if (await isDirectoryPath(fullPath)) children.push({ name: entry, path: fullPath });
          } catch {}
        }
        children.sort((a, b) => a.name.localeCompare(b.name));
      }
      writeJsonCached(req, res, { path: resolvedPath, parent, children });
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to browse directory' }));
    }
    return;
  }

  // Serve uploaded media
  if ((pathname.startsWith('/api/images/') || pathname.startsWith('/api/media/')) && req.method === 'GET') {
    const prefix = pathname.startsWith('/api/media/') ? '/api/media/' : '/api/images/';
    const filename = pathname.slice(prefix.length);
    // Sanitize: only allow alphanumeric, dash, underscore, dot
    if (!/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid filename');
      return;
    }
    const filepath = join(CHAT_IMAGES_DIR, filename);
    if (!await pathExists(filepath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = filename.split('.').pop()?.toLowerCase();
    writeFileCached(req, res, uploadedMediaMimeTypes[ext] || 'application/octet-stream', await readFile(filepath), {
      cacheControl: 'public, max-age=31536000, immutable',
    });
    return;
  }

  // Push notification API
  if (pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
    writeJsonCached(req, res, { publicKey: await getPublicKey() });
    return;
  }

  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 4096); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }
    try {
      const sub = JSON.parse(body);
      if (!sub.endpoint) throw new Error('Missing endpoint');
      await addSubscription(sub);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid subscription' }));
    }
    return;
  }

  // ---- App CRUD APIs (owner only) ----

  if (pathname === '/api/apps' && req.method === 'GET') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    writeJsonCached(req, res, { apps: await listApps() });
    return;
  }

  if (pathname === '/api/apps' && req.method === 'POST') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    let body;
    try { body = await readBody(req, 10240); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }
    try {
      const { name, systemPrompt, welcomeMessage, skills, tool } = JSON.parse(body);
      const app = await createApp({ name, systemPrompt, welcomeMessage, skills, tool });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/apps/') && req.method === 'PATCH') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    const id = pathname.split('/').pop();
    if (isBuiltinAppId(id)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Built-in apps cannot be modified' }));
      return;
    }
    let body;
    try { body = await readBody(req, 10240); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }
    try {
      const updates = JSON.parse(body);
      const updated = await updateApp(id, updates);
      if (updated) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ app: updated }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'App not found' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/apps/') && req.method === 'DELETE') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    const id = pathname.split('/').pop();
    if (isBuiltinAppId(id)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Built-in apps cannot be deleted' }));
      return;
    }
    const ok = await deleteApp(id);
    if (ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'App not found' }));
    }
    return;
  }

  // ---- User profile APIs (owner only) ----

  if (pathname === '/api/users' && req.method === 'GET') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    writeJsonCached(req, res, { users: await listUsers() });
    return;
  }

  if (pathname === '/api/users' && req.method === 'POST') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    let body;
    try { body = await readBody(req, 16384); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }
    try {
      const payload = JSON.parse(body);
      const apps = await resolveTemplateApps(payload.appIds);
      if (apps.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'At least one template app is required' }));
        return;
      }
      const defaultAppId = typeof payload.defaultAppId === 'string' && payload.defaultAppId.trim()
        ? payload.defaultAppId.trim()
        : apps[0].id;
      if (!apps.some((app) => app.id === defaultAppId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'defaultAppId must be one of the allowed apps' }));
        return;
      }
      const folder = await normalizeSessionFolderInput(payload.folder);
      if (!folder) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder does not exist' }));
        return;
      }
      const user = await createUser({
        name: typeof payload.name === 'string' ? payload.name : '',
        appIds: apps.map((app) => app.id),
        defaultAppId,
      });
      const session = payload.autoCreateSession === false
        ? null
        : await ensureUserSeedSession(user, {
          folder,
          tool: typeof payload.tool === 'string' ? payload.tool.trim() : '',
        });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user, session: createClientSessionDetail(session) }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/users/') && req.method === 'PATCH') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    const id = pathname.split('/').pop();
    let body;
    try { body = await readBody(req, 16384); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }
    try {
      const payload = JSON.parse(body);
      const updates = {};
      if (typeof payload.name === 'string') {
        updates.name = payload.name;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'shareVisitorId')) {
        updates.shareVisitorId = typeof payload.shareVisitorId === 'string'
          ? payload.shareVisitorId.trim()
          : '';
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'appIds')) {
        const apps = await resolveTemplateApps(payload.appIds);
        if (apps.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'At least one template app is required' }));
          return;
        }
        updates.appIds = apps.map((app) => app.id);
        if (typeof payload.defaultAppId === 'string' && payload.defaultAppId.trim()) {
          if (!updates.appIds.includes(payload.defaultAppId.trim())) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'defaultAppId must be one of the allowed apps' }));
            return;
          }
          updates.defaultAppId = payload.defaultAppId.trim();
        }
      } else if (typeof payload.defaultAppId === 'string' && payload.defaultAppId.trim()) {
        updates.defaultAppId = payload.defaultAppId.trim();
      }
      const updated = await updateUser(id, updates);
      if (updated) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: updated }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'User not found' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/users/') && req.method === 'DELETE') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    const id = pathname.split('/').pop();
    const user = await getUser(id);
    const ok = await deleteUser(id);
    if (ok) {
      if (user?.shareVisitorId) {
        await deleteVisitor(user.shareVisitorId).catch(() => false);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User not found' }));
    }
    return;
  }

  // ---- Visitor preset APIs (owner only) ----

  if (pathname === '/api/visitors' && req.method === 'GET') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    writeJsonCached(req, res, { visitors: await listVisitors() });
    return;
  }

  if (pathname === '/api/visitors' && req.method === 'POST') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    let body;
    try { body = await readBody(req, 10240); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }
    try {
      const { name, appId } = JSON.parse(body);
      const app = await getApp(appId);
      if (!app || app.shareEnabled === false) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Shareable app is required' }));
        return;
      }
      const visitor = await createVisitor({ name, appId: app.id });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ visitor }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/visitors/') && req.method === 'PATCH') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    const id = pathname.split('/').pop();
    let body;
    try { body = await readBody(req, 10240); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }
    try {
      const updates = JSON.parse(body);
      if (updates.appId) {
        const app = await getApp(updates.appId);
        if (!app || app.shareEnabled === false) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Shareable app is required' }));
          return;
        }
      }
      const updated = await updateVisitor(id, updates);
      if (updated) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ visitor: updated }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Visitor not found' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/visitors/') && req.method === 'DELETE') {
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return;
    }
    const id = pathname.split('/').pop();
    const ok = await deleteVisitor(id);
    if (ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Visitor not found' }));
    }
    return;
  }

  // ---- Auth info endpoint ----
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const authSession = getAuthSession(req);
    if (!authSession) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }
    const info = buildAuthInfo(authSession);
    const refreshedCookie = await refreshAuthSession(req);
    writeJsonCached(req, res, info, {
      headers: refreshedCookie ? { 'Set-Cookie': refreshedCookie } : undefined,
    });
    return;
  }

  // Main page (chat UI) — read from disk each time for hot-reload
  if (pathname === '/') {
    try {
      // Use visitor cookie when explicitly in visitor mode, otherwise use owner cookie.
      // This prevents visitor share links from hijacking the owner's session cookie.
      const isVisitorMode = parsedUrl.query.visitor === '1';
      const authSession = isVisitorMode
        ? getVisitorAuthSession(req)
        : getAuthSession(req);
      const pageBootstrap = buildChatPageBootstrap(authSession);
      const [pageBuildInfo, chatPage, refreshedCookie] = await Promise.all([
        getPageBuildInfo(),
        readFile(chatTemplatePath, 'utf8'),
        refreshAuthSession(req),
      ]);
      res.writeHead(200, buildHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        ...(refreshedCookie ? { 'Set-Cookie': refreshedCookie } : {}),
      }));
      res.end(renderPageTemplate(chatPage, nonce, {
        ...buildTemplateReplacements(pageBuildInfo),
        BOOTSTRAP_JSON: serializeJsonForScript(pageBootstrap),
      }));
    } catch {
      res.writeHead(500, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Failed to load chat page');
    }
    return;
  }

  res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
  res.end('Not Found');
}
