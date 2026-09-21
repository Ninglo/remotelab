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
  } catch {
    writeJson(res, 503, { error: 'Display service is unavailable' });
    return true;
  }
  return false;
}
