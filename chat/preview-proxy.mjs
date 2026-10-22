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

export function validPreviewPostPath(value) {
  return typeof value === 'string' && /^\/[a-zA-Z0-9_/-]*$/.test(value) && !value.includes('//');
}

export function validPreviewRequestHeader(value) {
  return typeof value === 'string' && /^x-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    && !value.startsWith('x-forwarded-') && value !== 'x-real-ip';
}

async function routeFor(slug) {
  try {
    const routes = JSON.parse(await readFile(PREVIEW_ROUTES_FILE, 'utf8'));
    const route = routes?.[slug];
    if (!validPreviewPort(route?.port)) return null;
    return {
      port: route.port,
      postPaths: Array.isArray(route.postPaths) ? route.postPaths.filter(validPreviewPostPath) : [],
      requestHeaders: Array.isArray(route.requestHeaders) ? route.requestHeaders.filter(validPreviewRequestHeader) : [],
    };
  } catch {
    return null;
  }
}

// Only registered local services are reachable; the preview itself owns its
// authentication boundary. No client-supplied host or port is accepted.
export async function handlePreviewProxy(req, res, pathname) {
  const match = /^\/preview\/([a-z][a-z0-9-]{0,62})(\/.*)?$/.exec(pathname || '');
  if (!match) return false;
  const route = await routeFor(match[1]);
  if (!route) {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end('Preview route not found');
    return true;
  }
  const suffix = match[2] || '/';
  const allowsPost = route.postPaths.includes(suffix);
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && allowsPost)) {
    res.writeHead(405, { Allow: allowsPost ? 'GET, HEAD, POST' : 'GET, HEAD', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  const search = new URL(req.url || '/', 'http://localhost').search;
  const headers = {};
  const requestHeaders = ['authorization', 'range', 'if-range', 'if-none-match', 'if-modified-since',
    'content-type', 'content-length', 'origin', 'sec-fetch-site', ...route.requestHeaders];
  for (const name of requestHeaders) {
    if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
  }
  const upstream = http.request({ hostname: '127.0.0.1', port: route.port, path: `${suffix}${search}`, method: req.method, headers, timeout: 5000 }, (response) => {
    const allowed = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified',
      'www-authenticate', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'x-robots-tag'];
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
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
  return true;
}
