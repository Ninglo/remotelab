import { readFile, readdir } from 'fs/promises';
import { readFileSync, readdirSync, statSync, watch } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname, basename, extname, relative, isAbsolute, sep } from 'path';
import { parse as parseUrl, fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { SESSION_EXPIRY, CHAT_IMAGES_DIR } from '../lib/config.mjs';
import {
  sessions, saveAuthSessionsAsync,
  verifyTokenAsync, verifyPasswordAsync, generateToken,
  parseCookies, setCookie, clearCookie,
  getAuthSession, refreshAuthSession,
} from '../lib/auth.mjs';
import { saveUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { getAvailableToolsAsync, saveSimpleToolAsync } from '../lib/tools.mjs';
import {
  applyAppTemplateToSession,
  cancelActiveRun,
  compactSession,
  createSession,
  dropToolUse,
  forkSession,
  getHistory,
  getRunState,
  getSession,
  getSessionEventsAfter,
  listSessions,
  renameSession,
  saveSessionAsTemplate,
  sendMessage,
  setSessionArchived,
  setSessionPinned,
  submitHttpMessage,
} from './session-manager.mjs';
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
import { createShareSnapshot, getShareSnapshot } from './shares.mjs';
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
const serviceBuildStatusPaths = ['chat', 'lib', 'chat-server.mjs', 'package.json'];

const BUILD_INFO = loadBuildInfo();
const pageBuildRoots = [
  join(__dirname, '..', 'templates'),
  staticDir,
];
let cachedPageBuildInfo = null;
const frontendBuildWatchers = [];
let frontendBuildInvalidationTimer = null;

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
    ...replacements,
  };
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

async function getPageBuildInfo() {
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
  frontendBuildInvalidationTimer = setTimeout(() => {
    frontendBuildInvalidationTimer = null;
    broadcastAll({ type: 'build_invalidated' });
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

async function resolveStaticAsset(pathname) {
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
    body: JSON.stringify(payload),
    cacheControl,
    vary,
    headers,
  });
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

function setShareSnapshotHeaders(res, nonce) {
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
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'none'",
  ].join('; '));
}

async function writeSnapshotPage(res, nonce, snapshot, {
  cacheControl,
  headers = {},
  failureText = 'Failed to load snapshot page',
} = {}) {
  setShareSnapshotHeaders(res, nonce);
  try {
    const pageBuildInfo = await getPageBuildInfo();
    const sharePage = await readFile(shareTemplatePath, 'utf8');
    res.writeHead(200, buildHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': cacheControl,
      ...headers,
    }));
    res.end(renderPageTemplate(sharePage, nonce, {
      ...buildTemplateReplacements(pageBuildInfo),
      SNAPSHOT_JSON: serializeJsonForScript(snapshot),
    }));
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
  if (pathname.startsWith('/api/sessions/') && method === 'PATCH') return true;
  if (pathname === '/api/models' && method === 'GET') return true;
  if (pathname === '/api/tools' && (method === 'GET' || method === 'POST')) return true;
  if (pathname === '/api/autocomplete' && method === 'GET') return true;
  if (pathname === '/api/browse' && method === 'GET') return true;
  if (pathname === '/api/push/vapid-public-key' && method === 'GET') return true;
  if (pathname === '/api/push/subscribe' && method === 'POST') return true;
  if (pathname === '/api/apps') return true;
  if (pathname.startsWith('/api/apps/')) return true;
  return false;
}

export async function handleRequest(req, res) {
  const parsedUrl = parseUrl(req.url, true);
  const pathname = parsedUrl.pathname;

  // Static assets (read from disk each time for hot-reload)
  const staticAsset = await resolveStaticAsset(pathname);
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

  // Logout
  if (pathname === '/logout') {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.session_token;
    if (token) { sessions.delete(token); await saveAuthSessionsAsync(); }
    res.writeHead(302, { 'Location': '/login', 'Set-Cookie': clearCookie() });
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
    // Create a visitor auth session + a new chat session from the app template
    const visitorId = 'visitor_' + generateToken().slice(0, 16);
    const chatSession = await createSession(
      '~',
      app.tool || 'codex',
      app.name,
      { appId: app.id, appName: app.name, visitorId, systemPrompt: app.systemPrompt }
    );
    // Inject welcome message as first assistant event so visitor sees it immediately
    if (app.welcomeMessage) {
      await appendEvent(chatSession.id, messageEvent('assistant', app.welcomeMessage));
    }
    const sessionToken = generateToken();
    sessions.set(sessionToken, {
      expiry: Date.now() + SESSION_EXPIRY,
      role: 'visitor',
      appId: app.id,
      visitorId,
      sessionId: chatSession.id,
    });
    await saveAuthSessionsAsync();
    res.writeHead(302, {
      'Location': '/?visitor=1',
      'Set-Cookie': setCookie(sessionToken),
    });
    res.end();
    return;
  }

  if (pathname.startsWith('/share/') && req.method === 'GET') {
    const shareId = pathname.slice('/share/'.length);
    const snapshot = await getShareSnapshot(shareId);
    if (!snapshot) {
      res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Shared snapshot not found');
      return;
    }
    await writeSnapshotPage(res, nonce, snapshot, {
      cacheControl: 'public, max-age=31536000, immutable',
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

  if (sessionGetRoute?.kind === 'list') {
    const sessionList = await listSessions({
      appId: typeof parsedUrl.query.appId === 'string' ? parsedUrl.query.appId : '',
    });
    const folderFilter = parsedUrl.query.folder;
    const filtered = folderFilter
      ? sessionList.filter((session) => session.folder === folderFilter)
      : sessionList;
    writeJsonCached(req, res, { sessions: filtered });
    return;
  }

  if (sessionGetRoute?.kind === 'detail') {
    const { sessionId } = sessionGetRoute;
    if (!requireSessionAccess(res, authSession, sessionId)) return;
    const session = await getSession(sessionId, { includeQueuedMessages: true });
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
    const events = await getSessionEventsAfter(sessionId, 0);
    writeJsonCached(req, res, { sessionId, events });
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
    writeJsonCached(req, res, { body });
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'PATCH') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'sessions' || !sessionId) {
      writeJson(res, 400, { error: 'Invalid session path' });
      return;
    }
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
    if (hasArchivedPatch && typeof patch.archived !== 'boolean') {
      writeJson(res, 400, { error: 'archived must be a boolean' });
      return;
    }
    if (hasPinnedPatch && typeof patch.pinned !== 'boolean') {
      writeJson(res, 400, { error: 'pinned must be a boolean' });
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
    if (!session) {
      session = await getSession(sessionId);
    }
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return;
    }
    writeJson(res, 200, { session });
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    const action = parts[3] || null;
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'messages') {
      if (!requireSessionAccess(res, authSession, sessionId)) return;
      let body;
      try { body = await readBody(req, 15 * 1024 * 1024); } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return;
      }
      let payload;
      try { payload = JSON.parse(body); } catch {
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
          session: outcome.session,
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
        const session = await getSession(sessionId);
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
      writeJson(res, 200, { ok: true, session: await getSession(sessionId) });
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
      writeJson(res, 200, { ok: true, session: await getSession(sessionId) });
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
      const session = await getSession(sessionId);
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
      writeJson(res, 200, { session: updated });
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
      const session = await getSession(sessionId);
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
      const source = await getSession(sessionId);
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
      writeJson(res, 201, { session });
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

    const session = await getSession(id);
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
      const session = await createSession(resolvedFolder, tool, name || '', {
        appId: typeof appId === 'string' ? appId : '',
        appName: typeof appName === 'string' ? appName : '',
        group: group || '',
        description: description || '',
        systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : '',
        completionTargets: Array.isArray(completionTargets) ? completionTargets : [],
        externalTriggerId: typeof externalTriggerId === 'string' ? externalTriggerId : '',
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session }));
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

  // Serve uploaded images
  if (pathname.startsWith('/api/images/') && req.method === 'GET') {
    const filename = pathname.slice('/api/images/'.length);
    // Sanitize: only allow alphanumeric, dash, underscore, dot
    if (!/^[a-zA-Z0-9_-]+\.[a-z]+$/.test(filename)) {
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
    const ext = filename.split('.').pop();
    const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    writeFileCached(req, res, mimeTypes[ext] || 'application/octet-stream', await readFile(filepath), {
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

  // ---- Auth info endpoint ----
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const authSession = getAuthSession(req);
    if (!authSession) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }
    const info = { role: authSession.role || 'owner' };
    if (authSession.role === 'visitor') {
      info.appId = authSession.appId;
      info.sessionId = authSession.sessionId;
      info.visitorId = authSession.visitorId;
    }
    const refreshedCookie = await refreshAuthSession(req);
    writeJsonCached(req, res, info, {
      headers: refreshedCookie ? { 'Set-Cookie': refreshedCookie } : undefined,
    });
    return;
  }

  // Main page (chat UI) — read from disk each time for hot-reload
  if (pathname === '/') {
    try {
      const pageBuildInfo = await getPageBuildInfo();
      const chatPage = await readFile(chatTemplatePath, 'utf8');
      const refreshedCookie = await refreshAuthSession(req);
      res.writeHead(200, buildHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        ...(refreshedCookie ? { 'Set-Cookie': refreshedCookie } : {}),
      }));
      res.end(renderPageTemplate(chatPage, nonce, buildTemplateReplacements(pageBuildInfo)));
    } catch {
      res.writeHead(500, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Failed to load chat page');
    }
    return;
  }

  res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
  res.end('Not Found');
}
