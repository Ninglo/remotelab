import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readBody } from '../lib/utils.mjs';

const publicPrefix = '/display';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function displayBaseUrl() {
  return trimString(process.env.REMOTELAB_DISPLAY_INTERNAL_BASE_URL || 'http://127.0.0.1:8792').replace(/\/+$/, '');
}

function adminTokenFile() {
  if (process.env.REMOTELAB_DISPLAY_ADMIN_TOKEN_FILE) return process.env.REMOTELAB_DISPLAY_ADMIN_TOKEN_FILE;
  const configDir = process.env.REMOTELAB_CONFIG_DIR || join(homedir(), '.config', 'remotelab');
  return join(configDir, 'display-admin-token');
}

async function adminToken() {
  return trimString(await readFile(adminTokenFile(), 'utf8'));
}

function singleHeader(value) {
  return Array.isArray(value) ? trimString(value[0]) : trimString(value);
}

function forwardedOriginHeaders(req) {
  return {
    'X-Forwarded-Proto': singleHeader(req.headers['x-forwarded-proto']) || (req.socket?.encrypted ? 'https' : 'http'),
    'X-Forwarded-Host': singleHeader(req.headers['x-forwarded-host']) || singleHeader(req.headers.host),
    'X-Forwarded-Prefix': publicPrefix,
  };
}

async function sendProxyResponse(res, response) {
  const body = Buffer.from(await response.arrayBuffer());
  const headers = {
    'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
    'Content-Length': String(body.length),
    'Cache-Control': response.headers.get('cache-control') || 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  };
  for (const name of [
    'x-remotelab-display-observed-at',
    'x-remotelab-display-running',
    'x-remotelab-display-pending-review',
    'x-remotelab-display-poll-seconds',
  ]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(response.status, headers);
  res.end(body);
}

async function proxy(req, res, path, { body, authenticated = false } = {}) {
  const headers = {
    Accept: singleHeader(req.headers.accept) || '*/*',
    ...forwardedOriginHeaders(req),
  };
  const incomingAuthorization = singleHeader(req.headers.authorization);
  if (authenticated) headers.Authorization = `Bearer ${await adminToken()}`;
  else if (incomingAuthorization) headers.Authorization = incomingAuthorization;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${displayBaseUrl()}${path}`, {
    method: req.method,
    headers,
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  await sendProxyResponse(res, response);
}

function publicDisplayPath(pathname, method) {
  if (method === 'GET' && pathname === `${publicPrefix}/install.sh`) return '/install.sh';
  if (method === 'GET' && pathname === `${publicPrefix}/agent.py`) return '/agent.py';
  const enrollment = new RegExp(`^${publicPrefix}/v1/enroll/(rld_enroll_[A-Za-z0-9_-]+)$`).exec(pathname);
  if (method === 'POST' && enrollment) return `/v1/enroll/${enrollment[1]}`;
  const device = new RegExp(`^${publicPrefix}/v1/devices/(display-[a-f0-9]{16})/(frame\\.png|heartbeat)$`).exec(pathname);
  if (device && ((method === 'GET' && device[2] === 'frame.png') || (method === 'POST' && device[2] === 'heartbeat'))) {
    return `/v1/devices/${device[1]}/${device[2]}`;
  }
  return '';
}

export async function handleDisplayPublicRoutes({ req, res, pathname, writeJson }) {
  const targetPath = publicDisplayPath(pathname, req.method);
  if (!targetPath) return false;
  try {
    const body = req.method === 'POST' ? await readBody(req, 16 * 1024) : undefined;
    await proxy(req, res, targetPath, { body });
  } catch (error) {
    const tooLarge = error?.code === 'BODY_TOO_LARGE';
    writeJson(res, tooLarge ? 413 : 503, {
      error: tooLarge ? 'Display request is too large' : 'Display service is unavailable',
    });
  }
  return true;
}

export async function handleDisplaySettingsRoutes({ req, res, pathname, authSession, writeJson }) {
  const personId = trimString(authSession?.personId);
  if (!personId) return false;
  try {
    if (pathname === '/api/display/studio-preview' && req.method === 'POST') {
      const configDir = process.env.REMOTELAB_CONFIG_DIR || join(homedir(), '.config', 'remotelab');
      let previewConfig = {};
      try { previewConfig = JSON.parse(await readFile(join(configDir, 'display-studio-preview.json'), 'utf8')); } catch {}
      const endpoint = trimString(process.env.REMOTELAB_DISPLAY_STUDIO_PREVIEW_BASE_URL || previewConfig.baseUrl);
      const tokenFile = trimString(process.env.REMOTELAB_DISPLAY_STUDIO_PREVIEW_TOKEN_FILE || previewConfig.tokenFile);
      if (!endpoint || !tokenFile) { writeJson(res, 503, { error: '副屏预览通道未配置。' }); return true; }
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) { writeJson(res, 503, { error: '副屏预览通道只能使用本机地址。' }); return true; }
      const requestOrigin = trimString(req.headers.origin);
      const expectedOrigin = `${forwardedOriginHeaders(req)['X-Forwarded-Proto']}://${forwardedOriginHeaders(req)['X-Forwarded-Host']}`;
      if (requestOrigin !== expectedOrigin) { writeJson(res, 403, { error: '副屏预览请求来源不符。' }); return true; }
      const raw = await readBody(req, 9 * 1024 * 1024);
      const response = await fetch(`${endpoint.replace(/\/+$/, '')}/api/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${trimString(await readFile(tokenFile, 'utf8'))}`,
          'Content-Type': 'application/json',
          'X-Preview-Person-Id': personId,
        },
        body: raw,
        signal: AbortSignal.timeout(60_000),
      });
      await sendProxyResponse(res, response);
      return true;
    }
    if (pathname === '/api/display/content' && req.method === 'GET') {
      await proxy(req, res, `/v1/people/${encodeURIComponent(personId)}/content`, { authenticated: true });
      return true;
    }
    if (pathname === '/api/display/content.gif' && req.method === 'GET') {
      await proxy(req, res, `/v1/people/${encodeURIComponent(personId)}/content.gif`, { authenticated: true });
      return true;
    }
    if (pathname === '/api/display/preview.png' && req.method === 'GET') {
      await proxy(req, res, `/v1/people/${encodeURIComponent(personId)}/preview.png`, { authenticated: true });
      return true;
    }
    if (pathname === '/api/display/content' && req.method === 'PUT') {
      const raw = await readBody(req, 4 * 1024 * 1024 + 1024);
      let input;
      try { input = JSON.parse(raw); } catch { writeJson(res, 400, { error: 'Invalid JSON' }); return true; }
      await proxy(req, res, `/v1/people/${encodeURIComponent(personId)}/content`, {
        authenticated: true,
        body: { sentence: input?.sentence, gifBase64: input?.gifBase64 },
      });
      return true;
    }
    if (pathname === '/api/display/content' && req.method === 'DELETE') {
      await proxy(req, res, `/v1/people/${encodeURIComponent(personId)}/content`, { authenticated: true });
      return true;
    }
    if (pathname === '/api/display/devices' && req.method === 'GET') {
      await proxy(req, res, `/v1/devices?personId=${encodeURIComponent(personId)}`, { authenticated: true });
      return true;
    }
    if (pathname === '/api/display/enrollments' && req.method === 'POST') {
      await proxy(req, res, '/v1/enrollments', { authenticated: true, body: { personId } });
      return true;
    }
    const device = /^\/api\/display\/devices\/(display-[a-f0-9]{16})$/.exec(pathname);
    if (device && req.method === 'DELETE') {
      await proxy(req, res, `/v1/devices/${device[1]}?personId=${encodeURIComponent(personId)}`, { authenticated: true });
      return true;
    }
  } catch (error) {
    writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 503, {
      error: error?.code === 'BODY_TOO_LARGE' ? 'GIF upload is too large' : 'Display service is unavailable',
    });
    return true;
  }
  return false;
}
