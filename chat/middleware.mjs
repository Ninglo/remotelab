import { randomBytes } from 'crypto';
import { isAuthenticated } from '../lib/auth.mjs';
import { FILE_ASSET_ALLOWED_ORIGINS } from '../lib/config.mjs';

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

// ---- Auth middleware ----

/**
 * Returns true if the request is authenticated.
 * If not, writes a 401 JSON response for API routes or a 302 redirect for pages.
 */
export async function requireAuth(req, res) {
  if (isAuthenticated(req)) return true;
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
