#!/usr/bin/env node

import { readFileSync } from 'fs';
import http from 'http';
import net from 'net';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const LISTEN_HOST = process.env.NATAPP_PROXY_LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = Number.parseInt(process.env.NATAPP_PROXY_LISTEN_PORT, 10) || 7699;
const ROOT_UPSTREAM_PORT = Number.parseInt(process.env.NATAPP_ROOT_UPSTREAM_PORT, 10) || 7804;
const OWNER_UPSTREAM_PORT = Number.parseInt(process.env.NATAPP_OWNER_UPSTREAM_PORT, 10) || 7690;
const OWNER_ROUTE_PREFIX = normalizeRoutePrefix(process.env.NATAPP_OWNER_ROUTE_PREFIX || '/owner');
const GUEST_REGISTRY_FILE = join(homedir(), '.config', 'remotelab', 'guest-instances.json');
const FALLBACK_PREFIXED_ROUTES = Object.freeze([
  Object.freeze({
    prefix: '/trial6',
    upstreamPort: 7701,
    cookiePrefix: 'trial6__',
  }),
  Object.freeze({
    prefix: '/intake1',
    upstreamPort: 7703,
    cookiePrefix: 'intake1__',
  }),
]);

const SPECIAL_PREFIXED_ROUTES = Object.freeze(buildSpecialPrefixedRoutes());

function normalizeRoutePrefix(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '/owner';
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = normalized.replace(/\/+$/, '') || '/owner';
  return withoutTrailingSlash === '/' ? '/owner' : withoutTrailingSlash;
}

function buildSpecialPrefixedRoutes() {
  if (!Number.isInteger(OWNER_UPSTREAM_PORT) || OWNER_UPSTREAM_PORT < 1 || OWNER_UPSTREAM_PORT > 65535) {
    return [];
  }
  if (OWNER_UPSTREAM_PORT === LISTEN_PORT || OWNER_ROUTE_PREFIX === '/') {
    return [];
  }
  return [Object.freeze({
    prefix: OWNER_ROUTE_PREFIX,
    upstreamPort: OWNER_UPSTREAM_PORT,
    cookiePrefix: 'owner__',
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
      const name = String(record?.name || '').trim();
      const upstreamPort = Number.parseInt(record?.port, 10);
      if (!name) continue;
      if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) continue;
      if (upstreamPort === LISTEN_PORT || upstreamPort === ROOT_UPSTREAM_PORT) continue;

      const prefix = `/${name}`;
      if (seenPrefixes.has(prefix)) continue;
      seenPrefixes.add(prefix);
      routes.push(Object.freeze({
        prefix,
        upstreamPort,
        cookiePrefix: `${name}__`,
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
    return {
      prefixed: false,
      prefix: '',
      cookiePrefix: '',
      upstreamPort: ROOT_UPSTREAM_PORT,
      upstreamPath: `${parsed.pathname}${parsed.search}`,
    };
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
    [/\/icon\.svg\b/g, `${prefix}/icon.svg`],
    [/\/apple-touch-icon\.png\b/g, `${prefix}/apple-touch-icon.png`],
    [/\/sw\.js\b/g, `${prefix}/sw.js`],
    [/\/marked\.min\.js\b/g, `${prefix}/marked.min.js`],
    [/\/chat\//g, `${prefix}/chat/`],
    [/\/static\//g, `${prefix}/static/`],
    [/\/visitor\//g, `${prefix}/visitor/`],
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

const server = http.createServer((req, res) => {
  const route = mapRequest(req.url || '/');
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
    console.log(`natapp dual proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT} (root->${ROOT_UPSTREAM_PORT}; ${prefixes || 'no prefixed routes'})`);
  });
}

export {
  LISTEN_HOST,
  LISTEN_PORT,
  ROOT_UPSTREAM_PORT,
  OWNER_UPSTREAM_PORT,
  OWNER_ROUTE_PREFIX,
  loadPrefixedRoutes,
  mapRequest,
  buildUpstreamHeaders,
  rewriteSetCookieHeader,
};
