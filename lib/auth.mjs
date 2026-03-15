import { randomBytes, timingSafeEqual, scrypt, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { promisify } from 'util';
import { AUTH_FILE, AUTH_SESSIONS_FILE, SESSION_EXPIRY, SECURE_COOKIES } from './config.mjs';

const scryptAsync = promisify(scrypt);
const AUTH_COOKIE_NAME = 'session_token';
const VISITOR_COOKIE_NAME = 'visitor_session_token';
const AUTH_COOKIE_SAME_SITE = 'Lax';
const SESSION_REFRESH_WINDOW_MS = Math.min(
  12 * 60 * 60 * 1000,
  Math.max(60 * 1000, Math.floor(SESSION_EXPIRY / 2)),
);

function normalizeAuthSession(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    ...session,
    role: session.role || 'owner',
  };
}

function loadAuth() {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to load auth.json:', err.message);
    process.exit(1);
  }
}

export const auth = loadAuth();

export function loadAuthSessions() {
  try {
    if (!existsSync(AUTH_SESSIONS_FILE)) {
      return new Map();
    }
    const data = JSON.parse(readFileSync(AUTH_SESSIONS_FILE, 'utf8'));
    const map = new Map();
    const now = Date.now();
    let migrated = false;
    for (const [token, session] of Object.entries(data)) {
      if (session.expiry > now) {
        const normalized = normalizeAuthSession(session);
        if (normalized && normalized.role !== session.role) migrated = true;
        if (normalized) map.set(token, normalized);
      }
    }
    if (migrated) {
      writeFileSync(AUTH_SESSIONS_FILE, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
    }
    return map;
  } catch (err) {
    console.error('Failed to load auth-sessions.json:', err.message);
    return new Map();
  }
}

export function saveAuthSessions() {
  try {
    const configDir = dirname(AUTH_SESSIONS_FILE);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    const data = Object.fromEntries(sessions);
    writeFileSync(AUTH_SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save auth-sessions.json:', err.message);
  }
}

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

export const sessions = loadAuthSessions();

export function verifyToken(inputToken) {
  if (!inputToken || typeof inputToken !== 'string') return false;
  // Re-read auth.json every time so generate-token takes effect without restart
  let currentAuth;
  try {
    currentAuth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return false;
  }
  const storedBuf = Buffer.from(currentAuth.token, 'hex');
  const inputBuf = Buffer.from(inputToken, 'hex');
  if (storedBuf.length !== inputBuf.length) return false;
  return timingSafeEqual(storedBuf, inputBuf);
}

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

export function hashPassword(password) {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = scryptSync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function hashPasswordAsync(password) {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = await scryptAsync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(username, password) {
  if (!username || !password) return false;
  let currentAuth;
  try {
    currentAuth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
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
    const inputHash = scryptSync(password, salt, 32, { N: parseInt(N), r: parseInt(r), p: parseInt(p) });
    return timingSafeEqual(storedHash, inputHash);
  } catch {
    return false;
  }
}

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

export function isAuthenticated(req) {
  return !!getValidSession(getSessionToken(req))
    || !!getValidSession(getVisitorSessionToken(req));
}

/**
 * Get the auth session data for a request (role, appId, visitorId, etc.).
 * Checks the owner cookie first, then the visitor cookie as fallback.
 * Returns null if not authenticated.
 */
export function getAuthSession(req) {
  const ownerSession = getValidSession(getSessionToken(req));
  if (ownerSession) return normalizeAuthSession(ownerSession);
  const visitorSession = getValidSession(getVisitorSessionToken(req));
  if (visitorSession) return normalizeAuthSession(visitorSession);
  return null;
}

export async function refreshAuthSession(req, { force = false } = {}) {
  // Try owner cookie first, then visitor cookie
  let token = getSessionToken(req);
  let session = getValidSession(token);
  let cookieFn = setCookie;
  if (!token || !session) {
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
