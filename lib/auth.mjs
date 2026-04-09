import { randomBytes, timingSafeEqual, scrypt } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { promisify } from 'util';
import { AUTH_FILE, AUTH_SESSIONS_FILE, SESSION_EXPIRY, SECURE_COOKIES } from './config.mjs';
import { resolveAuthSessionAgentId } from '../chat/session-source-resolution.mjs';

const scryptAsync = promisify(scrypt);
const AUTH_COOKIE_NAME = 'session_token';
const VISITOR_COOKIE_NAME = 'visitor_session_token';
const AUTH_COOKIE_SAME_SITE = 'Lax';
const SESSION_REFRESH_WINDOW_MS = Math.min(
  12 * 60 * 60 * 1000,
  Math.max(60 * 1000, Math.floor(SESSION_EXPIRY / 2)),
);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAuthSession(session) {
  if (!session || typeof session !== 'object') return null;
  const normalized = {
    ...session,
    role: session.role || 'owner',
  };
  const normalizedAgentId = resolveAuthSessionAgentId(session);
  if (normalizedAgentId) {
    normalized.agentId = normalizedAgentId;
    normalized.scope = session?.scope && typeof session.scope === 'object' && !Array.isArray(session.scope)
      ? {
          ...session.scope,
          agentId: normalizedAgentId,
        }
      : { agentId: normalizedAgentId };
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'appId')) {
    delete normalized.appId;
  }
  return normalized;
}

async function loadAuth() {
  try {
    return JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to load auth.json:', err.message);
    process.exit(1);
  }
}

export const auth = await loadAuth();

export async function loadAuthSessions() {
  try {
    let data;
    try {
      data = JSON.parse(await readFile(AUTH_SESSIONS_FILE, 'utf8'));
    } catch (readError) {
      if (readError?.code === 'ENOENT') {
        return new Map();
      }
      throw readError;
    }
    const map = new Map();
    const now = Date.now();
    let migrated = false;
    for (const [token, session] of Object.entries(data)) {
      if (session.expiry > now) {
        const normalized = normalizeAuthSession(session);
        if (normalized && JSON.stringify(normalized) !== JSON.stringify(session)) migrated = true;
        if (normalized) map.set(token, normalized);
      }
    }
    if (migrated) {
      await writeFile(AUTH_SESSIONS_FILE, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
    }
    return map;
  } catch (err) {
    console.error('Failed to load auth-sessions.json:', err.message);
    return new Map();
  }
}

export const saveAuthSessions = saveAuthSessionsAsync;

export async function saveAuthSessionsAsync() {
  try {
    const configDir = dirname(AUTH_SESSIONS_FILE);
    await mkdir(configDir, { recursive: true });
    const data = Object.fromEntries(sessions);
    await writeFile(AUTH_SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save auth-sessions.json:', err.message);
  }
}

export const sessions = await loadAuthSessions();

export const verifyToken = verifyTokenAsync;

export async function verifyTokenAsync(inputToken) {
  if (!inputToken || typeof inputToken !== 'string') return false;
  let currentAuth;
  try {
    currentAuth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  } catch {
    return false;
  }
  const storedBuf = Buffer.from(currentAuth.token, 'hex');
  const inputBuf = Buffer.from(inputToken, 'hex');
  if (storedBuf.length !== inputBuf.length) return false;
  return timingSafeEqual(storedBuf, inputBuf);
}

export function generateToken() {
  return randomBytes(32).toString('hex');
}

export const hashPassword = hashPasswordAsync;

export async function hashPasswordAsync(password) {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = await scryptAsync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export const verifyPassword = verifyPasswordAsync;

export async function verifyPasswordAsync(username, password) {
  if (!username || !password) return false;
  let currentAuth;
  try {
    currentAuth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  } catch {
    return false;
  }
  if (!currentAuth.username || !currentAuth.passwordHash) return false;
  if (currentAuth.username !== username) return false;
  const parts = currentAuth.passwordHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const storedHash = Buffer.from(hashHex, 'hex');
  try {
    const inputHash = await scryptAsync(password, salt, 32, { N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10) });
    return timingSafeEqual(storedHash, inputHash);
  } catch {
    return false;
  }
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) cookies[key] = value;
  });
  return cookies;
}

export function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[AUTH_COOKIE_NAME] || null;
}

export function getVisitorSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[VISITOR_COOKIE_NAME] || null;
}

function deleteExpiredSession(token) {
  sessions.delete(token);
  void saveAuthSessionsAsync();
}

function getValidSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiry) {
    deleteExpiredSession(token);
    return null;
  }
  return session;
}

function requestPrefersVisitor(req) {
  try {
    const url = new URL(req?.url || '/', 'http://localhost');
    return url.searchParams.get('visitor') === '1';
  } catch {
    return false;
  }
}

export function isAuthenticated(req) {
  if (req._bearerAuthSession) return true;
  if (requestPrefersVisitor(req)) {
    return !!getValidSession(getVisitorSessionToken(req));
  }
  return !!getValidSession(getSessionToken(req))
    || !!getValidSession(getVisitorSessionToken(req));
}

/**
 * Get the auth session data for a request (role, agentId, visitorId, etc.).
 * Requests with ?visitor=1 use the visitor cookie only.
 * Other requests check the owner cookie first, then the visitor cookie.
 * Also supports Bearer token auth via req._bearerAuthSession (set by middleware).
 * Returns null if not authenticated.
 */
export function getAuthSession(req) {
  if (req._bearerAuthSession) return normalizeAuthSession(req._bearerAuthSession);
  if (requestPrefersVisitor(req)) {
    const visitorSession = getValidSession(getVisitorSessionToken(req));
    if (visitorSession) return normalizeAuthSession(visitorSession);
    return null;
  }
  const ownerSession = getValidSession(getSessionToken(req));
  if (ownerSession) return normalizeAuthSession(ownerSession);
  const visitorSession = getValidSession(getVisitorSessionToken(req));
  if (visitorSession) return normalizeAuthSession(visitorSession);
  return null;
}

function getBearerToken(req) {
  const header = req.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

export async function authenticateBearerToken(req) {
  const token = getBearerToken(req);
  if (!token) return false;
  const valid = await verifyTokenAsync(token);
  if (!valid) return false;
  req._bearerAuthSession = { role: 'owner', expiry: Date.now() + SESSION_EXPIRY };
  return true;
}

export async function refreshAuthSession(req, { force = false } = {}) {
  const preferVisitor = requestPrefersVisitor(req);
  let token = preferVisitor ? getVisitorSessionToken(req) : getSessionToken(req);
  let session = getValidSession(token);
  let cookieFn = preferVisitor ? setVisitorCookie : setCookie;
  if (!preferVisitor && (!token || !session)) {
    token = getVisitorSessionToken(req);
    session = getValidSession(token);
    cookieFn = setVisitorCookie;
  }
  if (!token || !session) return null;
  if (!force && session.expiry - Date.now() > SESSION_REFRESH_WINDOW_MS) {
    return null;
  }
  sessions.set(token, {
    ...session,
    expiry: Date.now() + SESSION_EXPIRY,
  });
  await saveAuthSessionsAsync();
  return cookieFn(token);
}

export function setCookie(token) {
  const maxAgeSeconds = Math.max(1, Math.floor(SESSION_EXPIRY / 1000));
  const expiry = new Date(Date.now() + SESSION_EXPIRY);
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=${token}; HttpOnly${secure}; SameSite=${AUTH_COOKIE_SAME_SITE}; Path=/; Max-Age=${maxAgeSeconds}; Expires=${expiry.toUTCString()}`;
}

export function clearCookie() {
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=; HttpOnly${secure}; SameSite=${AUTH_COOKIE_SAME_SITE}; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function setVisitorCookie(token) {
  const maxAgeSeconds = Math.max(1, Math.floor(SESSION_EXPIRY / 1000));
  const expiry = new Date(Date.now() + SESSION_EXPIRY);
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `${VISITOR_COOKIE_NAME}=${token}; HttpOnly${secure}; SameSite=${AUTH_COOKIE_SAME_SITE}; Path=/; Max-Age=${maxAgeSeconds}; Expires=${expiry.toUTCString()}`;
}

export function clearVisitorCookie() {
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `${VISITOR_COOKIE_NAME}=; HttpOnly${secure}; SameSite=${AUTH_COOKIE_SAME_SITE}; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * Get the visitor auth session from the visitor-specific cookie.
 * Used when the request explicitly indicates visitor mode (e.g. ?visitor=1).
 */
export function getVisitorAuthSession(req) {
  const token = getVisitorSessionToken(req);
  const session = getValidSession(token);
  if (!session) return null;
  return normalizeAuthSession(session);
}
