import { readFile } from 'fs/promises';
import { performance } from 'perf_hooks';
import {
  auth,
  sessions,
  saveAuthSessionsAsync,
  authenticateTokenAsync,
  authenticatePasswordIdentityAsync,
  createAuthenticatedSession,
  generateToken,
  parseCookies,
  getAuthSession,
  setCookie,
  clearCookie,
} from '../lib/auth.mjs';
import {
  createInstallHandoff,
  normalizeInstallHandoffToken,
  redeemInstallHandoff,
} from '../lib/install-handoffs.mjs';
import { escapeHtml, readBody } from '../lib/utils.mjs';
import { buildAttachmentContentDisposition } from './file-assets.mjs';
import { getShareAsset, getShareSnapshot } from './shares.mjs';
import {
  getClientIp,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
} from './middleware.mjs';

export async function handlePublicRoutes({
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
}) {
function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeLoginNextPath(value) {
  const path = trimString(value);
  if (!path || path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path)) {
    return '/';
  }
  return path;
}

function normalizeForwardedPrefix(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function formatServerTiming(entries = []) {
  const parts = [];
  for (const [name, value] of entries) {
    if (!name || !Number.isFinite(value)) continue;
    const duration = Math.max(0, value);
    parts.push(`${name};dur=${duration.toFixed(3)}`);
  }
  return parts.join(', ');
}

function getRequestProductBasePath(req) {
  return normalizeForwardedPrefix(req?.headers?.['x-forwarded-prefix']);
}

async function mintAuthenticatedSessionFromInstallHandoff(handoffToken) {
  const handoffSession = await redeemInstallHandoff(handoffToken);
  if (!handoffSession) return null;

  const sessionToken = generateToken();
  sessions.set(sessionToken, createAuthenticatedSession({
    personId: handoffSession.personId || auth.primaryPersonId,
    ...(handoffSession.preferredLanguage ? { preferredLanguage: handoffSession.preferredLanguage } : {}),
  }));
  await saveAuthSessionsAsync();

  return {
    redirect: '/?skipInstall=1',
    setCookie: setCookie(sessionToken),
  };
}

if (pathname === '/m/continue' && req.method === 'GET') {
  const authSession = getAuthSession(req);
  if (authSession) {
    res.writeHead(302, buildHeaders({
      'Location': '/?skipInstall=1',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    }));
    res.end();
    return true;
  }

  const handoffToken = normalizeInstallHandoffToken(
    typeof parsedUrl.query?.h === 'string' ? parsedUrl.query.h : '',
  );
  if (!handoffToken) {
    res.writeHead(302, buildHeaders({
      'Location': '/login',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    }));
    res.end();
    return true;
  }

  const nextSession = await mintAuthenticatedSessionFromInstallHandoff(handoffToken);
  if (!nextSession) {
    res.writeHead(302, buildHeaders({
      'Location': '/login',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    }));
    res.end();
    return true;
  }

  res.writeHead(302, buildHeaders({
    'Location': nextSession.redirect,
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    'Referrer-Policy': 'no-referrer',
    'Set-Cookie': nextSession.setCookie,
  }));
  res.end();
  return true;
}

if (pathname === '/api/install/handoff/redeem' && req.method === 'POST') {
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req, 4096) || '{}');
  } catch {
    payload = {};
  }
  const handoffToken = normalizeInstallHandoffToken(payload?.token);
  if (!handoffToken) {
    res.writeHead(400, buildHeaders({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    }));
    res.end(JSON.stringify({ error: 'Install handoff token is required' }));
    return true;
  }
  const nextSession = await mintAuthenticatedSessionFromInstallHandoff(handoffToken);
  if (!nextSession) {
    res.writeHead(401, buildHeaders({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    }));
    res.end(JSON.stringify({ error: 'Install handoff expired or is no longer valid' }));
    return true;
  }
  res.writeHead(200, buildHeaders({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    'Set-Cookie': nextSession.setCookie,
  }));
  res.end(JSON.stringify({ ok: true, redirect: '/' }));
  return true;
}

if (pathname === '/m/install' && req.method === 'GET') {
  const authSession = getAuthSession(req);
  const currentHandoffToken = normalizeInstallHandoffToken(
    typeof parsedUrl.query?.h === 'string' ? parsedUrl.query.h : '',
  );

  if (!currentHandoffToken && authSession) {
    const handoff = await createInstallHandoff(authSession);
    const params = new URLSearchParams();
    params.set('h', handoff.token);
    const source = typeof parsedUrl.query?.source === 'string' ? parsedUrl.query.source.trim() : '';
    if (source) params.set('source', source);
    res.writeHead(302, { 'Location': `/m/install?${params.toString()}` });
    res.end();
    return true;
  }

  if (!currentHandoffToken) {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return true;
  }

  let installHtml;
  const pageBuildInfo = await getPageBuildInfo();
  try { installHtml = await readFile(mobileInstallTemplatePath, 'utf8'); } catch { installHtml = '<h1>Mobile install template missing</h1>'; }
  const manifestHref = `manifest.install.json?h=${encodeURIComponent(currentHandoffToken)}&v=${encodeURIComponent(pageBuildInfo.assetVersion)}`;
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.writeHead(200, buildHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  }));
  res.end(renderPageTemplate(installHtml, nonce, {
    ...buildTemplateReplacements(pageBuildInfo, getRequestProductBasePath(req)),
    PAGE_TITLE: 'Install RemoteLab',
    BODY_CLASS: 'mobile-install-page',
    MANIFEST_HREF: manifestHref,
    BOOTSTRAP_JSON: serializeJsonForScript({
      mobileInstall: {
        handoffToken: currentHandoffToken,
      },
    }),
  }));
  return true;
}

// Token auth via query
const queryToken = parsedUrl.query.token;
if (queryToken) {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
    res.end('Too many failed attempts. Please try again later.');
    return true;
  }
  const authenticatedIdentity = await authenticateTokenAsync(queryToken);
  if (authenticatedIdentity) {
    clearFailedAttempts(ip);
    const sessionToken = generateToken();
    sessions.set(sessionToken, createAuthenticatedSession(authenticatedIdentity));
    await saveAuthSessionsAsync();
    const redirectParams = new URLSearchParams();
    for (const [key, value] of Object.entries(parsedUrl.query || {})) {
      if (key === 'token') continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item === 'string' && item) redirectParams.append(key, item);
      }
    }
    const redirectLocation = redirectParams.toString() ? `/?${redirectParams.toString()}` : '/';
    res.writeHead(302, { 'Location': redirectLocation, 'Set-Cookie': setCookie(sessionToken) });
    res.end();
  } else {
    recordFailedAttempt(ip);
    res.writeHead(302, { 'Location': '/login' });
    res.end();
  }
  return true;
}

// Login — POST (form submit)
if (pathname === '/login' && req.method === 'POST') {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
    res.end('Too many failed attempts. Please try again later.');
    return true;
  }
  let body;
  try { body = await readBody(req, 4096); } catch { body = ''; }
  const params = new URLSearchParams(body);
  const type = params.get('type');
  const nextPath = safeLoginNextPath(params.get('next'));
  let authenticatedIdentity = null;
  if (type === 'token') {
    authenticatedIdentity = await authenticateTokenAsync(params.get('token') || '');
  } else if (type === 'password') {
    authenticatedIdentity = await authenticatePasswordIdentityAsync(
      params.get('username') || '',
      params.get('password') || '',
    );
  }
  if (authenticatedIdentity) {
    clearFailedAttempts(ip);
    const sessionToken = generateToken();
    sessions.set(sessionToken, createAuthenticatedSession(authenticatedIdentity));
    await saveAuthSessionsAsync();
    res.writeHead(302, { 'Location': nextPath, 'Set-Cookie': setCookie(sessionToken) });
  } else {
    recordFailedAttempt(ip);
    const mode = type === 'password' ? 'pw' : 'token';
    const nextParam = nextPath === '/' ? '' : `&next=${encodeURIComponent(nextPath)}`;
    res.writeHead(302, { 'Location': `/login?error=1&mode=${mode}${nextParam}` });
  }
  res.end();
  return true;
}

// Login — GET (show form)
if (pathname === '/login') {
  const requestStartMs = performance.now();
  const hasError = parsedUrl.query.error === '1';
  const mode = parsedUrl.query.mode === 'token' ? 'token' : 'pw';
  const nextPath = safeLoginNextPath(parsedUrl.query.next);
  let loginHtml;
  const buildStartMs = performance.now();
  const pageBuildInfo = await getPageBuildInfo();
  const buildMs = performance.now() - buildStartMs;
  const templateStartMs = performance.now();
  try { loginHtml = await readFile(loginTemplatePath, 'utf8'); } catch { loginHtml = '<h1>Login template missing</h1>'; }
  const templateMs = performance.now() - templateStartMs;
  const renderStartMs = performance.now();
  const body = renderPageTemplate(loginHtml, nonce, {
    ...buildTemplateReplacements(pageBuildInfo, getRequestProductBasePath(req)),
    ERROR_CLASS: hasError ? '' : 'hidden',
    MODE: mode,
    NEXT_PATH: escapeHtml(nextPath),
  });
  const renderMs = performance.now() - renderStartMs;
  const totalMs = performance.now() - requestStartMs;
  res.writeHead(200, buildHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Server-Timing': formatServerTiming([
      ['build', buildMs],
      ['template', templateMs],
      ['render', renderMs],
      ['total', totalMs],
    ]),
  }));
  res.end(body);
  return true;
}

// Logout
if (pathname === '/logout') {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionToken = cookies.session_token;
  if (sessionToken) {
    sessions.delete(sessionToken);
    await saveAuthSessionsAsync();
  }
  res.writeHead(302, {
    'Location': '/login',
    'Set-Cookie': clearCookie(),
  });
  res.end();
  return true;
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
    return true;
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
  return true;
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
    return true;
  }
  try {
    const downloadRequested = String(parsedUrl?.query?.download || '') === '1';
    const content = await readFile(asset.filepath);
    writeFileCached(req, res, asset.mimeType, content, {
      cacheControl: SHARE_RESOURCE_CACHE_CONTROL,
      headers: downloadRequested
        ? {
          'Content-Disposition': buildAttachmentContentDisposition(
            asset.originalName || asset.filename || 'attachment',
            { attachment: true },
          ),
        }
        : undefined,
    });
  } catch {
    res.writeHead(404, buildHeaders({
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    }));
    res.end('Shared asset not found');
  }
  return true;
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
    return true;
  }
  await writeSnapshotPage(req, res, shareId, {
    snapshot,
    cacheControl: SHARE_RESOURCE_CACHE_CONTROL,
    failureText: 'Failed to load share page',
  });
  return true;
}

if (pathname === '/api/build-info' && req.method === 'GET') {
  const pageBuildInfo = await getPageBuildInfo();
  writeJsonCached(req, res, pageBuildInfo, {
    cacheControl: 'no-store, max-age=0, must-revalidate',
    vary: '',
    headers: {
      'X-RemoteLab-Runtime-Mode': pageBuildInfo.runtimeMode,
      'X-RemoteLab-Release-Id': pageBuildInfo.releaseId || '',
      'X-RemoteLab-Asset-Version': pageBuildInfo.assetVersion,
      'X-RemoteLab-Service-Build': pageBuildInfo.serviceTitle,
      'X-RemoteLab-Frontend-Build': pageBuildInfo.frontendTitle,
    },
  });
  return true;
}


  return false;
}
