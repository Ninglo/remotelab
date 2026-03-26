import { readFile } from 'fs/promises';
import { SESSION_EXPIRY } from '../lib/config.mjs';
import {
  sessions,
  saveAuthSessionsAsync,
  verifyTokenAsync,
  verifyPasswordAsync,
  generateToken,
  parseCookies,
  setCookie,
  clearCookie,
  setVisitorCookie,
  clearVisitorCookie,
} from '../lib/auth.mjs';
import { readBody } from '../lib/utils.mjs';
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
}) {
function writeRetiredShareSurface(message = 'This share surface has been retired. Use a read-only snapshot instead.') {
  res.writeHead(410, buildHeaders({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
  }));
  res.end(message);
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
  return true;
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
  return true;
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
  return true;
}

if (pathname.startsWith('/app/') && req.method === 'GET') {
  writeRetiredShareSurface();
  return true;
}

if (pathname.startsWith('/visitor/') && req.method === 'GET') {
  writeRetiredShareSurface();
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
