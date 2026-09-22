import { createHash, randomBytes } from 'crypto';
import { chmod, readFile } from 'fs/promises';

import { AUTH_FILE } from './config.mjs';
import { createSerialTaskQueue, writeJsonAtomic } from '../chat/fs-utils.mjs';
import {
  buildStablePersonHandle,
  derivePersonHandleBase,
  normalizePersonHandle,
  personHandleMatchesBase,
} from './person-handle.mjs';

export const AUTH_DOCUMENT_VERSION = 2;
export const DEFAULT_PERSON_ID = 'person_default';
export const DEFAULT_WEB_IDENTITY_ID = 'identity_web_default';
export const SYSTEM_PERSON_ID = 'person_system';
export const SYSTEM_IDENTITY_ID = 'identity_system';

const mutateAuthDocument = createSerialTaskQueue();
let cachedAuthDocument = null;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function writeAuthDocument(document) {
  await writeJsonAtomic(AUTH_FILE, document);
  await chmod(AUTH_FILE, 0o600);
}

function stableId(prefix, ...parts) {
  const digest = createHash('sha256')
    .update(parts.map((part) => trimString(part)).join('\u0000'))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

function normalizePreference(value) {
  return value === 'mine' ? 'mine' : 'all';
}

function normalizeIdentity(identity, personId) {
  if (!identity || typeof identity !== 'object') return null;
  const kind = trimString(identity.kind).toLowerCase();
  const realm = trimString(identity.realm);
  const subjectId = trimString(identity.subjectId);
  if (!kind || !subjectId) return null;
  return {
    id: trimString(identity.id) || stableId('identity', kind, realm, subjectId),
    kind,
    realm,
    subjectId,
    displayName: trimString(identity.displayName),
    personId,
    discoveredAt: trimString(identity.discoveredAt),
    updatedAt: trimString(identity.updatedAt),
  };
}

function normalizeCredential(credential, personId) {
  if (!credential || typeof credential !== 'object') return null;
  const type = trimString(credential.type).toLowerCase();
  if (type === 'token') {
    const token = trimString(credential.token);
    if (!token) return null;
    return {
      id: trimString(credential.id) || stableId('credential', personId, type, token),
      type,
      token,
      label: trimString(credential.label) || 'Access token',
      createdAt: trimString(credential.createdAt),
      lastUsedAt: trimString(credential.lastUsedAt),
    };
  }
  if (type === 'password') {
    const username = trimString(credential.username);
    const passwordHash = trimString(credential.passwordHash);
    if (!username || !passwordHash) return null;
    return {
      id: trimString(credential.id) || stableId('credential', personId, type, username),
      type,
      username,
      passwordHash,
      label: trimString(credential.label) || username,
      createdAt: trimString(credential.createdAt),
      lastUsedAt: trimString(credential.lastUsedAt),
    };
  }
  return null;
}

function normalizePerson(person, index = 0) {
  if (!person || typeof person !== 'object') return null;
  const id = trimString(person.id) || (index === 0
    ? DEFAULT_PERSON_ID
    : stableId('person', trimString(person.name) || 'unnamed', String(index)));
  const name = trimString(person.name) || (id === DEFAULT_PERSON_ID ? 'Administrator' : 'Unnamed person');
  const credentials = (Array.isArray(person.credentials) ? person.credentials : [])
    .map((credential) => normalizeCredential(credential, id))
    .filter(Boolean);
  let identities = (Array.isArray(person.identities) ? person.identities : [])
    .map((identity) => normalizeIdentity(identity, id))
    .filter(Boolean);
  const passwordUsername = credentials.find((credential) => credential.type === 'password')?.username || '';
  const explicitHandle = normalizePersonHandle(person.handle);
  const credentialHandle = normalizePersonHandle(passwordUsername);
  const handle = explicitHandle || credentialHandle || buildStablePersonHandle({
    displayName: name,
    seed: id,
  });
  const handleSource = ['auto', 'username', 'custom'].includes(person.handleSource)
    ? person.handleSource
    : (explicitHandle ? 'custom' : (credentialHandle ? 'username' : 'auto'));
  identities = identities.map((identity) => identity.kind === 'web'
    ? { ...identity, subjectId: handle }
    : identity);
  if (!identities.some((identity) => identity.kind === 'web') && (
    id === DEFAULT_PERSON_ID || credentials.length > 0
  )) {
    identities = [{
      id: id === DEFAULT_PERSON_ID ? DEFAULT_WEB_IDENTITY_ID : stableId('identity', 'web', id),
      kind: 'web',
      realm: 'remotelab',
      subjectId: handle,
      displayName: name,
      personId: id,
      discoveredAt: '',
      updatedAt: '',
    }, ...identities];
  }
  return {
    id,
    name,
    handle,
    handleSource,
    credentials,
    identities,
    preferences: {
      defaultSessionPersonFilter: normalizePreference(person?.preferences?.defaultSessionPersonFilter),
    },
    createdAt: trimString(person.createdAt),
    updatedAt: trimString(person.updatedAt),
    discovered: person.discovered === true,
  };
}

function migrateLegacyAuthDocument(value) {
  const token = trimString(value?.token);
  const username = trimString(value?.username);
  const passwordHash = trimString(value?.passwordHash);
  const now = new Date().toISOString();
  const credentials = [];
  if (token) {
    credentials.push({
      id: 'credential_default_token',
      type: 'token',
      token,
      label: 'Primary access token',
      createdAt: now,
    });
  }
  if (username && passwordHash) {
    credentials.push({
      id: 'credential_default_password',
      type: 'password',
      username,
      passwordHash,
      label: username,
      createdAt: now,
    });
  }
  const person = normalizePerson({
    id: DEFAULT_PERSON_ID,
    name: username || 'Administrator',
    credentials,
    createdAt: now,
  });
  return {
    version: AUTH_DOCUMENT_VERSION,
    serviceToken: randomBytes(32).toString('hex'),
    primaryPersonId: person.id,
    people: [person],
    migratedAt: now,
    updatedAt: now,
  };
}

export function normalizeAuthDocument(rawValue = {}) {
  const value = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
    ? rawValue
    : {};
  if (value.version !== AUTH_DOCUMENT_VERSION || !Array.isArray(value.people)) {
    return migrateLegacyAuthDocument(value);
  }
  let people = value.people.map(normalizePerson).filter(Boolean);
  if (people.length === 0) {
    people = [normalizePerson({ id: DEFAULT_PERSON_ID, name: 'Administrator' })];
  }
  const primaryPersonId = trimString(value.primaryPersonId);
  const resolvedPrimaryPersonId = people.some((person) => person.id === primaryPersonId)
    ? primaryPersonId
    : people[0].id;
  return {
    version: AUTH_DOCUMENT_VERSION,
    serviceToken: trimString(value.serviceToken) || randomBytes(32).toString('hex'),
    primaryPersonId: resolvedPrimaryPersonId,
    people,
    migratedAt: trimString(value.migratedAt),
    updatedAt: trimString(value.updatedAt),
  };
}

export async function loadAuthDocument({ persistMigration = true } = {}) {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const normalized = normalizeAuthDocument(raw);
  cachedAuthDocument = normalized;
  if (persistMigration && JSON.stringify(raw) !== JSON.stringify(normalized)) {
    await writeAuthDocument(normalized);
  }
  return clone(normalized);
}

export function getCachedAuthDocument() {
  return clone(cachedAuthDocument);
}

export async function updateAuthDocument(mutator) {
  return mutateAuthDocument(async () => {
    const current = await loadAuthDocument({ persistMigration: true });
    const draft = clone(current);
    const result = await mutator(draft);
    const normalized = normalizeAuthDocument(draft);
    normalized.updatedAt = new Date().toISOString();
    await writeAuthDocument(normalized);
    cachedAuthDocument = normalized;
    return { document: clone(normalized), result };
  });
}

export function findPerson(document, personId) {
  return document?.people?.find((person) => person.id === trimString(personId)) || null;
}

export function findIdentity(document, identityId) {
  for (const person of document?.people || []) {
    const identity = person.identities?.find((entry) => entry.id === trimString(identityId));
    if (identity) return { person, identity };
  }
  return null;
}

export function getWebIdentity(person) {
  return person?.identities?.find((identity) => identity.kind === 'web') || null;
}

async function loadAndPersistAuthFile(authFile) {
  const raw = JSON.parse(await readFile(authFile, 'utf8'));
  const normalized = normalizeAuthDocument(raw);
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
    await writeJsonAtomic(authFile, normalized);
    await chmod(authFile, 0o600);
  }
  return normalized;
}

export async function readServiceToken(authFile = AUTH_FILE) {
  const normalized = await loadAndPersistAuthFile(authFile);
  return normalized.serviceToken;
}

export async function readPrimaryAccessToken(authFile = AUTH_FILE) {
  const normalized = await loadAndPersistAuthFile(authFile);
  const person = findPerson(normalized, normalized.primaryPersonId) || normalized.people[0];
  return person?.credentials?.find((credential) => credential.type === 'token')?.token || '';
}

function normalizedPersonName(value) {
  return trimString(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
}

function findExternalIdentityAutoLinkTarget(document, {
  currentPersonId = '',
  handleBase = '',
  proposedHandle = '',
  displayName = '',
} = {}) {
  const candidates = (document?.people || []).filter((person) => person.id !== currentPersonId);
  const exactHandleMatches = candidates.filter((person) => (
    normalizePersonHandle(person.handle) === normalizePersonHandle(proposedHandle)
  ));
  if (exactHandleMatches.length === 1) return exactHandleMatches[0];

  const webHandleMatches = candidates.filter((person) => (
    normalizePersonHandle(person.handle) === normalizePersonHandle(handleBase)
    || person.credentials?.some((credential) => (
      credential.type === 'password'
      && normalizePersonHandle(credential.username) === normalizePersonHandle(handleBase)
    ))
  ));
  if (webHandleMatches.length === 1) return webHandleMatches[0];

  const readableHandleMatches = candidates.filter((person) => (
    personHandleMatchesBase(person.handle, handleBase)
  ));
  if (readableHandleMatches.length === 1) return readableHandleMatches[0];

  const nameKey = normalizedPersonName(displayName);
  if (!nameKey) return null;
  const nameMatches = candidates.filter((person) => normalizedPersonName(person.name) === nameKey);
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

function addIdentityToPerson(person, identity) {
  const existingIndex = person.identities.findIndex((entry) => entry.id === identity.id);
  if (existingIndex === -1) person.identities.push(identity);
  else person.identities[existingIndex] = identity;
}

function mergeDiscoveredPerson(document, source, target) {
  if (!source || !target || source.id === target.id) return false;
  if (source.discovered !== true || source.credentials.length > 0) return false;
  for (const identity of source.identities) {
    addIdentityToPerson(target, {
      ...identity,
      personId: target.id,
      updatedAt: new Date().toISOString(),
    });
  }
  document.people = document.people.filter((person) => person.id !== source.id);
  return true;
}

export async function resolveOrCreateExternalIdentity({
  kind,
  realm = '',
  subjectId,
  stableSubjectId = '',
  displayName = '',
  englishName = '',
  handleHint = '',
  createIfMissing = true,
} = {}) {
  const normalizedKind = trimString(kind).toLowerCase();
  const normalizedRealm = trimString(realm);
  const normalizedSubjectId = trimString(subjectId);
  const normalizedName = trimString(displayName);
  const normalizedEnglishName = trimString(englishName);
  if (!normalizedKind || !normalizedSubjectId) return null;
  const identityId = stableId('identity', normalizedKind, normalizedRealm, normalizedSubjectId);
  const hasReadableHandleInput = Boolean(trimString(handleHint) || normalizedEnglishName || normalizedName);
  const handleBase = hasReadableHandleInput
    ? derivePersonHandleBase(handleHint, normalizedEnglishName, normalizedName)
    : '';
  const proposedHandle = buildStablePersonHandle({
    displayName: normalizedName || normalizedKind,
    englishName: handleBase || normalizedKind,
    seed: trimString(stableSubjectId) || normalizedSubjectId,
  });
  const mutation = await updateAuthDocument((document) => {
    const existing = findIdentity(document, identityId);
    if (existing) {
      const target = findExternalIdentityAutoLinkTarget(document, {
        currentPersonId: existing.person.id,
        handleBase,
        proposedHandle,
        displayName: normalizedName,
      });
      if (target && mergeDiscoveredPerson(document, existing.person, target)) {
        const movedIdentity = target.identities.find((identity) => identity.id === identityId);
        if (normalizedName && movedIdentity) movedIdentity.displayName = normalizedName;
        return {
          personId: target.id,
          identityId,
          sourcePersonId: existing.person.id,
          targetPersonId: target.id,
          autoLinked: true,
        };
      }
      if (normalizedName && existing.identity.displayName !== normalizedName) {
        existing.identity.displayName = normalizedName;
        existing.identity.updatedAt = new Date().toISOString();
      }
      if (normalizedName && existing.person.discovered === true) {
        existing.person.name = normalizedName;
        if (existing.person.handleSource === 'auto') existing.person.handle = proposedHandle;
        existing.person.updatedAt = new Date().toISOString();
      }
      return { personId: existing.person.id, identityId, autoLinked: false };
    }
    const now = new Date().toISOString();
    const target = findExternalIdentityAutoLinkTarget(document, {
      handleBase,
      proposedHandle,
      displayName: normalizedName,
    });
    const identity = normalizeIdentity({
      id: identityId,
      kind: normalizedKind,
      realm: normalizedRealm,
      subjectId: normalizedSubjectId,
      displayName: normalizedName,
      discoveredAt: now,
    }, target?.id || '');
    if (target) {
      identity.personId = target.id;
      addIdentityToPerson(target, identity);
      target.updatedAt = now;
      return { personId: target.id, identityId, autoLinked: true };
    }
    if (createIfMissing === false) return null;
    const personId = stableId('person', normalizedKind, normalizedRealm, normalizedSubjectId);
    document.people.push(normalizePerson({
      id: personId,
      name: normalizedName || `${normalizedKind} user`,
      handle: proposedHandle,
      handleSource: 'auto',
      discovered: true,
      identities: [{ ...identity, personId }],
      createdAt: now,
    }, document.people.length));
    return { personId, identityId, autoLinked: false };
  });
  return mutation.result;
}

export function buildPeopleDirectory(document) {
  return (document?.people || []).map((person) => ({
    id: person.id,
    name: person.name,
    handle: person.handle,
    discovered: person.discovered === true,
    preferences: clone(person.preferences || {}),
    credentials: (person.credentials || []).map((credential) => ({
      id: credential.id,
      type: credential.type,
      label: credential.label,
      ...(credential.type === 'token' ? { tokenSuffix: credential.token.slice(-4) } : {}),
      ...(credential.type === 'password' ? { username: credential.username } : {}),
      createdAt: credential.createdAt || '',
      lastUsedAt: credential.lastUsedAt || '',
    })),
    identities: (person.identities || []).map((identity) => ({
      id: identity.id,
      kind: identity.kind,
      realm: identity.realm,
      displayName: identity.displayName,
      subjectHint: identity.kind === 'web' ? '' : identity.subjectId.slice(-8),
    })),
  }));
}
