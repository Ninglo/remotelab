import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';

export const PREVIEW_ROUTES_FILE = join(CONFIG_DIR, 'preview-routes.json');

export function validPreviewSlug(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(value);
}

export function validPreviewPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

async function routeFor(slug) {
  try {
    const routes = JSON.parse(await readFile(PREVIEW_ROUTES_FILE, 'utf8'));
    const port = routes?.[slug]?.port;
    return validPreviewPort(port) ? port : null;
  } catch {
    return null;
  }
}

// Only registered local services are reachable; the preview itself owns its
// authentication boundary. No client-supplied host or port is accepted.
export async function handlePreviewProxy(req, res, pathname) {
  const match = /^\/preview\/([a-z][a-z0-9-]{0,62})(\/.*)?$/.exec(pathname || '');
  if (!match) return false;
  const port = await routeFor(match[1]);
  if (!port) {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end('Preview route not found');
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  const suffix = match[2] || '/';
  const search = new URL(req.url || '/', 'http://localhost').search;
  const headers = {};
  if (typeof req.headers.authorization === 'string') headers.authorization = req.headers.authorization;
  const upstream = http.request({ hostname: '127.0.0.1', port, path: `${suffix}${search}`, method: req.method, headers, timeout: 5000 }, (response) => {
    const allowed = ['content-type', 'www-authenticate', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'x-robots-tag'];
    const responseHeaders = { 'Cache-Control': 'private, no-store, max-age=0' };
    for (const name of allowed) {
      if (response.headers[name]) responseHeaders[name] = response.headers[name];
    }
    res.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Preview service timed out')));
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Cache-Control': 'no-store' });
    res.end();
  });
  res.on('close', () => upstream.destroy());
  upstream.end();
  return true;
}
