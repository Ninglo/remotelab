import { requireEmployeeSite, employeeSitePerson, sameSiteOrigin } from './employee-site-auth.mjs';
import { legacySiteLogin, previewIdentityPolicy } from '../lib/legacy-site-login.mjs';
import { siteUsageHtmlTransform, siteUsageCsp, siteUsageOrigin } from './site-usage-html.mjs';
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
    && !value.startsWith('x-remotelab-') && !value.startsWith('x-forwarded-') && value !== 'x-real-ip';
}

async function routeFor(slug) {
  try {
    const routes = JSON.parse(await readFile(PREVIEW_ROUTES_FILE, 'utf8'));
    const route = routes?.[slug];
    if (!validPreviewPort(route?.port) || route.access && !['basic', 'employee'].includes(route.access)) return null;
    let identity = {};
    try { identity = await previewIdentityPolicy(slug, route.port); } catch {}
    return {
      port: route.port,
      access: route.access || 'basic',
      reuseIdentity: route.reuseIdentity === true || identity.reuseIdentity === true,
      recognizeIdentity: route.recognizeIdentity === true || identity.recognizeIdentity === true,
      employeeLogin: identity.employeeLogin === true,
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
  let person;
  const mappedLogin = route.employeeLogin && !req.headers.authorization;
  if (route.access === 'employee' || mappedLogin) {
    person = await requireEmployeeSite(req, res);
    if (!person) return true;
    if (!['GET', 'HEAD'].includes(req.method) && !sameSiteOrigin(req)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end('Cross-origin write denied'); return true;
    }
  } else if (route.reuseIdentity || route.recognizeIdentity) {
    // Optional recognition preserves old requests, challenges and in-flight work.
    // Failure of the new identity store must not block the original login.
    try { person = await employeeSitePerson(req, res); } catch {}
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
    if (route.access === 'employee' && name === 'authorization') continue;
    if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
  }
  if (person) headers['x-remotelab-person-id'] = person.id;
  let replayedAuthorization = false;
  if (mappedLogin) {
    try { headers.authorization = await legacySiteLogin.lookup(match[1], person.id, route.port); } catch {}
    if (!headers.authorization) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end('飞书身份已核验；此网站仅向原获授权人员开放。'); return true;
    }
    replayedAuthorization = true;
  } else if (route.access === 'basic' && route.reuseIdentity && person) {
    // Keep the browser's original credential authoritative when it is present.
    if (typeof req.headers.authorization === 'string') headers.authorization = req.headers.authorization;
    else try {
      headers.authorization = await legacySiteLogin.lookup(match[1], person.id, route.port) || undefined;
      replayedAuthorization = Boolean(headers.authorization);
    } catch {}
    if (!headers.authorization) delete headers.authorization;
    if (replayedAuthorization && !['GET', 'HEAD'].includes(req.method) && !sameSiteOrigin(req)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end('Cross-origin write denied'); return true;
    }
  }
  const upstream = http.request({ hostname: '127.0.0.1', port: route.port, path: `${suffix}${search}`, method: req.method, headers, timeout: 5000 }, async (response) => {
    if ((mappedLogin || route.access === 'employee') && response.statusCode === 401 && response.headers['www-authenticate']) {
      response.resume();
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end('网站原有身份映射已失效，需要维护端更新；无需重新输入网站密码。'); return;
    }
    if (route.access === 'basic' && route.reuseIdentity && person && req.method === 'GET'
      && suffix === '/' && response.statusCode >= 200 && response.statusCode < 300
      && req.headers.authorization?.startsWith('Basic ')) {
      // Enabling reuse verified the root rejects anonymous access. A successful
      // original root login is proof for this Person, never a company-wide grant.
      await legacySiteLogin.remember(match[1], person.id, req.headers.authorization, route.port)
        .catch(() => console.error('Could not retain a legacy site identity mapping'));
    }
    const allowed = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified',
      'www-authenticate', 'content-security-policy', 'content-encoding', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'x-robots-tag'];
    const responseHeaders = { 'Cache-Control': 'private, no-store, max-age=0' };
    for (const name of allowed) {
      if (response.headers[name]) responseHeaders[name] = response.headers[name];
    }
    const html = person && req.method === 'GET' && !req.headers.range && response.statusCode === 200
      && /^text\/html(?:;|$)/i.test(response.headers['content-type'] || '')
      && (!response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity');
    if (html) {
      delete responseHeaders['content-length']; delete responseHeaders.etag;
      if (responseHeaders['content-security-policy']) responseHeaders['content-security-policy'] = siteUsageCsp(responseHeaders['content-security-policy'], siteUsageOrigin(req));
    }
    res.writeHead(response.statusCode || 502, responseHeaders);
    if (html) response.pipe(siteUsageHtmlTransform(responseHeaders['content-security-policy'] || '')).pipe(res);
    else response.pipe(res);
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
