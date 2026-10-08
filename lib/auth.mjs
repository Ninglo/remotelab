import { randomBytes, timingSafeEqual, scrypt } from 'crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
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
  normalizeVoiceShortcutBinding,
  normalizeVoiceShortcutPreference,
} from './auth-config.mjs';
import { buildStablePersonHandle, normalizePersonHandle } from './person-handle.mjs';

const scryptAsync = promisify(scrypt);
const AUTH_COOKIE_NAME = 'session_token';
const AUTH_COOKIE_SAME_SITE = 'Lax';
const SESSION_REFRESH_WINDOW_MS = Math.min(
  12 * 60 * 60 * 1000,
  Math.max(60 * 1000, Math.floor(SESSION_EXPIRY / 2)),
);
let authSessionsWrite = Promise.resolve();
let authSessionsWriteSequence = 0;

async function writeAuthSessionsSnapshot(snapshot) {
  await mkdir(dirname(AUTH_SESSIONS_FILE), { recursive: true });
  const temporaryPath = `${AUTH_SESSIONS_FILE}.${process.pid}.${++authSessionsWriteSequence}.tmp`;
  try {
    await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, AUTH_SESSIONS_FILE);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

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
    let serviceSessionToken = '';
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
      if (normalized.authKind === 'service') {
        const previous = serviceSessionToken ? map.get(serviceSessionToken) : null;
        if (previous && previous.expiry >= normalized.expiry) {
          migrated = true;
          continue;
        }
        if (previous) {
          map.delete(serviceSessionToken);
          migrated = true;
        }
        serviceSessionToken = token;
      }
      map.set(token, normalized);
    }
    if (migrated) {
      try {
        await writeAuthSessionsSnapshot(JSON.stringify(Object.fromEntries(map), null, 2));
      } catch (err) {
        console.error('Failed to save auth-sessions.json:', err.message);
      }
    }
    return map;
  } catch (err) {
    console.error('Failed to load auth-sessions.json:', err.message);
    return new Map();
  }
}

export const sessions = await loadAuthSessions();

export function saveAuthSessionsAsync() {
  const snapshot = JSON.stringify(Object.fromEntries(sessions), null, 2);
  const write = authSessionsWrite.then(() => writeAuthSessionsSnapshot(snapshot));
  authSessionsWrite = write.catch((err) => {
    console.error('Failed to save auth-sessions.json:', err.message);
  });
  return authSessionsWrite;
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
  const normalizedUsername = normalizePersonHandle(username);
  if (!normalizedUsername) return null;
  const document = await loadAuthDocument({ persistMigration: true });
  for (const person of document.people) {
    for (const credential of person.credentials || []) {
      if (credential.type !== 'password'
        || normalizePersonHandle(credential.username) !== normalizedUsername) continue;
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

export function getOrCreateAuthenticatedSessionToken(identity = {}) {
  if (identity.authKind === 'service') {
    for (const [token, session] of sessions) {
      if (session.authKind === 'service' && session.expiry > Date.now()) {
        return { token, created: false };
      }
    }
  }
  const token = generateToken();
  sessions.set(token, createAuthenticatedSession(identity));
  return { token, created: true };
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

export async function createPerson({
  name,
  handle = '',
  credentialType = 'token',
  username = '',
  password = '',
} = {}) {
  const normalizedName = trimString(name);
  if (!normalizedName) throw new Error('name is required');
  const type = credentialType === 'none'
    ? 'none'
    : (credentialType === 'password' ? 'password' : 'token');
  if (type === 'password' && !password) throw new Error('password is required');
  const issuedToken = type === 'token' ? generateToken() : '';
  const passwordHash = type === 'password' ? await hashPasswordAsync(password) : '';
  const personId = `person_${randomBytes(12).toString('hex')}`;
  const credentialId = type === 'none' ? '' : `credential_${randomBytes(12).toString('hex')}`;
  const identityId = type === 'none' ? '' : `identity_${randomBytes(12).toString('hex')}`;
  const requestedHandle = normalizePersonHandle(handle || username) || buildStablePersonHandle({
    displayName: normalizedName,
    seed: personId,
  });
  const now = new Date().toISOString();
  const mutation = await updateAuthDocument((document) => {
    if (document.people.some((person) => (
      normalizePersonHandle(person.handle) === requestedHandle
      && !(person.discovered === true && person.credentials.length === 0)
    ))) throw new Error('person handle already exists');
    if (type === 'password' && document.people.some((person) => person.credentials?.some(
      (credential) => credential.type === 'password'
        && normalizePersonHandle(credential.username) === requestedHandle,
    ))) throw new Error('username already exists');
    const discoveredPerson = document.people.find((person) => (
      person.discovered === true
      && person.credentials.length === 0
      && normalizePersonHandle(person.handle) === requestedHandle
    ));
    if (discoveredPerson) {
      discoveredPerson.name = normalizedName;
      discoveredPerson.discovered = false;
      discoveredPerson.handleSource = type === 'password'
        ? 'username'
        : (trimString(handle) ? 'custom' : discoveredPerson.handleSource);
      if (type !== 'none') {
        discoveredPerson.credentials.push({
          id: credentialId,
          type,
          ...(type === 'token'
            ? { token: issuedToken, label: 'Access token' }
            : { username: requestedHandle, passwordHash, label: requestedHandle }),
          createdAt: now,
        });
      }
      discoveredPerson.updatedAt = now;
      return { personId: discoveredPerson.id, merged: true };
    }
    document.people.push({
      id: personId,
      name: normalizedName,
      handle: requestedHandle,
      handleSource: type === 'password' ? 'username' : (trimString(handle) ? 'custom' : 'auto'),
      credentials: type === 'none' ? [] : [{
        id: credentialId,
        type,
        ...(type === 'token'
          ? { token: issuedToken, label: 'Access token' }
          : { username: requestedHandle, passwordHash, label: requestedHandle }),
        createdAt: now,
      }],
      identities: type === 'none' ? [] : [{
        id: identityId,
        kind: 'web',
        realm: 'remotelab',
        subjectId: requestedHandle,
        displayName: normalizedName,
        discoveredAt: now,
      }],
      preferences: { defaultSessionPersonFilter: 'all' },
      createdAt: now,
    });
    return { personId, merged: false };
  });
  return {
    personId: mutation.result.personId,
    handle: requestedHandle,
    ...(credentialId ? { credentialId } : {}),
    issuedToken,
    merged: mutation.result.merged,
  };
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
    if (patch.handle !== undefined) {
      const handle = normalizePersonHandle(patch.handle);
      if (!handle) throw new Error('person handle is required');
      if (document.people.some((entry) => (
        entry.id !== person.id && normalizePersonHandle(entry.handle) === handle
      ))) throw new Error('person handle already exists');
      person.handle = handle;
      person.handleSource = 'custom';
      for (const credential of person.credentials || []) {
        if (credential.type !== 'password') continue;
        credential.username = handle;
        credential.label = handle;
      }
      const webIdentity = getWebIdentity(person);
      if (webIdentity) webIdentity.subjectId = handle;
    }
    if (patch.defaultSessionPersonFilter !== undefined) {
      person.preferences = {
        ...(person.preferences || {}),
        defaultSessionPersonFilter: patch.defaultSessionPersonFilter === 'mine' ? 'mine' : 'all',
      };
    }
    if (patch.voiceShortcut !== undefined) {
      if (!patch.voiceShortcut || typeof patch.voiceShortcut !== 'object' || Array.isArray(patch.voiceShortcut)) {
        throw new Error('voiceShortcut must be an object');
      }
      if (patch.voiceShortcut.binding !== undefined && patch.voiceShortcut.binding !== ''
        && !normalizeVoiceShortcutBinding(patch.voiceShortcut.binding)) {
        throw new Error('Invalid voice shortcut');
      }
      person.preferences = {
        ...(person.preferences || {}),
        voiceShortcut: normalizeVoiceShortcutPreference({
          ...person.preferences?.voiceShortcut,
          ...patch.voiceShortcut,
        }),
      };
    }
    if (patch.mobileInputMode !== undefined) {
      if (patch.mobileInputMode !== 'text' && patch.mobileInputMode !== 'voice') {
        throw new Error('mobileInputMode must be text or voice');
      }
      person.preferences = { ...(person.preferences || {}), mobileInputMode: patch.mobileInputMode };
    }
    if (patch.feishuProgressMode !== undefined) {
      if (!['messages', 'card'].includes(patch.feishuProgressMode)) {
        throw new Error('feishuProgressMode must be messages or card');
      }
      person.preferences = { ...(person.preferences || {}), feishuProgressMode: patch.feishuProgressMode };
    }
    if (patch.quickLinks !== undefined) {
      if (!Array.isArray(patch.quickLinks) || patch.quickLinks.length > 6) {
        throw new Error('quickLinks must be an array of at most 6 links');
      }
      const quickLinks = patch.quickLinks.map((link) => {
        const label = trimString(link?.label);
        const href = trimString(link?.url);
        if (!label || label.length > 40 || !href || href.length > 2048) {
          throw new Error('Each quick link needs a label (up to 40 characters) and a URL');
        }
        let url;
        try { url = new URL(href); } catch { throw new Error('Invalid quick link URL'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
          throw new Error('Quick links must use HTTP or HTTPS without embedded credentials');
        }
        return { label, url: url.href };
      });
      person.preferences = { ...(person.preferences || {}), quickLinks };
    }
    person.updatedAt = new Date().toISOString();
    return person.id;
  });
  return mutation.result;
}

export async function addPersonCredential(personId, input = {}) {
  const type = input.type === 'password' ? 'password' : 'token';
  const token = type === 'token' ? generateToken() : '';
  const password = trimString(input.password);
  if (type === 'password' && !password) throw new Error('password is required');
  const passwordHash = type === 'password' ? await hashPasswordAsync(password) : '';
  const credentialId = `credential_${randomBytes(12).toString('hex')}`;
  const mutation = await updateAuthDocument((document) => {
    const person = findPerson(document, personId);
    if (!person) return null;
    const username = normalizePersonHandle(input.username || person.handle);
    if (type === 'password' && !username) throw new Error('person handle is required');
    if (type === 'password' && username !== normalizePersonHandle(person.handle)) {
      throw new Error('username must match the person handle');
    }
    if (type === 'password' && document.people.some((entry) => entry.credentials?.some(
      (credential) => credential.type === 'password'
        && normalizePersonHandle(credential.username) === username,
    ))) throw new Error('username already exists');
    person.credentials.push({
      id: credentialId,
      type,
      ...(type === 'token'
        ? { token, label: trimString(input.label) || 'Access token' }
        : { username, passwordHash, label: trimString(input.label) || username }),
      createdAt: new Date().toISOString(),
    });
    person.discovered = false;
    if (type === 'password' && person.handleSource === 'auto') person.handleSource = 'username';
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
    if (!target) return null;
    let identity = null;
    let source = null;
    for (const person of document.people) {
      const index = person.identities.findIndex((entry) => entry.id === identityId);
      if (index === -1) continue;
      if (person.identities[index].kind === 'web' || person.identities[index].kind === 'system') return null;
      [identity] = person.identities.splice(index, 1);
      source = person;
      break;
    }
    if (!identity) return null;
    identity.personId = target.id;
    identity.updatedAt = new Date().toISOString();
    target.identities.push(identity);
    if (source && source.id !== target.id && source.discovered === true
      && source.credentials.length === 0 && source.identities.length === 0) {
      document.people = document.people.filter((person) => person.id !== source.id);
    }
    return {
      identityId: identity.id,
      sourcePersonId: source?.id || '',
      targetPersonId: target.id,
    };
  });
  return mutation.result;
}

export { resolveOrCreateExternalIdentity };
