import { randomBytes, timingSafeEqual, scrypt } from 'crypto';
import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { promisify } from 'util';

import { AUTH_SESSIONS_FILE, SESSION_EXPIRY, SECURE_COOKIES } from './config.mjs';
import {
  DEFAULT_PERSON_ID,
  DEFAULT_WEB_IDENTITY_ID,
  buildPeopleDirectory,
  findPerson,
  getCachedAuthDocument,
  getWebIdentity,
  loadAuthDocument,
  resolveOrCreateExternalIdentity,
  updateAuthDocument,
} from './auth-config.mjs';

const scryptAsync = promisify(scrypt);
const AUTH_COOKIE_NAME = 'session_token';
const AUTH_COOKIE_SAME_SITE = 'Lax';
const SESSION_REFRESH_WINDOW_MS = Math.min(
  12 * 60 * 60 * 1000,
  Math.max(60 * 1000, Math.floor(SESSION_EXPIRY / 2)),
);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export const auth = await loadAuthDocument({ persistMigration: true });

function resolvePersonSessionFields(personId, credentialId = '', fallbackName = '') {
  const document = getCachedAuthDocument() || auth;
  const person = findPerson(document, personId) || findPerson(document, document?.primaryPersonId) || document?.people?.[0];
  const identity = getWebIdentity(person);
  return {
    personId: person?.id || DEFAULT_PERSON_ID,
    personName: person?.name || trimString(fallbackName) || 'Administrator',
    identityId: identity?.id || DEFAULT_WEB_IDENTITY_ID,
    ...(trimString(credentialId) ? { credentialId: trimString(credentialId) } : {}),
  };
}

function normalizeAuthSession(session) {
  if (!session || typeof session !== 'object') return null;
  const personId = trimString(session.personId);
  // Carry forward only authenticated administrator cookies from the pre-v1
  // single-person schema. All v1 sessions name their Person directly.
  if (!personId && (
    trimString(session.role) !== 'owner'
    || (session.accountKind && session.accountKind !== 'admin')
  )) return null;
  return {
    expiry: session.expiry,
    ...resolvePersonSessionFields(
      personId || auth.primaryPersonId,
      session.credentialId,
      session.personName,
    ),
    ...(trimString(session.preferredLanguage) ? { preferredLanguage: trimString(session.preferredLanguage) } : {}),
    ...(session.authKind === 'service' ? { authKind: 'service' } : {}),
  };
}

export async function loadAuthSessions() {
  try {
    let data;
    try {
      data = JSON.parse(await readFile(AUTH_SESSIONS_FILE, 'utf8'));
    } catch (readError) {
      if (readError?.code === 'ENOENT') return new Map();
      throw readError;
    }
    const map = new Map();
    const now = Date.now();
    let migrated = false;
    for (const [token, session] of Object.entries(data)) {
      if (!(session?.expiry > now)) {
        migrated = true;
        continue;
      }
      const normalized = normalizeAuthSession(session);
      if (!normalized) {
        migrated = true;
        continue;
      }
      if (JSON.stringify(normalized) !== JSON.stringify(session)) migrated = true;
      map.set(token, normalized);
    }
    if (migrated) {
      await writeFile(AUTH_SESSIONS_FILE, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
      await chmod(AUTH_SESSIONS_FILE, 0o600);
    }
    return map;
  } catch (err) {
    console.error('Failed to load auth-sessions.json:', err.message);
    return new Map();
  }
}

export const sessions = await loadAuthSessions();

export async function saveAuthSessionsAsync() {
  try {
    await mkdir(dirname(AUTH_SESSIONS_FILE), { recursive: true });
    await writeFile(AUTH_SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2), 'utf8');
    await chmod(AUTH_SESSIONS_FILE, 0o600);
  } catch (err) {
    console.error('Failed to save auth-sessions.json:', err.message);
  }
}

export const saveAuthSessions = saveAuthSessionsAsync;

function tokensEqual(storedToken, inputToken) {
  if (!storedToken || !inputToken || typeof inputToken !== 'string') return false;
  const stored = Buffer.from(storedToken);
  const input = Buffer.from(inputToken);
  return stored.length === input.length && timingSafeEqual(stored, input);
}

export async function authenticateTokenAsync(inputToken) {
  if (!inputToken || typeof inputToken !== 'string') return null;
  const document = await loadAuthDocument({ persistMigration: true });
  if (tokensEqual(document.serviceToken, inputToken)) {
    return { ...resolvePersonSessionFields(document.primaryPersonId), authKind: 'service' };
  }
  for (const person of document.people) {
    for (const credential of person.credentials || []) {
      if (credential.type !== 'token' || !tokensEqual(credential.token, inputToken)) continue;
      void markCredentialUsed(person.id, credential.id);
      return resolvePersonSessionFields(person.id, credential.id, person.name);
    }
  }
  return null;
}

export async function verifyTokenAsync(inputToken) {
  return !!await authenticateTokenAsync(inputToken);
}

export const verifyToken = verifyTokenAsync;

export function generateToken() {
  return randomBytes(32).toString('hex');
}

export async function hashPasswordAsync(password) {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = await scryptAsync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export const hashPassword = hashPasswordAsync;

async function verifyPasswordHashAsync(password, passwordHash) {
  if (!password || !passwordHash) return false;
  const parts = passwordHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const storedHash = Buffer.from(hashHex, 'hex');
  try {
    const inputHash = await scryptAsync(password, salt, storedHash.length, {
      N: Number.parseInt(N, 10), r: Number.parseInt(r, 10), p: Number.parseInt(p, 10),
    });
    return storedHash.length === inputHash.length && timingSafeEqual(storedHash, inputHash);
  } catch {
    return false;
  }
}

export async function authenticatePasswordIdentityAsync(username, password) {
  if (!username || !password) return null;
  const document = await loadAuthDocument({ persistMigration: true });
  for (const person of document.people) {
    for (const credential of person.credentials || []) {
      if (credential.type !== 'password' || credential.username !== username) continue;
      if (!await verifyPasswordHashAsync(password, credential.passwordHash)) return null;
      void markCredentialUsed(person.id, credential.id);
      return resolvePersonSessionFields(person.id, credential.id, person.name);
    }
  }
  return null;
}

export async function authenticatePasswordAsync(username, password) {
  return !!await authenticatePasswordIdentityAsync(username, password);
}

export const verifyPassword = authenticatePasswordAsync;

async function markCredentialUsed(personId, credentialId) {
  try {
    await updateAuthDocument((document) => {
      const person = findPerson(document, personId);
      const credential = person?.credentials?.find((entry) => entry.id === credentialId);
      if (credential) credential.lastUsedAt = new Date().toISOString();
    });
  } catch {}
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  String(cookieHeader || '').split(';').forEach((cookie) => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) cookies[key] = value;
  });
  return cookies;
}

export function getSessionToken(req) {
  return parseCookies(req.headers.cookie || '')[AUTH_COOKIE_NAME] || null;
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
  return normalizeAuthSession(session);
}

export function isAuthenticated(req) {
  return !!req._bearerAuthSession || !!getValidSession(getSessionToken(req));
}

export function getAuthSession(req) {
  if (req._bearerAuthSession) return normalizeAuthSession(req._bearerAuthSession);
  return getValidSession(getSessionToken(req));
}

function getBearerToken(req) {
  const header = req.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
}

export async function authenticateBearerToken(req) {
  const token = getBearerToken(req);
  if (!token) return false;
  const identity = await authenticateTokenAsync(token);
  if (!identity) return false;
  req._bearerAuthSession = { ...identity, expiry: Date.now() + SESSION_EXPIRY };
  return true;
}

export function createAuthenticatedSession(identity = {}) {
  return {
    expiry: Date.now() + SESSION_EXPIRY,
    ...resolvePersonSessionFields(identity.personId, identity.credentialId, identity.personName),
    ...(identity.authKind === 'service' ? { authKind: 'service' } : {}),
    ...(trimString(identity.preferredLanguage) ? { preferredLanguage: trimString(identity.preferredLanguage) } : {}),
  };
}

export async function refreshAuthSession(req, { force = false } = {}) {
  const token = getSessionToken(req);
  const session = getValidSession(token);
  if (!token || !session) return null;
  if (!force && session.expiry - Date.now() > SESSION_REFRESH_WINDOW_MS) return null;
  sessions.set(token, { ...session, expiry: Date.now() + SESSION_EXPIRY });
  await saveAuthSessionsAsync();
  return setCookie(token);
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

export async function listPeopleForClient() {
  return buildPeopleDirectory(await loadAuthDocument({ persistMigration: true }));
}

export async function createPerson({ name, credentialType = 'token', username = '', password = '' } = {}) {
  const normalizedName = trimString(name);
  if (!normalizedName) throw new Error('name is required');
  const type = credentialType === 'password' ? 'password' : 'token';
  if (type === 'password' && (!trimString(username) || !password)) throw new Error('username and password are required');
  const issuedToken = type === 'token' ? generateToken() : '';
  const passwordHash = type === 'password' ? await hashPasswordAsync(password) : '';
  const personId = `person_${randomBytes(12).toString('hex')}`;
  const credentialId = `credential_${randomBytes(12).toString('hex')}`;
  const identityId = `identity_${randomBytes(12).toString('hex')}`;
  const now = new Date().toISOString();
  await updateAuthDocument((document) => {
    if (type === 'password' && document.people.some((person) => person.credentials?.some(
      (credential) => credential.type === 'password' && credential.username === trimString(username),
    ))) throw new Error('username already exists');
    document.people.push({
      id: personId,
      name: normalizedName,
      credentials: [{
        id: credentialId,
        type,
        ...(type === 'token'
          ? { token: issuedToken, label: 'Access token' }
          : { username: trimString(username), passwordHash, label: trimString(username) }),
        createdAt: now,
      }],
      identities: [{
        id: identityId,
        kind: 'web',
        realm: 'remotelab',
        subjectId: personId,
        displayName: normalizedName,
        discoveredAt: now,
      }],
      preferences: { defaultSessionPersonFilter: 'all' },
      createdAt: now,
    });
  });
  return { personId, credentialId, issuedToken };
}

export async function updatePerson(personId, patch = {}) {
  const mutation = await updateAuthDocument((document) => {
    const person = findPerson(document, personId);
    if (!person) return null;
    const name = trimString(patch.name);
    if (name) {
      person.name = name;
      const webIdentity = getWebIdentity(person);
      if (webIdentity) webIdentity.displayName = name;
    }
    if (patch.defaultSessionPersonFilter !== undefined) {
      person.preferences = {
        ...(person.preferences || {}),
        defaultSessionPersonFilter: patch.defaultSessionPersonFilter === 'mine' ? 'mine' : 'all',
      };
    }
    person.updatedAt = new Date().toISOString();
    return person.id;
  });
  return mutation.result;
}

export async function addPersonCredential(personId, input = {}) {
  const type = input.type === 'password' ? 'password' : 'token';
  const token = type === 'token' ? generateToken() : '';
  const username = trimString(input.username);
  const password = trimString(input.password);
  if (type === 'password' && (!username || !password)) throw new Error('username and password are required');
  const passwordHash = type === 'password' ? await hashPasswordAsync(password) : '';
  const credentialId = `credential_${randomBytes(12).toString('hex')}`;
  const mutation = await updateAuthDocument((document) => {
    const person = findPerson(document, personId);
    if (!person) return null;
    if (type === 'password' && document.people.some((entry) => entry.credentials?.some(
      (credential) => credential.type === 'password' && credential.username === username,
    ))) throw new Error('username already exists');
    person.credentials.push({
      id: credentialId,
      type,
      ...(type === 'token'
        ? { token, label: trimString(input.label) || 'Access token' }
        : { username, passwordHash, label: trimString(input.label) || username }),
      createdAt: new Date().toISOString(),
    });
    return person.id;
  });
  if (!mutation.result) return null;
  return { personId, credentialId, issuedToken: token };
}

export async function removePersonCredential(personId, credentialId) {
  const mutation = await updateAuthDocument((document) => {
    const person = findPerson(document, personId);
    if (!person) return false;
    const before = person.credentials.length;
    person.credentials = person.credentials.filter((credential) => credential.id !== credentialId);
    return person.credentials.length !== before;
  });
  return mutation.result === true;
}

export async function moveIdentityToPerson(identityId, targetPersonId) {
  const mutation = await updateAuthDocument((document) => {
    const target = findPerson(document, targetPersonId);
    if (!target) return false;
    let identity = null;
    let source = null;
    for (const person of document.people) {
      const index = person.identities.findIndex((entry) => entry.id === identityId);
      if (index === -1) continue;
      if (person.identities[index].kind === 'web' || person.identities[index].kind === 'system') return false;
      [identity] = person.identities.splice(index, 1);
      source = person;
      break;
    }
    if (!identity) return false;
    identity.personId = target.id;
    identity.updatedAt = new Date().toISOString();
    target.identities.push(identity);
    if (source && source.id !== target.id && source.discovered === true
      && source.credentials.length === 0 && source.identities.length === 0) {
      document.people = document.people.filter((person) => person.id !== source.id);
    }
    return true;
  });
  return mutation.result === true;
}

export { resolveOrCreateExternalIdentity };
