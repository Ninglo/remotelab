import { readFile, readdir } from 'fs/promises';
import { createReadStream, watch } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname, basename, extname, relative, isAbsolute, sep } from 'path';
import { parse as parseUrl, fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CHAT_IMAGES_DIR, FILE_ASSET_STORAGE_ENABLED } from '../lib/config.mjs';
import {
  getAuthSession, refreshAuthSession,
} from '../lib/auth.mjs';
import { normalizeInstallHandoffToken } from '../lib/install-handoffs.mjs';
import { saveUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { getAvailableToolsAsync, saveSimpleToolAsync } from '../lib/tools.mjs';
import {
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
  resolveAttachmentMimeType,
  saveSessionAsTemplate,
  sendMessage,
  setSessionArchived,
  setSessionPinned,
  submitHttpMessage,
  updateSessionEntryMode,
  updateSessionLastReviewedAt,
  updateSessionGrouping,
  updateSessionAgreements,
  updateSessionWorkflowClassification,
  updateSessionRuntimePreferences,
} from './session-manager.mjs';
import { normalizeSessionEntryMode } from './session-entry-mode.mjs';
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
import { readEventBody } from './history.mjs';
import { getPublicKey, addSubscription } from './push.mjs';
import { getModelsForTool } from './models.mjs';
import { ensureOwnerBootstrapSessions } from './bootstrap-sessions.mjs';
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
import { handleControlRoutes } from './router-control-routes.mjs';
import { handleCalendarFeedRoute, handleConnectorApiRoutes } from './router-connector-routes.mjs';
import { handleSessionMainRoutes } from './router-session-main-routes.mjs';
import { normalizeAppId } from './apps.mjs';
import {
  buildFileAssetDirectUrl,
  createFileAssetUploadIntent,
  finalizeFileAssetUpload,
  getFileAsset,
  getFileAssetBootstrapConfig,
  getFileAssetForClient,
  localizeFileAsset,
  publishLocalFileAssetFromPath,
} from './file-assets.mjs';

// Paths are resolved from the running project root on each request.
const __dirname = dirname(fileURLToPath(import.meta.url));
const chatTemplatePath = join(__dirname, '..', 'templates', 'chat.html');
const loginTemplatePath = join(__dirname, '..', 'templates', 'login.html');
const mobileInstallTemplatePath = join(__dirname, '..', 'templates', 'mobile-install.html');
const staticDir = join(__dirname, '..', 'static');
const packageJsonPath = join(__dirname, '..', 'package.json');
const serviceBuildRoots = [
  join(__dirname, '..', 'chat'),
  join(__dirname, '..', 'lib'),
  join(__dirname, '..', 'chat-server.mjs'),
  packageJsonPath,
];

const serviceBuildStatusPaths = ['chat', 'lib', 'chat-server.mjs', 'package.json'];

const execFileAsync = promisify(execFile);
const BUILD_INFO = await loadBuildInfo();
const pageBuildRoots = [
  join(__dirname, '..', 'templates'),
  staticDir,
];
let cachedPageBuildInfo = null;
const frontendBuildWatchers = [];
let frontendBuildInvalidationTimer = null;
let ownerBootstrapSessionsPromise = null;

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
      runId: typeof payload?.runId === 'string' ? payload.runId.trim() : '',
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
    runId: parseFormString(formData.get('runId')),
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

async function resolveRequestedSessionAttachments(authSession, requestedAttachments = [], options = {}) {
  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  const allowLocalPaths = options?.allowLocalPaths === true;
  const createdBy = typeof options?.createdBy === 'string' && options.createdBy.trim()
    ? options.createdBy.trim()
    : (authSession?.role === 'visitor' ? 'visitor' : 'owner');
  const uploadedAttachments = requestedAttachments.filter((attachment) => Buffer.isBuffer(attachment?.buffer) || typeof attachment?.data === 'string');
  const existingAttachments = requestedAttachments.filter((attachment) => typeof attachment?.filename === 'string' && attachment.filename.trim() && !attachment?.assetId);
  const localPathAttachments = requestedAttachments.filter((attachment) => typeof attachment?.localPath === 'string' && attachment.localPath.trim());
  const externalAssetAttachments = [];

  if (localPathAttachments.length > 0 && !allowLocalPaths) {
    const error = new Error('localPath attachments are not supported on this route');
    error.statusCode = 400;
    throw error;
  }

  for (const attachment of localPathAttachments) {
    if (!sessionId) {
      const error = new Error('sessionId is required for localPath attachments');
      error.statusCode = 400;
      throw error;
    }
    const originalName = typeof attachment?.originalName === 'string' && attachment.originalName.trim()
      ? attachment.originalName.trim()
      : basename(attachment.localPath);
    const mimeType = resolveAttachmentMimeType(
      typeof attachment?.mimeType === 'string' ? attachment.mimeType.trim() : '',
      originalName,
    );
    const published = await publishLocalFileAssetFromPath({
      sessionId,
      localPath: attachment.localPath,
      originalName,
      mimeType,
      createdBy,
    });
    externalAssetAttachments.push({
      assetId: published.id,
      originalName,
      mimeType,
      ...(Number.isInteger(published?.sizeBytes) && published.sizeBytes > 0 ? { sizeBytes: published.sizeBytes } : {}),
      ...(typeof attachment?.renderAs === 'string' && attachment.renderAs.trim() === 'file' ? { renderAs: 'file' } : {}),
    });
  }

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
      || await canAccessSession(authSession, asset.sessionId)
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

  const savedUploadedAttachments = uploadedAttachments.length > 0
    ? await saveAttachments(uploadedAttachments)
    : [];
  const normalizedUploadedAttachments = await maybePublishSavedAttachmentsToFileAssets(savedUploadedAttachments, {
    sessionId,
    createdBy,
  });

  return [
    ...(await resolveSavedAttachments(existingAttachments)),
    ...normalizedUploadedAttachments,
    ...externalAssetAttachments,
  ];
}

async function maybePublishSavedAttachmentsToFileAssets(savedAttachments = [], options = {}) {
  if (!FILE_ASSET_STORAGE_ENABLED) return savedAttachments;

  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  if (!sessionId || savedAttachments.length === 0) return savedAttachments;

  try {
    return await Promise.all(savedAttachments.map(async (attachment) => {
      const published = await publishLocalFileAssetFromPath({
        sessionId,
        localPath: attachment.savedPath,
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        createdBy: options?.createdBy,
      });
      return {
        assetId: published.id,
        originalName: published.originalName || attachment.originalName,
        mimeType: published.mimeType || attachment.mimeType,
        ...(Number.isInteger(published?.sizeBytes) && published.sizeBytes > 0 ? { sizeBytes: published.sizeBytes } : {}),
        ...(typeof attachment?.renderAs === 'string' && attachment.renderAs.trim() === 'file'
          ? { renderAs: 'file' }
          : {}),
      };
    }));
  } catch (error) {
    console.warn('Failed to offload uploaded attachments to object storage; keeping local attachments.', error);
    return savedAttachments;
  }
}

function formatMtimeFingerprint(mtimeMs, fallbackSeed = Date.now()) {
  const numericValue = Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : fallbackSeed;
  return Math.round(numericValue).toString(36);
}

async function hasDirtyRepoPaths(paths) {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function loadBuildInfo() {
  let version = 'dev';
  try {
    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    if (pkg?.version) version = String(pkg.version);
  } catch {}

  let commit = '';
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    commit = stdout.trim();
  } catch {}

  const runtimeMode = 'source';
  const serviceDirty = await hasDirtyRepoPaths(serviceBuildStatusPaths);
  const buildRootTimes = await Promise.all(serviceBuildRoots.map((root) => getLatestMtimeMs(root)));
  const computedFingerprint = formatMtimeFingerprint(Math.max(...buildRootTimes, 0));
  const serviceFingerprint = serviceDirty ? computedFingerprint : '';
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
    runtimeMode,
    releaseId: null,
    releaseCreatedAt: null,
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
    STATUS_I18N_KEY: 'status.disconnected',
    STATUS_TEXT: 'disconnected',
    INPUT_PLACEHOLDER_I18N_KEY: 'input.placeholder.message',
    INPUT_PLACEHOLDER_TEXT: 'Message...',
  };
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getAuthPrincipalId(authSession) {
  return trimString(authSession?.principalId || authSession?.visitorId);
}

function getAuthPrincipalKind(authSession) {
  if (authSession?.role === 'owner') return 'owner';
  return trimString(authSession?.principalKind) || 'visitor';
}

function getAuthSurfaceMode(authSession) {
  if (authSession?.role === 'owner') return 'owner';
  return trimString(authSession?.surfaceMode) || 'visitor';
}

function getAuthScopeAgentId(authSession) {
  return normalizeAppId(authSession?.agentId || authSession?.appId || authSession?.scope?.agentId);
}

function isAgentScopedAuthSession(authSession) {
  return !!(
    authSession
    && authSession.role === 'visitor'
    && getAuthSurfaceMode(authSession) === 'agent_scoped'
    && getAuthScopeAgentId(authSession)
    && getAuthPrincipalId(authSession)
  );
}

function getAuthCapabilities(authSession) {
  if (!authSession || authSession.role === 'owner') {
    return {
      listSessions: true,
      createSession: true,
      renameSession: true,
      archiveSession: true,
      pinSession: true,
      forkSession: true,
      uploadAttachments: true,
      downloadArtifacts: true,
      switchAgents: true,
      manageAgents: true,
      changeRuntime: true,
      organizeSessionList: true,
      publishShareSnapshot: true,
    };
  }

  const stored = authSession?.capabilities && typeof authSession.capabilities === 'object'
    ? authSession.capabilities
    : {};
  if (!isAgentScopedAuthSession(authSession)) {
    return {
      listSessions: false,
      createSession: false,
      renameSession: false,
      archiveSession: false,
      pinSession: false,
      forkSession: false,
      uploadAttachments: stored.uploadAttachments !== false,
      downloadArtifacts: stored.downloadArtifacts !== false,
      switchAgents: false,
      manageAgents: false,
      changeRuntime: false,
      organizeSessionList: false,
      publishShareSnapshot: false,
    };
  }
  return {
    listSessions: stored.listSessions !== false,
    createSession: stored.createSession !== false,
    renameSession: stored.renameSession !== false,
    archiveSession: stored.archiveSession !== false,
    pinSession: stored.pinSession !== false,
    forkSession: stored.forkSession === true,
    uploadAttachments: stored.uploadAttachments !== false,
    downloadArtifacts: stored.downloadArtifacts !== false,
    switchAgents: stored.switchAgents === true,
    manageAgents: stored.manageAgents === true,
    changeRuntime: stored.changeRuntime === true,
    organizeSessionList: stored.organizeSessionList === true,
    publishShareSnapshot: stored.publishShareSnapshot === true,
  };
}

function getSessionAgentId(session) {
  return normalizeAppId(session?.agentId || session?.templateId || session?.appId);
}

function getSessionPrincipalId(session) {
  return trimString(session?.createdByPrincipalId || session?.visitorId);
}

function isSessionVisibleToAuthSession(authSession, session) {
  if (!authSession || !session) return false;
  if (authSession.role === 'owner') return true;
  if (isAgentScopedAuthSession(authSession)) {
    return getSessionAgentId(session) === getAuthScopeAgentId(authSession)
      && getSessionPrincipalId(session) === getAuthPrincipalId(authSession);
  }
  return trimString(authSession?.sessionId) === trimString(session?.id);
}

function buildAuthInfo(authSession) {
  if (!authSession) return null;
  const info = {
    role: authSession.role === 'visitor' ? 'visitor' : 'owner',
    principalKind: getAuthPrincipalKind(authSession),
    surfaceMode: getAuthSurfaceMode(authSession),
    capabilities: getAuthCapabilities(authSession),
  };
  if (typeof authSession.preferredLanguage === 'string' && authSession.preferredLanguage.trim()) {
    info.preferredLanguage = authSession.preferredLanguage.trim();
  }
  if (info.role === 'visitor') {
    const agentId = getAuthScopeAgentId(authSession);
    const principalId = getAuthPrincipalId(authSession);
    info.agentId = agentId;
    if (authSession.sessionId) {
      info.sessionId = authSession.sessionId;
    }
    if (authSession.visitorId) {
      info.visitorId = authSession.visitorId;
    }
    if (principalId) {
      info.principalId = principalId;
    }
    if (agentId) {
      info.currentAgent = {
        id: agentId,
        name: trimString(authSession.agentName),
        tool: trimString(authSession.agentTool),
      };
    }
  }
  return info;
}

function buildChatPageBootstrap(authSession) {
  return {
    auth: buildAuthInfo(authSession),
    assetUploads: getFileAssetBootstrapConfig(),
  };
}

async function ensureOwnerStarterSessions() {
  if (ownerBootstrapSessionsPromise) {
    return ownerBootstrapSessionsPromise;
  }

  ownerBootstrapSessionsPromise = ensureOwnerBootstrapSessions();

  try {
    return await ownerBootstrapSessionsPromise;
  } finally {
    ownerBootstrapSessionsPromise = null;
  }
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

function isAbsoluteAssetUrl(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('//')) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

function appendVersionTagToAssetUrl(assetUrl, versionTag) {
  const normalizedUrl = String(assetUrl || '').trim();
  const normalizedTag = String(versionTag || '').trim();
  if (!normalizedUrl || !normalizedTag || isAbsoluteAssetUrl(normalizedUrl)) {
    return normalizedUrl;
  }

  const hashIndex = normalizedUrl.indexOf('#');
  const baseUrl = hashIndex >= 0 ? normalizedUrl.slice(0, hashIndex) : normalizedUrl;
  const hash = hashIndex >= 0 ? normalizedUrl.slice(hashIndex) : '';
  if (!baseUrl || /(?:^|[?&])v=/.test(baseUrl)) {
    return normalizedUrl;
  }

  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}v=${encodeURIComponent(normalizedTag)}${hash}`;
}

function findQuotedImportUrl(line) {
  const singleQuoteIndex = line.indexOf("'");
  const doubleQuoteIndex = line.indexOf('"');
  if (singleQuoteIndex < 0 && doubleQuoteIndex < 0) return null;

  const useSingleQuote = singleQuoteIndex >= 0 && (doubleQuoteIndex < 0 || singleQuoteIndex < doubleQuoteIndex);
  const startIndex = useSingleQuote ? singleQuoteIndex : doubleQuoteIndex;
  const quote = useSingleQuote ? "'" : '"';
  const endIndex = line.indexOf(quote, startIndex + 1);
  if (endIndex < 0) return null;

  return {
    startIndex,
    endIndex,
    url: line.slice(startIndex + 1, endIndex),
  };
}

function rewriteCssImportUrls(content, versionTag) {
  const normalizedTag = String(versionTag || '').trim();
  if (!normalizedTag) return content;

  const source = Buffer.isBuffer(content)
    ? content.toString('utf8')
    : String(content || '');
  if (!source.includes('@import')) return content;

  let changed = false;
  const rewrittenSource = source
    .split('\n')
    .map((line) => {
      if (!line.includes('@import')) return line;
      const quotedImport = findQuotedImportUrl(line);
      if (!quotedImport?.url) return line;

      const versionedAssetUrl = appendVersionTagToAssetUrl(quotedImport.url, normalizedTag);
      if (!versionedAssetUrl || versionedAssetUrl === quotedImport.url) {
        return line;
      }

      changed = true;
      return `${line.slice(0, quotedImport.startIndex + 1)}${versionedAssetUrl}${line.slice(quotedImport.endIndex)}`;
    })
    .join('\n');

  return changed ? rewrittenSource : content;
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
  headers,
} = {}) {
  writeCachedResponse(req, res, {
    statusCode: 200,
    contentType,
    body,
    cacheControl,
    vary,
    headers,
  });
}

const IMMUTABLE_PRIVATE_EVENT_CACHE_CONTROL = 'private, max-age=1296000, immutable';
const SHARE_RESOURCE_CACHE_CONTROL = 'public, no-cache, max-age=0, must-revalidate';

async function canAccessSession(authSession, sessionId) {
  if (!authSession) return false;
  if (authSession.role !== 'visitor') return true;
  const session = await getSession(sessionId);
  return isSessionVisibleToAuthSession(authSession, session);
}

async function requireSessionAccess(res, authSession, sessionId) {
  if (await canAccessSession(authSession, sessionId)) return true;
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
    STATUS_I18N_KEY: 'status.readOnlySnapshot',
    STATUS_TEXT: 'read-only snapshot',
    INPUT_PLACEHOLDER_I18N_KEY: 'input.placeholder.readOnlySnapshot',
    INPUT_PLACEHOLDER_TEXT: 'Read-only snapshot',
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
      BOOTSTRAP_SCRIPT_TAGS: `<script src="../share-payload/${shareId}.js"></script>`,
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
  if (pathname === '/api/triggers' && (method === 'GET' || method === 'POST')) return true;
  if (pathname.startsWith('/api/triggers/') && ['GET', 'PATCH', 'DELETE'].includes(method)) return true;
  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/share') && method === 'POST') return true;
  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/fork') && method === 'POST') return true;
  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/delegate') && method === 'POST') return true;
  if (pathname === '/api/models' && method === 'GET') return true;
  if (pathname === '/api/tools' && (method === 'GET' || method === 'POST')) return true;
  if (pathname === '/api/autocomplete' && method === 'GET') return true;
  if (pathname === '/api/browse' && method === 'GET') return true;
  if (pathname === '/api/push/vapid-public-key' && method === 'GET') return true;
  if (pathname === '/api/push/subscribe' && method === 'POST') return true;
  if (pathname === '/api/agents' && (method === 'GET' || method === 'POST')) return true;
  if (pathname.startsWith('/api/agents/') && ['GET', 'PATCH', 'DELETE'].includes(method)) return true;
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
      const versionTag = getSingleQueryValue(parsedUrl.query?.v).trim();
      const content = rewriteCssImportUrls(
        await readFile(staticAsset.filepath),
        staticAsset.contentType.startsWith('text/css') ? versionTag : '',
      );
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

  if (pathname === '/manifest.install.json' && req.method === 'GET') {
    try {
      const manifestTemplate = JSON.parse(await readFile(join(staticDir, 'manifest.json'), 'utf8'));
      const handoffToken = normalizeInstallHandoffToken(getSingleQueryValue(parsedUrl.query?.h));
      const manifest = {
        ...manifestTemplate,
        start_url: handoffToken
          ? `m/install?h=${encodeURIComponent(handoffToken)}`
          : 'm/install',
      };
      writeCachedResponse(req, res, {
        statusCode: 200,
        contentType: 'application/manifest+json',
        body: JSON.stringify(manifest, null, 2),
        cacheControl: 'private, no-store, max-age=0, must-revalidate',
        headers: {
          'Referrer-Policy': 'no-referrer',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
      });
    } catch {
      res.writeHead(500, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Failed to load install manifest');
    }
    return;
  }

  if (await handleCalendarFeedRoute({ req, res, pathname })) {
    return;
  }

  if (await handlePublicRoutes({
    req,
    res,
    parsedUrl,
    pathname,
    nonce,
    loginTemplatePath,
    mobileInstallTemplatePath,
    getPageBuildInfo,
    buildHeaders,
    renderPageTemplate,
    buildTemplateReplacements,
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
  if (!await requireAuth(req, res)) return;
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner' && isOwnerOnlyRoute(pathname, req.method)) {
    writeJson(res, 403, { error: 'Owner access required' });
    return;
  }

  // ---- API endpoints ----

  if (await handleConnectorApiRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
  })) {
    return;
  }

  const sessionGetRoute = req.method === 'GET' ? parseSessionGetRoute(pathname) : null;
  const triggerId = parseTriggerRoute(pathname);
  const fileAssetRoute = parseFileAssetRoute(pathname);

  if (await handleSessionMainRoutes({
    req,
    res,
    parsedUrl,
    pathname,
    authSession,
    sessionGetRoute,
    ensureOwnerStarterSessions,
    createSessionSummaryRef,
    immutablePrivateEventCacheControl: IMMUTABLE_PRIVATE_EVENT_CACHE_CONTROL,
    isDirectoryPath,
    readSessionMessagePayload,
    requireSessionAccess,
    isSessionVisibleToAuthSession,
    getAuthPrincipalId,
    getAuthScopeAgentId,
    isAgentScopedAuthSession,
    resolveRequestedSessionAttachments,
    writeJson,
    writeJsonCached,
  })) {
    return;
  }

  if (await handleControlRoutes({
    req,
    res,
    parsedUrl,
    pathname,
    authSession,
    triggerId,
    fileAssetRoute,
    buildHeaders,
    isDirectoryPath,
    readSessionMessagePayload,
    requireSessionAccess,
    resolveRequestedSessionAttachments,
    streamResponse,
    writeFileCached,
    writeJson,
    writeJsonCached,
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
      const authSession = getAuthSession(req);
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
