import { readFile, readdir } from 'fs/promises';
import { createReadStream, readFileSync, readdirSync, statSync, watch } from 'fs';
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
  appendAssistantMessage,
  cancelActiveRun,
  compactSession,
  createSession,
  delegateSession,
  dropToolUse,
  forkSession,
  getHistory,
  getRunState,
  resolveSavedAttachments,
  saveAttachments,
  getSession,
  getSessionEventsAfter,
  getSessionSourceContext,
  getSessionTimelineEvents,
  listSessions,
  renameSession,
  rewriteVoiceTranscriptForSession,
  saveSessionAsTemplate,
  sendMessage,
  setSessionArchived,
  setSessionPinned,
  submitHttpMessage,
  updateSessionLastReviewedAt,
  updateSessionGrouping,
  updateSessionAgreements,
  updateSessionWorkflowClassification,
  updateSessionRuntimePreferences,
} from './session-manager.mjs';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  updateTrigger,
} from './triggers.mjs';
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
import { escapeHtml, readBody } from '../lib/utils.mjs';
import {
  getClientIp, isRateLimited, recordFailedAttempt, clearFailedAttempts,
  setSecurityHeaders, generateNonce, requireAuth,
} from './middleware.mjs';
import { pathExists, statOrNull } from './fs-utils.mjs';
import { broadcastAll } from './ws-clients.mjs';
import { handlePublicRoutes } from './router-public-routes.mjs';
import { handleAdminRoutes } from './router-admin-routes.mjs';
import {
  buildFileAssetDirectUrl,
  createFileAssetUploadIntent,
  finalizeFileAssetUpload,
  getFileAsset,
  getFileAssetBootstrapConfig,
  getFileAssetForClient,
  localizeFileAsset,
} from './file-assets.mjs';

// Paths are resolved from the active runtime root on each request.
const __dirname = dirname(fileURLToPath(import.meta.url));
const chatTemplatePath = join(__dirname, '..', 'templates', 'chat.html');
const loginTemplatePath = join(__dirname, '..', 'templates', 'login.html');
const staticDir = join(__dirname, '..', 'static');
const packageJsonPath = join(__dirname, '..', 'package.json');
const releaseMetadataPath = join(__dirname, '..', '.remotelab-release.json');
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
const VOICE_CLEANUP_PAYLOAD_MAX_BYTES = 256 * 1024;
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

function parseFormJson(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readSessionMessagePayload(req, pathname) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) {
    const body = await readBody(req, MESSAGE_SUBMISSION_MAX_BYTES);
    const payload = JSON.parse(body);
    const attachments = Array.isArray(payload?.attachments)
      ? payload.attachments.filter(Boolean)
      : (Array.isArray(payload?.images) ? payload.images.filter(Boolean) : []);
    return {
      requestId: typeof payload?.requestId === 'string' ? payload.requestId.trim() : '',
      text: typeof payload?.text === 'string' ? payload.text : '',
      tool: typeof payload?.tool === 'string' ? payload.tool.trim() : '',
      model: typeof payload?.model === 'string' ? payload.model.trim() : '',
      effort: typeof payload?.effort === 'string' ? payload.effort.trim() : '',
      thinking: payload?.thinking === true,
      source: typeof payload?.source === 'string' ? payload.source.trim() : '',
      sourceContext: payload?.sourceContext && typeof payload.sourceContext === 'object' ? payload.sourceContext : null,
      attachments,
    };
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
  const attachments = [];
  for (const fieldName of ['attachments', 'images']) {
    for (const entry of formData.getAll(fieldName)) {
      if (!entry || typeof entry.arrayBuffer !== 'function') continue;
      attachments.push({
        buffer: Buffer.from(await entry.arrayBuffer()),
        mimeType: typeof entry.type === 'string' ? entry.type : '',
        originalName: typeof entry.name === 'string' ? entry.name : '',
      });
    }
  }

  for (const fieldName of ['existingAttachments', 'existingImages']) {
    const existingAttachments = parseFormJson(parseFormString(formData.get(fieldName)), []);
    if (!Array.isArray(existingAttachments)) continue;
    for (const image of existingAttachments) {
      if (!image || typeof image !== 'object') continue;
      if (typeof image.filename !== 'string' || !image.filename.trim()) continue;
      attachments.push({
        filename: image.filename.trim(),
        originalName: parseFormString(image.originalName),
        mimeType: parseFormString(image.mimeType),
      });
    }
  }

  for (const fieldName of ['externalAttachments', 'externalAssets']) {
    const externalAssets = parseFormJson(parseFormString(formData.get(fieldName)), []);
    if (!Array.isArray(externalAssets)) continue;
    for (const asset of externalAssets) {
      if (!asset || typeof asset !== 'object') continue;
      if (typeof asset.assetId !== 'string' || !asset.assetId.trim()) continue;
      attachments.push({
        assetId: asset.assetId.trim(),
        originalName: parseFormString(asset.originalName),
        mimeType: parseFormString(asset.mimeType),
        ...(parseFormString(asset.renderAs) === 'file' ? { renderAs: 'file' } : {}),
      });
    }
  }

  return {
    requestId: parseFormString(formData.get('requestId')),
    text: parseFormString(formData.get('text')),
    tool: parseFormString(formData.get('tool')),
    model: parseFormString(formData.get('model')),
    effort: parseFormString(formData.get('effort')),
    thinking: parseFormString(formData.get('thinking')) === 'true',
    source: parseFormString(formData.get('source')),
    sourceContext: parseFormJson(parseFormString(formData.get('sourceContext')), null),
    attachments,
  };
}

async function resolveRequestedSessionAttachments(authSession, requestedAttachments = []) {
  const uploadedAttachments = requestedAttachments.filter((attachment) => Buffer.isBuffer(attachment?.buffer) || typeof attachment?.data === 'string');
  const existingAttachments = requestedAttachments.filter((attachment) => typeof attachment?.filename === 'string' && attachment.filename.trim() && !attachment?.assetId);
  const externalAssetAttachments = [];

  for (const attachment of requestedAttachments) {
    const assetId = typeof attachment?.assetId === 'string' ? attachment.assetId.trim() : '';
    if (!assetId) continue;
    const asset = await getFileAsset(assetId);
    if (!asset) {
      const error = new Error(`Unknown asset: ${assetId}`);
      error.statusCode = 400;
      throw error;
    }
    if (!(authSession && (
      authSession.role === 'owner'
      || (authSession.role === 'visitor' && authSession.sessionId === asset.sessionId)
    ))) {
      const error = new Error('Forbidden');
      error.statusCode = 403;
      throw error;
    }
    if (asset.status !== 'ready') {
      const error = new Error(`Asset is not ready: ${assetId}`);
      error.statusCode = 409;
      throw error;
    }
    const localizedPath = typeof asset.localizedPath === 'string' && asset.localizedPath && await pathExists(asset.localizedPath)
      ? asset.localizedPath
      : '';
    externalAssetAttachments.push({
      assetId: asset.id,
      ...(localizedPath ? {
        savedPath: localizedPath,
        filename: typeof attachment?.filename === 'string' && attachment.filename.trim()
          ? attachment.filename.trim()
          : basename(localizedPath),
      } : {}),
      originalName: typeof attachment?.originalName === 'string' && attachment.originalName.trim()
        ? attachment.originalName.trim()
        : asset.originalName,
      mimeType: typeof attachment?.mimeType === 'string' && attachment.mimeType.trim()
        ? attachment.mimeType.trim()
        : asset.mimeType,
      ...(Number.isInteger(asset?.sizeBytes) && asset.sizeBytes > 0 ? { sizeBytes: asset.sizeBytes } : {}),
      ...(typeof attachment?.renderAs === 'string' && attachment.renderAs.trim() === 'file' ? { renderAs: 'file' } : {}),
    });
  }

  return [
    ...(await resolveSavedAttachments(existingAttachments)),
    ...(uploadedAttachments.length > 0 ? await saveAttachments(uploadedAttachments) : []),
    ...externalAssetAttachments,
  ];
}

async function readVoiceCleanupPayload(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.startsWith('multipart/form-data')) {
    const error = new Error('Audio voice input has been removed. Send `providedTranscript` JSON instead.');
    error.statusCode = 410;
    throw error;
  }

  const body = await readBody(req, VOICE_CLEANUP_PAYLOAD_MAX_BYTES);
  const payload = body ? JSON.parse(body) : {};
  if (payload?.audio) {
    const error = new Error('Audio voice input has been removed. Send `providedTranscript` JSON instead.');
    error.statusCode = 410;
    throw error;
  }

  return {
    rewriteWithContext: payload?.rewriteWithContext === true,
    providedTranscript: typeof payload?.providedTranscript === 'string' ? payload.providedTranscript.trim() : '',
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

function normalizeReleaseText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readReleaseMetadata() {
  try {
    const payload = JSON.parse(readFileSync(releaseMetadataPath, 'utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function loadBuildInfo() {
  const releaseMetadata = readReleaseMetadata();
  let version = 'dev';
  const releasedVersion = normalizeReleaseText(releaseMetadata?.sourceVersion);
  if (releasedVersion) {
    version = releasedVersion;
  } else {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (pkg?.version) version = String(pkg.version);
    } catch {}
  }

  let commit = normalizeReleaseText(releaseMetadata?.sourceCommit);
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {}
  }

  const releaseId = normalizeReleaseText(releaseMetadata?.releaseId);
  const runtimeMode = releaseId ? 'release' : 'source';
  const releasedDirty = typeof releaseMetadata?.sourceDirty === 'boolean'
    ? releaseMetadata.sourceDirty
    : null;
  const serviceDirty = releasedDirty === null ? hasDirtyRepoPaths(serviceBuildStatusPaths) : releasedDirty;
  const releasedFingerprint = normalizeReleaseText(releaseMetadata?.sourceFingerprint);
  const computedFingerprint = formatMtimeFingerprint(serviceBuildRoots.reduce(
    (latestMtime, root) => Math.max(latestMtime, getLatestMtimeMsSync(root)),
    0,
  ));
  const serviceFingerprint = releasedFingerprint || (serviceDirty ? computedFingerprint : '');
  const serviceRevisionBase = commit || '';
  const serviceRevisionLabel = serviceRevisionBase
    ? (serviceDirty ? `${serviceRevisionBase}*` : serviceRevisionBase)
    : (serviceDirty ? 'working*' : '');
  const serviceLabelParts = [`Ver ${version}`];
  if (serviceRevisionLabel) serviceLabelParts.push(serviceRevisionLabel);
  const serviceLabel = serviceLabelParts.join(' · ');
  const serviceAssetVersion = sanitizeAssetVersion([
    version,
    commit || releaseId || 'working',
    serviceDirty && serviceFingerprint ? `dirty-${serviceFingerprint}` : 'clean',
    releaseId ? `rel-${releaseId}` : '',
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
    runtimeMode,
    releaseId: releaseId || null,
    releaseCreatedAt: normalizeReleaseText(releaseMetadata?.createdAt) || null,
  };
}

function renderPageTemplate(template, nonce, replacements = {}) {
  const merged = {
    NONCE: nonce,
    ASSET_VERSION: BUILD_INFO.assetVersion,
    BUILD_LABEL: BUILD_INFO.label,
    BUILD_TITLE: BUILD_INFO.title,
    BUILD_JSON: serializeJsonForScript(BUILD_INFO),
    PAGE_TITLE: 'RemoteLab Chat',
    PAGE_HEAD_TAGS: '',
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
    (output, [key, value]) => output.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => String(value ?? '')),
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
  if (typeof authSession.preferredLanguage === 'string' && authSession.preferredLanguage.trim()) {
    info.preferredLanguage = authSession.preferredLanguage.trim();
  }
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
    assetUploads: getFileAssetBootstrapConfig(),
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

async function bootstrapPublicVisitorSession(app, {
  visitorId,
  visitorName = '',
  sessionName = '',
  preferredLanguage = '',
} = {}) {
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
    preferredLanguage,
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

function streamResponse(res, filepath, headers = {}) {
  const stream = createReadStream(filepath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, buildHeaders({ 'Content-Type': 'application/json' }));
    }
    res.end(JSON.stringify({ error: 'Failed to read file' }));
  });
  res.writeHead(200, buildHeaders(headers));
  stream.pipe(res);
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
    "style-src 'self' 'unsafe-inline'",
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

function normalizePageText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function getRequestOrigin(req) {
  const forwardedProto = typeof req?.headers?.['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase()
    : '';
  const protocol = forwardedProto === 'http' || forwardedProto === 'https'
    ? forwardedProto
    : (req.socket?.encrypted ? 'https' : 'http');
  const forwardedHost = typeof req?.headers?.['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : '';
  const host = forwardedHost || (typeof req?.headers?.host === 'string' ? req.headers.host.trim() : '');
  return host ? `${protocol}://${host}` : '';
}

function getShareSnapshotPageDisplayName(snapshot) {
  const sessionName = normalizePageText(snapshot?.session?.name);
  if (sessionName) return sessionName;
  const toolName = normalizePageText(snapshot?.session?.tool);
  if (toolName) return toolName;
  return 'Shared Snapshot';
}

function buildShareSnapshotPageReplacements(req, shareId, snapshot) {
  const displayName = getShareSnapshotPageDisplayName(snapshot);
  const pageTitle = `${displayName} · Shared Snapshot`;
  const description = 'A read-only RemoteLab conversation snapshot.';
  const origin = getRequestOrigin(req);
  const shareUrl = origin ? `${origin}/share/${encodeURIComponent(shareId)}` : '';
  const escapedDisplayName = escapeHtml(displayName);
  const escapedDescription = escapeHtml(description);
  const escapedShareUrl = shareUrl ? escapeHtml(shareUrl) : '';
  return {
    PAGE_TITLE: escapeHtml(pageTitle),
    PAGE_HEAD_TAGS: [
      `<meta name="description" content="${escapedDescription}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="RemoteLab">`,
      `<meta property="og:title" content="${escapedDisplayName}">`,
      `<meta property="og:description" content="${escapedDescription}">`,
      escapedShareUrl ? `<meta property="og:url" content="${escapedShareUrl}">` : '',
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="${escapedDisplayName}">`,
      `<meta name="twitter:description" content="${escapedDescription}">`,
    ].filter(Boolean).join('\n'),
  };
}

async function writeSnapshotPage(req, res, shareId, {
  snapshot = null,
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
      ...(snapshot ? buildShareSnapshotPageReplacements(req, shareId, snapshot) : {}),
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
  if (pathname === '/api/triggers' && (method === 'GET' || method === 'POST')) return true;
  if (pathname.startsWith('/api/triggers/') && ['GET', 'PATCH', 'DELETE'].includes(method)) return true;
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

function parseTriggerRoute(pathname) {
  const match = /^\/api\/triggers\/(trg_[a-f0-9]{24})$/.exec(pathname || '');
  return match ? match[1] : null;
}

function parseFileAssetRoute(pathname) {
  const match = /^\/api\/assets\/(fasset_[a-f0-9]{24})(?:\/(download|finalize))?$/.exec(pathname || '');
  if (!match) return null;
  return {
    assetId: match[1],
    action: match[2] || null,
  };
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

  if (await handlePublicRoutes({
    req,
    res,
    parsedUrl,
    pathname,
    nonce,
    loginTemplatePath,
    getPageBuildInfo,
    buildHeaders,
    renderPageTemplate,
    buildTemplateReplacements,
    getVisitorBrowserId,
    createVisitorBrowserId,
    setVisitorBrowserCookie,
    buildAppShareVisitorId,
    bootstrapPublicVisitorSession,
    parseSharePayloadRoute,
    buildShareSnapshotClientPayload,
    serializeJsonForScript,
    writeCachedResponse,
    SHARE_RESOURCE_CACHE_CONTROL,
    parseShareAssetRoute,
    writeFileCached,
    writeSnapshotPage,
    writeJsonCached,
  })) {
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
  const triggerId = parseTriggerRoute(pathname);
  const fileAssetRoute = parseFileAssetRoute(pathname);

  if (pathname === '/api/triggers' && req.method === 'GET') {
    const sessionId = typeof parsedUrl?.query?.sessionId === 'string'
      ? parsedUrl.query.sessionId
      : '';
    const triggers = await listTriggers({ sessionId });
    writeJson(res, 200, { triggers });
    return;
  }

  if (pathname === '/api/triggers' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return;
    }
    try {
      if (Object.prototype.hasOwnProperty.call(payload, 'thinking') && typeof payload.thinking !== 'boolean') {
        writeJson(res, 400, { error: 'thinking must be a boolean' });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'enabled') && typeof payload.enabled !== 'boolean') {
        writeJson(res, 400, { error: 'enabled must be a boolean' });
        return;
      }
      const trigger = await createTrigger(payload || {});
      writeJson(res, 201, { trigger });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to create trigger' });
    }
    return;
  }

  if (triggerId && req.method === 'GET') {
    const trigger = await getTrigger(triggerId);
    if (!trigger) {
      writeJson(res, 404, { error: 'Trigger not found' });
      return;
    }
    writeJson(res, 200, { trigger });
    return;
  }

  if (triggerId && req.method === 'PATCH') {
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return;
    }
    try {
      if (Object.prototype.hasOwnProperty.call(payload, 'thinking') && typeof payload.thinking !== 'boolean') {
        writeJson(res, 400, { error: 'thinking must be a boolean' });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'enabled') && typeof payload.enabled !== 'boolean') {
        writeJson(res, 400, { error: 'enabled must be a boolean' });
        return;
      }
      const trigger = await updateTrigger(triggerId, payload || {});
      if (!trigger) {
        writeJson(res, 404, { error: 'Trigger not found' });
        return;
      }
      writeJson(res, 200, { trigger });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to update trigger' });
    }
    return;
  }

  if (triggerId && req.method === 'DELETE') {
    const trigger = await deleteTrigger(triggerId);
    if (!trigger) {
      writeJson(res, 404, { error: 'Trigger not found' });
      return;
    }
    writeJson(res, 200, { ok: true, trigger });
    return;
  }

  if (pathname === '/api/assets/upload-intents' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return;
    }

    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) {
      writeJson(res, 400, { error: 'sessionId is required' });
      return;
    }
    if (!requireSessionAccess(res, authSession, sessionId)) return;

    try {
      const intent = await createFileAssetUploadIntent({
        sessionId,
        originalName: typeof payload?.originalName === 'string' ? payload.originalName : '',
        mimeType: typeof payload?.mimeType === 'string' ? payload.mimeType : '',
        sizeBytes: payload?.sizeBytes,
        createdBy: authSession?.role === 'visitor' ? 'visitor' : 'owner',
      });
      writeJson(res, 200, intent);
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to create upload intent' });
    }
    return;
  }

  if (fileAssetRoute && req.method === 'GET' && !fileAssetRoute.action) {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return;
    }
    if (!requireSessionAccess(res, authSession, asset.sessionId)) return;
    const clientAsset = await getFileAssetForClient(asset.id, {
      includeDirectUrl: asset.status === 'ready',
    });
    writeJson(res, 200, { asset: clientAsset });
    return;
  }

  if (fileAssetRoute?.action === 'finalize' && req.method === 'POST') {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return;
    }
    if (!requireSessionAccess(res, authSession, asset.sessionId)) return;

    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return;
    }

    try {
      const next = await finalizeFileAssetUpload(asset.id, {
        sizeBytes: payload?.sizeBytes,
        etag: typeof payload?.etag === 'string' ? payload.etag : '',
      });
      writeJson(res, 200, { asset: next });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to finalize asset upload' });
    }
    return;
  }

  if (fileAssetRoute?.action === 'download' && req.method === 'GET') {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return;
    }
    if (!requireSessionAccess(res, authSession, asset.sessionId)) return;

    try {
      if (asset.storage?.provider === 'local') {
        const localPath = await localizeFileAsset(asset);
        streamResponse(res, localPath, {
          'Content-Type': asset.mimeType || 'application/octet-stream',
          'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        });
        return;
      }
      const direct = await buildFileAssetDirectUrl(asset);
      res.writeHead(302, buildHeaders({
        Location: direct.url,
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end();
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to build asset download link' });
    }
    return;
  }

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

  if (sessionGetRoute?.kind === 'source-context') {
    const { sessionId } = sessionGetRoute;
    if (!requireSessionAccess(res, authSession, sessionId)) return;
    const sourceContext = await getSessionSourceContext(sessionId, {
      requestId: typeof parsedUrl.query.requestId === 'string' ? parsedUrl.query.requestId : '',
    });
    if (!sourceContext) {
      writeJson(res, 404, { error: 'Session not found' });
      return;
    }
    writeJson(res, 200, { sessionId, sourceContext });
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
    const hasGroupPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'group');
    const hasDescriptionPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'description');
    const hasSidebarOrderPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'sidebarOrder');
    const hasActiveAgreementsPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'activeAgreements');
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
    if (hasGroupPatch && patch.group !== null && typeof patch.group !== 'string') {
      writeJson(res, 400, { error: 'group must be a string or null' });
      return;
    }
    if (hasDescriptionPatch && patch.description !== null && typeof patch.description !== 'string') {
      writeJson(res, 400, { error: 'description must be a string or null' });
      return;
    }
    if (hasSidebarOrderPatch && patch.sidebarOrder !== null && (!Number.isInteger(patch.sidebarOrder) || patch.sidebarOrder < 1)) {
      writeJson(res, 400, { error: 'sidebarOrder must be a positive integer or null' });
      return;
    }
    if (hasActiveAgreementsPatch && patch.activeAgreements !== null && !Array.isArray(patch.activeAgreements)) {
      writeJson(res, 400, { error: 'activeAgreements must be an array of strings or null' });
      return;
    }
    if (hasActiveAgreementsPatch && Array.isArray(patch.activeAgreements)) {
      const invalidAgreement = patch.activeAgreements.find((entry) => typeof entry !== 'string');
      if (invalidAgreement !== undefined) {
        writeJson(res, 400, { error: 'activeAgreements must contain only strings' });
        return;
      }
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
    if (hasGroupPatch || hasDescriptionPatch || hasSidebarOrderPatch) {
      session = await updateSessionGrouping(sessionId, {
        ...(hasGroupPatch ? { group: patch.group ?? '' } : {}),
        ...(hasDescriptionPatch ? { description: patch.description ?? '' } : {}),
        ...(hasSidebarOrderPatch ? { sidebarOrder: patch.sidebarOrder ?? null } : {}),
      }) || session;
    }
    if (hasActiveAgreementsPatch) {
      session = await updateSessionAgreements(sessionId, {
        activeAgreements: patch.activeAgreements ?? [],
      }) || session;
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
        const requestedAttachments = Array.isArray(payload?.attachments) ? payload.attachments.filter(Boolean) : [];
        const preSavedAttachments = await resolveRequestedSessionAttachments(authSession, requestedAttachments);
        const messageOptions = {
          tool: authSession?.role === 'visitor' ? undefined : payload.tool || undefined,
          thinking: authSession?.role === 'visitor' ? false : !!payload.thinking,
          model: authSession?.role === 'visitor' ? undefined : payload.model || undefined,
          effort: authSession?.role === 'visitor' ? undefined : payload.effort || undefined,
          sourceContext: authSession?.role === 'visitor' ? undefined : payload.sourceContext,
          ...(preSavedAttachments.length > 0 ? { preSavedAttachments } : {}),
        };
        const outcome = requestId
          ? await submitHttpMessage(sessionId, payload.text.trim(), [], {
              ...messageOptions,
              requestId,
            })
          : await sendMessage(sessionId, payload.text.trim(), [], messageOptions);
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

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'assistant-messages') {
      if (!requireSessionAccess(res, authSession, sessionId)) return;
      if (authSession?.role !== 'owner') {
        writeJson(res, 403, { error: 'Owner access required' });
        return;
      }
      let body;
      try {
        body = await readSessionMessagePayload(req, pathname);
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return;
      }
      const payload = body;
      if (!payload || typeof payload !== 'object') {
        writeJson(res, 400, { error: 'Invalid request body' });
        return;
      }
      try {
        const requestedAttachments = Array.isArray(payload?.attachments) ? payload.attachments.filter(Boolean) : [];
        const preSavedAttachments = await resolveRequestedSessionAttachments(authSession, requestedAttachments);
        const outcome = await appendAssistantMessage(sessionId, payload.text || '', [], {
          requestId: typeof payload?.requestId === 'string' ? payload.requestId.trim() : '',
          source: payload.source || 'assistant_message_api',
          ...(preSavedAttachments.length > 0 ? { preSavedAttachments } : {}),
        });
        writeJson(res, 201, {
          event: outcome.event,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode = error?.code === 'SESSION_ARCHIVED'
          ? 409
          : (Number.isInteger(error?.statusCode) ? error.statusCode : (error?.code === 'MESSAGE_EMPTY' ? 400 : 400));
        writeJson(res, statusCode, { error: error.message || 'Failed to append assistant message' });
      }
      return;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'voice-transcriptions' && req.method === 'POST') {
      if (!requireSessionAccess(res, authSession, sessionId)) return;
      let payload;
      try {
        payload = await readVoiceCleanupPayload(req);
      } catch (error) {
        writeJson(
          res,
          error.code === 'BODY_TOO_LARGE' ? 413 : (error?.statusCode || 400),
          { error: error.code === 'BODY_TOO_LARGE' ? 'Request body too large' : (error?.message || 'Bad request') },
        );
        return;
      }

      const providedTranscript = typeof payload?.providedTranscript === 'string'
        ? payload.providedTranscript.trim()
        : '';
      if (!providedTranscript) {
        writeJson(res, 400, { error: 'providedTranscript is required' });
        return;
      }

      try {
        let transcript = providedTranscript;
        let rewriteApplied = false;
        if (payload.rewriteWithContext && transcript) {
          try {
            const rewritten = await rewriteVoiceTranscriptForSession(sessionId, transcript);
            if (typeof rewritten?.transcript === 'string' && rewritten.transcript.trim()) {
              rewriteApplied = rewritten.changed === true;
              transcript = rewritten.transcript.trim();
            }
          } catch (error) {
            console.warn(`[voice-cleanup] transcript rewrite failed for ${sessionId.slice(0, 8)}: ${error?.message || error}`);
          }
        }
        writeJson(res, 200, {
          transcript,
          ...(rewriteApplied ? { rawTranscript: providedTranscript } : {}),
          rewriteApplied,
        });
      } catch (error) {
        writeJson(res, error?.statusCode || 400, { error: error?.message || 'Voice cleanup failed' });
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
      if (Object.prototype.hasOwnProperty.call(payload, 'tool') && payload.tool !== null && typeof payload.tool !== 'string') {
        writeJson(res, 400, { error: 'tool must be a string when provided' });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'internal') && typeof payload.internal !== 'boolean') {
        writeJson(res, 400, { error: 'internal must be a boolean when provided' });
        return;
      }

      try {
        const outcome = await delegateSession(sessionId, {
          task,
          name: typeof payload?.name === 'string' ? payload.name.trim() : '',
          tool: typeof payload?.tool === 'string' ? payload.tool.trim() : '',
          internal: payload?.internal === true,
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
      const payload = JSON.parse(body);
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
        internalRole,
        completionTargets,
        externalTriggerId,
        sourceContext,
      } = payload;
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
      const createOptions = {
        appId: resolvedApp?.id || (typeof appId === 'string' ? appId : ''),
        appName: resolvedApp?.name || (typeof appName === 'string' ? appName : ''),
        userId: resolvedUser?.id || '',
        userName: resolvedUser?.name || (typeof userName === 'string' ? userName : ''),
        sourceId: typeof sourceId === 'string' ? sourceId : '',
        sourceName: typeof sourceName === 'string' ? sourceName : '',
        group: group || '',
        description: description || '',
        completionTargets: Array.isArray(completionTargets) ? completionTargets : [],
        externalTriggerId: typeof externalTriggerId === 'string' ? externalTriggerId : '',
      };
      if (Object.prototype.hasOwnProperty.call(payload, 'systemPrompt')) {
        createOptions.systemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'internalRole')) {
        if (internalRole !== null && typeof internalRole !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internalRole must be a string when provided' }));
          return;
        }
        createOptions.internalRole = typeof internalRole === 'string' ? internalRole.trim() : '';
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'sourceContext')) {
        createOptions.sourceContext = sourceContext;
      }
      let session = await createSession(resolvedFolder, tool, name || '', createOptions);

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

  if (await handleAdminRoutes({
    req,
    res,
    pathname,
    writeJsonCached,
    createClientSessionDetail,
    normalizeSessionFolderInput,
    resolveTemplateApps,
    ensureUserSeedSession,
  })) {
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
