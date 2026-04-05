#!/usr/bin/env node

import { readFileSync } from 'fs';
import http from 'http';
import net from 'net';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const LISTEN_HOST = process.env.NATAPP_PROXY_LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = Number.parseInt(process.env.NATAPP_PROXY_LISTEN_PORT, 10) || 7699;
const LEGACY_ROOT_UPSTREAM_PORT = Number.parseInt(process.env.NATAPP_ROOT_UPSTREAM_PORT, 10) || 0;
const ROOT_MODE = normalizeRootMode(
  process.env.NATAPP_ROOT_MODE || (LEGACY_ROOT_UPSTREAM_PORT > 0 ? 'legacy-proxy' : 'index'),
);
const MAINLAND_SERVICE_UPSTREAM_PORT = Number.parseInt(
  process.env.NATAPP_MAINLAND_SERVICE_PORT || process.env.NATAPP_OWNER_UPSTREAM_PORT,
  10,
) || 7690;
const MAINLAND_SERVICE_NAME = normalizeRouteName(
  process.env.NATAPP_MAINLAND_SERVICE_NAME || process.env.NATAPP_OWNER_ROUTE_PREFIX || 'owner',
  'owner',
);
const MAINLAND_SERVICE_PREFIX = `/${MAINLAND_SERVICE_NAME}`;
const GUEST_REGISTRY_FILE = join(homedir(), '.config', 'remotelab', 'guest-instances.json');
const FALLBACK_PREFIXED_ROUTES = Object.freeze([
  Object.freeze({
    name: 'trial6',
    prefix: '/trial6',
    upstreamPort: 7701,
    cookiePrefix: 'trial6__',
  }),
  Object.freeze({
    name: 'intake1',
    prefix: '/intake1',
    upstreamPort: 7703,
    cookiePrefix: 'intake1__',
  }),
]);

const SPECIAL_PREFIXED_ROUTES = Object.freeze(buildSpecialPrefixedRoutes());

function normalizeRootMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'legacy-proxy' ? 'legacy-proxy' : 'index';
}

function normalizeRouteName(value, fallback = 'owner') {
  const trimmed = String(value || '').trim();
  const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, '');
  const firstSegment = withoutSlashes.split('/').filter(Boolean)[0] || '';
  const sanitized = firstSegment.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  return sanitized || fallback;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractPlistDictStrings(content, key) {
  const escapedKey = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`<key>${escapedKey}</key>\\s*<dict>([\\s\\S]*?)</dict>`));
  if (!match) return {};
  const dict = {};
  for (const entry of match[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    const dictKey = decodeXmlEntities(entry[1] || '');
    if (!dictKey) continue;
    dict[dictKey] = decodeXmlEntities(entry[2] || '');
  }
  return dict;
}

function readLaunchAgentPort(launchAgentPath) {
  const path = String(launchAgentPath || '').trim();
  if (!path) return 0;
  try {
    const content = readFileSync(path, 'utf8');
    const environmentVariables = extractPlistDictStrings(content, 'EnvironmentVariables');
    const port = Number.parseInt(String(environmentVariables.CHAT_PORT || '').trim(), 10);
    return isValidPort(port) ? port : 0;
  } catch {
    return 0;
  }
}

function extractPortFromBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim();
  if (!value) return 0;
  try {
    const parsed = new URL(value);
    const port = Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
    return isValidPort(port) ? port : 0;
  } catch {
    return 0;
  }
}

function resolveRouteUpstreamPort(record = {}) {
  const launchAgentPort = readLaunchAgentPort(record?.launchAgentPath);
  if (isValidPort(launchAgentPort) && launchAgentPort !== LISTEN_PORT) {
    return launchAgentPort;
  }

  const localBasePort = extractPortFromBaseUrl(record?.localBaseUrl);
  if (isValidPort(localBasePort) && localBasePort !== LISTEN_PORT) {
    return localBasePort;
  }

  const recordPort = Number.parseInt(record?.port, 10);
  if (isValidPort(recordPort) && recordPort !== LISTEN_PORT) {
    return recordPort;
  }

  return 0;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSpecialPrefixedRoutes() {
  if (!isValidPort(MAINLAND_SERVICE_UPSTREAM_PORT)) {
    return [];
  }
  if (MAINLAND_SERVICE_UPSTREAM_PORT === LISTEN_PORT) {
    return [];
  }
  return [Object.freeze({
    name: MAINLAND_SERVICE_NAME,
    prefix: MAINLAND_SERVICE_PREFIX,
    upstreamPort: MAINLAND_SERVICE_UPSTREAM_PORT,
    cookiePrefix: `${MAINLAND_SERVICE_NAME}__`,
    routeType: 'mainland-service',
  })];
}

function loadPrefixedRoutes() {
  const routes = [...SPECIAL_PREFIXED_ROUTES];
  const seenPrefixes = new Set(routes.map((route) => route.prefix));
  try {
    const parsed = JSON.parse(readFileSync(GUEST_REGISTRY_FILE, 'utf8'));
    if (!Array.isArray(parsed)) {
      return routes.length > 0 ? routes.concat(FALLBACK_PREFIXED_ROUTES) : FALLBACK_PREFIXED_ROUTES;
    }

    for (const record of parsed) {
      const name = normalizeRouteName(record?.name, '');
      const upstreamPort = resolveRouteUpstreamPort(record);
      if (!name) continue;
      if (!isValidPort(upstreamPort) || upstreamPort === LISTEN_PORT) continue;

      const prefix = `/${name}`;
      if (seenPrefixes.has(prefix)) continue;
      seenPrefixes.add(prefix);
      routes.push(Object.freeze({
        name,
        prefix,
        upstreamPort,
        cookiePrefix: `${name}__`,
        routeType: 'instance',
      }));
    }

    if (routes.length > SPECIAL_PREFIXED_ROUTES.length) return routes;
    return routes.length > 0 ? routes.concat(FALLBACK_PREFIXED_ROUTES.filter((route) => !seenPrefixes.has(route.prefix))) : FALLBACK_PREFIXED_ROUTES;
  } catch {
    return routes.length > 0 ? routes.concat(FALLBACK_PREFIXED_ROUTES.filter((route) => !seenPrefixes.has(route.prefix))) : FALLBACK_PREFIXED_ROUTES;
  }
}

function parseCookieHeader(raw) {
  const cookies = [];
  for (const part of String(raw || '').split(/;\s*/)) {
    if (!part) continue;
    const index = part.indexOf('=');
    if (index < 0) continue;
    cookies.push({
      name: part.slice(0, index).trim(),
      value: part.slice(index + 1),
    });
  }
  return cookies;
}

function serializeCookies(cookies) {
  return cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
}

function findPrefixedRoute(pathname) {
  return loadPrefixedRoutes().find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) || null;
}

function mapRequest(reqUrl) {
  const parsed = new URL(reqUrl, 'http://127.0.0.1');
  const prefixedRoute = findPrefixedRoute(parsed.pathname);
  if (!prefixedRoute) {
    if (ROOT_MODE === 'legacy-proxy' && isValidPort(LEGACY_ROOT_UPSTREAM_PORT)) {
      return {
        prefixed: false,
        prefix: '',
        cookiePrefix: '',
        upstreamPort: LEGACY_ROOT_UPSTREAM_PORT,
        upstreamPath: `${parsed.pathname}${parsed.search}`,
      };
    }
    return null;
  }

  const strippedPath = parsed.pathname.slice(prefixedRoute.prefix.length) || '/';
  return {
    ...prefixedRoute,
    prefixed: true,
    upstreamPath: `${strippedPath}${parsed.search}`,
  };
}

function buildUpstreamHeaders(headers, route) {
  const upstreamHeaders = { ...headers };
  upstreamHeaders['accept-encoding'] = 'identity';

  if (route.prefixed) {
    let cookies = parseCookieHeader(headers.cookie)
      .filter((cookie) => cookie.name.startsWith(route.cookiePrefix))
      .map((cookie) => ({
        name: cookie.name.slice(route.cookiePrefix.length),
        value: cookie.value,
      }));

    if (cookies.length === 0 && route.cookiePrefix === 'owner__') {
      cookies = parseCookieHeader(headers.cookie)
        .filter((cookie) => cookie.name === 'session_token' || cookie.name === 'visitor_session_token');
    }

    if (cookies.length > 0) {
      upstreamHeaders.cookie = serializeCookies(cookies);
    } else {
      delete upstreamHeaders.cookie;
    }
  }

  return upstreamHeaders;
}

function rewriteLocationHeader(location, route) {
  const value = String(location || '').trim();
  if (!value) return value;
  if (!route.prefixed) return value;
  if (value.startsWith(route.prefix)) return value;
  if (value.startsWith('/')) return `${route.prefix}${value}`;
  return value;
}

function rewriteSetCookieHeader(headerValue, route) {
  const text = String(headerValue || '');
  const firstSemicolon = text.indexOf(';');
  const firstPart = firstSemicolon >= 0 ? text.slice(0, firstSemicolon) : text;
  const suffix = firstSemicolon >= 0 ? text.slice(firstSemicolon + 1) : '';
  const equalsIndex = firstPart.indexOf('=');
  if (equalsIndex < 0) return text;

  const originalName = firstPart.slice(0, equalsIndex).trim();
  const originalValue = firstPart.slice(equalsIndex + 1);
  const segments = suffix
    ? suffix.split(';').map((segment) => segment.trim()).filter(Boolean)
    : [];
  const filteredSegments = segments.filter((segment) => !/^path=/i.test(segment));
  filteredSegments.unshift(`Path=${route.prefix}`);
  return `${route.cookiePrefix}${originalName}=${originalValue}; ${filteredSegments.join('; ')}`;
}

function rewritePrefixedBody(body, contentType, route) {
  const prefix = route.prefix;
  let text = body.toString('utf8');

  const replacements = [
    [/\/api\//g, `${prefix}/api/`],
    [/\/ws\/voice-input\b/g, `${prefix}/ws/voice-input`],
    [/\/ws\b/g, `${prefix}/ws`],
    [/\/login\b/g, `${prefix}/login`],
    [/\/logout\b/g, `${prefix}/logout`],
    [/\/m\/install\b/g, `${prefix}/m/install`],
    [/\/manifest\.json\b/g, `${prefix}/manifest.json`],
    [/\/manifest\.install\.json\b/g, `${prefix}/manifest.install.json`],
    [/\/favicon\.ico\b/g, `${prefix}/favicon.ico`],
    [/\/icon-512\.png\b/g, `${prefix}/icon-512.png`],
    [/\/icon-192\.png\b/g, `${prefix}/icon-192.png`],
    [/\/icon\.svg\b/g, `${prefix}/icon.svg`],
    [/\/apple-touch-icon\.png\b/g, `${prefix}/apple-touch-icon.png`],
    [/\/sw\.js\b/g, `${prefix}/sw.js`],
    [/\/marked\.min\.js\b/g, `${prefix}/marked.min.js`],
    [/\/chat\//g, `${prefix}/chat/`],
    [/\/static\//g, `${prefix}/static/`],
    [/\/visitor\//g, `${prefix}/visitor/`],
    [/\/share-receive\b/g, `${prefix}/share-receive`],
    [/\/share\//g, `${prefix}/share/`],
    [/\/app\//g, `${prefix}/app/`],
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  const baseHref = `${prefix}/`;
  if (String(contentType || '').includes('text/html') && !text.includes(`<base href="${baseHref}">`)) {
    text = text.replace('<head>', `<head>\n  <base href="${baseHref}">`);
  }

  return Buffer.from(text, 'utf8');
}

function shouldRewriteBody(headers) {
  const contentType = String(headers['content-type'] || '').toLowerCase();
  return (
    contentType.includes('text/html')
    || contentType.includes('javascript')
    || contentType.includes('text/css')
    || contentType.includes('application/manifest+json')
  );
}

function writeProxyError(res, error) {
  res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`proxy error: ${error?.message || error}`);
}

function renderRootIndexHtml() {
  const routes = loadPrefixedRoutes().map((route) => ({
    name: route.name || route.prefix.replace(/^\/+/, ''),
    href: `${route.prefix}/`,
    kind: route.routeType === 'mainland-service' ? 'main service' : 'instance',
  }));

  const items = routes.length > 0
    ? routes
      .map((route) => `<li><a href="${escapeHtml(route.href)}">${escapeHtml(route.href)}</a><span> ${escapeHtml(route.kind)}</span></li>`)
      .join('\n')
    : '<li>No prefixed routes are registered.</li>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>RemoteLab Mainland Bridge</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; background: #f6f7f8; color: #172126; }
      main { max-width: 760px; margin: 0 auto; padding: 32px 20px 48px; }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { margin: 0 0 12px; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #e9eef2; padding: 0.1em 0.35em; border-radius: 6px; }
      ul { margin: 18px 0 0; padding-left: 22px; }
      li + li { margin-top: 8px; }
      a { color: #0b63ce; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <main>
      <h1>RemoteLab Mainland Bridge</h1>
      <p>This bridge is prefix-only. Open product surfaces under <code>/{name}/</code>.</p>
      <p>Known routes:</p>
      <ul>${items}</ul>
    </main>
  </body>
</html>`;
}

function getLastPrefixFromCookie(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const entry = cookies.find((c) => c.name === 'bridge_last_prefix');
  const value = entry?.value?.trim();
  if (!value || !value.startsWith('/')) return null;
  const routes = loadPrefixedRoutes();
  return routes.some((r) => r.prefix === value) ? value : null;
}

function writeRootIndex(req, res) {
  const lastPrefix = getLastPrefixFromCookie(req);
  if (lastPrefix) {
    res.writeHead(302, {
      location: `${lastPrefix}/`,
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }
  const body = Buffer.from(renderRootIndexHtml(), 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function writePrefixOnlyNotFound(res) {
  const body = 'This mainland bridge is prefix-only. Open /{name}/.\n';
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const route = mapRequest(req.url || '/');
  if (!route) {
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
      writeRootIndex(req, res);
      return;
    }
    writePrefixOnlyNotFound(res);
    return;
  }
  const upstreamReq = http.request({
    host: LISTEN_HOST,
    port: route.upstreamPort,
    method: req.method,
    path: route.upstreamPath,
    headers: buildUpstreamHeaders(req.headers, route),
  }, (upstreamRes) => {
    const headers = { ...upstreamRes.headers };

    if (route.prefixed) {
      if (headers.location) {
        headers.location = rewriteLocationHeader(headers.location, route);
      }
      if (headers['set-cookie']) {
        const values = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
        headers['set-cookie'] = values.map((value) => rewriteSetCookieHeader(value, route));
      }
      // Remember last-used prefix so the root path can auto-redirect next time
      const prefixCookie = `bridge_last_prefix=${route.prefix}; Path=/; Max-Age=31536000; SameSite=Lax`;
      const existing = headers['set-cookie'];
      if (Array.isArray(existing)) {
        existing.push(prefixCookie);
      } else if (existing) {
        headers['set-cookie'] = [existing, prefixCookie];
      } else {
        headers['set-cookie'] = prefixCookie;
      }
    }

    const rewriteBody = route.prefixed && shouldRewriteBody(headers);
    if (!rewriteBody) {
      res.writeHead(upstreamRes.statusCode || 502, headers);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    upstreamRes.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    upstreamRes.on('end', () => {
      const rewrittenBody = rewritePrefixedBody(Buffer.concat(chunks), headers['content-type'], route);
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      delete headers['content-encoding'];
      headers['content-length'] = String(rewrittenBody.length);
      res.writeHead(upstreamRes.statusCode || 200, headers);
      res.end(rewrittenBody);
    });
    upstreamRes.on('error', (error) => writeProxyError(res, error));
  });

  upstreamReq.on('error', (error) => writeProxyError(res, error));
  req.pipe(upstreamReq);
});

server.on('upgrade', (req, socket, head) => {
  const route = mapRequest(req.url || '/');
  if (!route) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const upstreamSocket = net.connect(route.upstreamPort, LISTEN_HOST, () => {
    const requestPath = route.upstreamPath || '/';
    const rawHeaders = [];
    const headers = buildUpstreamHeaders(req.headers, route);
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          rawHeaders.push(`${key}: ${item}`);
        }
        continue;
      }
      if (value == null) continue;
      rawHeaders.push(`${key}: ${value}`);
    }
    upstreamSocket.write(`${req.method} ${requestPath} HTTP/${req.httpVersion}\r\n${rawHeaders.join('\r\n')}\r\n\r\n`);
    if (head && head.length) {
      upstreamSocket.write(head);
    }
    socket.pipe(upstreamSocket).pipe(socket);
  });

  upstreamSocket.on('error', () => socket.destroy());
  socket.on('error', () => upstreamSocket.destroy());
});

const IS_MAIN = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    const prefixes = loadPrefixedRoutes().map((route) => route.prefix).join(', ');
    const rootLabel = ROOT_MODE === 'legacy-proxy' && isValidPort(LEGACY_ROOT_UPSTREAM_PORT)
      ? `legacy-proxy->${LEGACY_ROOT_UPSTREAM_PORT}`
      : 'index';
    console.log(`natapp dual proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT} (root=${rootLabel}; ${prefixes || 'no prefixed routes'})`);
  });
}

export {
  LISTEN_HOST,
  LISTEN_PORT,
  LEGACY_ROOT_UPSTREAM_PORT,
  ROOT_MODE,
  MAINLAND_SERVICE_NAME,
  MAINLAND_SERVICE_UPSTREAM_PORT,
  MAINLAND_SERVICE_PREFIX,
  loadPrefixedRoutes,
  mapRequest,
  buildUpstreamHeaders,
  rewriteSetCookieHeader,
  resolveRouteUpstreamPort,
  renderRootIndexHtml,
};
