import { randomBytes } from 'crypto';
import { isAuthenticated } from '../lib/auth.mjs';
import { FILE_ASSET_ALLOWED_ORIGINS } from '../lib/config.mjs';
import { getConnectorSurface, isConnectorSurfacePublicPath } from '../lib/connector-surface-registry.mjs';

// ---- Rate limiting ----

const failedAttempts = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

export function isRateLimited(ip) {
  const state = failedAttempts.get(ip);
  if (!state) return false;
  if (state.lockedUntil && Date.now() < state.lockedUntil) return true;
  return false;
}

export function recordFailedAttempt(ip) {
  const state = failedAttempts.get(ip) || { count: 0, lockedUntil: null };
  state.count += 1;
  if (state.count >= RATE_LIMIT_MAX) {
    const exponent = state.count - RATE_LIMIT_MAX;
    const backoffMs = Math.min(RATE_LIMIT_WINDOW_MS * Math.pow(2, exponent), 15 * 60 * 1000);
    state.lockedUntil = Date.now() + backoffMs;
  }
  failedAttempts.set(ip, state);
}

export function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

// ---- Security headers ----

const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-UA-Compatible': 'IE=edge',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
};

export function setSecurityHeaders(res, nonce) {
  const connectSrc = ["'self'", 'ws:', 'wss:', ...FILE_ASSET_ALLOWED_ORIGINS];
  const mediaSrc = ["'self'", 'data:', 'blob:', ...FILE_ASSET_ALLOWED_ORIGINS];
  for (const [key, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src ${connectSrc.join(' ')}`,
    `img-src ${mediaSrc.join(' ')}`,
    `media-src ${mediaSrc.join(' ')}`,
  ].join('; '));
}

export function generateNonce() {
  return randomBytes(16).toString('base64');
}

function parseConnectorSurfaceProxyRoute(pathname = '') {
  const match = String(pathname || '').match(/^\/connectors\/([a-z0-9._:-]+)(\/.*)?$/i);
  if (!match) return null;
  return {
    connectorId: String(match[1] || '').trim().toLowerCase(),
    tailPath: String(match[2] || '').trim() || '/',
  };
}

async function allowsUnauthenticatedConnectorSurfaceRequest(pathname = '') {
  const route = parseConnectorSurfaceProxyRoute(pathname);
  if (!route?.connectorId) return false;
  const surface = await getConnectorSurface(route.connectorId);
  return isConnectorSurfacePublicPath(surface, route.tailPath);
}

// ---- Auth middleware ----

/**
 * Returns true if the request is authenticated.
 * If not, writes a 401 JSON response for API routes or a 302 redirect for pages.
 */
export async function requireAuth(req, res) {
  if (isAuthenticated(req)) return true;
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  if (
    requestUrl.pathname === '/api/connectors/gmail/google/callback'
    || requestUrl.pathname === '/api/connectors/calendar/google/callback'
    || requestUrl.pathname.endsWith('/api/connectors/gmail/google/callback')
    || requestUrl.pathname.endsWith('/api/connectors/calendar/google/callback')
  ) {
    return true;
  }
  if (await allowsUnauthenticatedConnectorSurfaceRequest(requestUrl.pathname)) {
    return true;
  }
  if (
    requestUrl.pathname === '/connectors/wechat/login/open'
    || requestUrl.pathname.endsWith('/connectors/wechat/login/open')
  ) {
    const { verifyWeChatLoginOpenRequest } = await import('../lib/wechat-connector-login.mjs');
    if (await verifyWeChatLoginOpenRequest({
      pathname: requestUrl.pathname,
      searchParams: requestUrl.searchParams,
    })) {
      return true;
    }
  }
  const { authenticateBearerToken } = await import('../lib/auth.mjs');
  if (await authenticateBearerToken(req)) return true;
  if ((req.url || '').startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authenticated' }));
    return false;
  }
  res.writeHead(302, { 'Location': '/login' });
  res.end();
  return false;
}
