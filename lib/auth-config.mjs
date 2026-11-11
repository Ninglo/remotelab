import { createHash, randomBytes, randomUUID } from 'crypto';
import { chmod, readFile, mkdir } from 'fs/promises';

import { join } from 'node:path';
import { AUTH_FILE, CONFIG_DIR } from './config.mjs';
import { createSerialTaskQueue, writeJsonAtomic } from '../chat/fs-utils.mjs';
import {
  buildStablePersonHandle,
  derivePersonHandleBase,
  normalizePersonHandle,
} from './person-handle.mjs';

export const AUTH_DOCUMENT_VERSION = 2;
export const DEFAULT_PERSON_ID = 'person_default';
export const DEFAULT_WEB_IDENTITY_ID = 'identity_web_default';
export const SYSTEM_PERSON_ID = 'person_system';
export const SYSTEM_IDENTITY_ID = 'identity_system';

const mutateAuthDocument = createSerialTaskQueue();
let cachedAuthDocument = null;
let readSnapshotSource = null, readSnapshot = null;
const administratorChangeCapability = Symbol('reauthenticated-administrator-change');

const administratorIds = document => [...(document.administratorPersonIds || [])].sort();
function administratorSignIn(person) {
  return JSON.stringify({
    credentials: (person?.credentials || []).map(c => [c.id, c.type, c.username || '', c.passwordHash || '', c.token || '', c.identityId || '']).sort(),
    identities: (person?.identities || []).map(i => [i.id, i.kind, i.realm, i.subjectId, [...(i.aliasIds || [])].sort()]).sort(),
  });
}
function assertAdministratorProtection(before, after) {
  const changedSignIn = administratorIds(before).some(id => {
    const previous = findPerson(before, id), next = findPerson(after, id);
    if (administratorSignIn(previous) === administratorSignIn(next)) return false;
    // A fresh single-account installation must be able to set its first sign-in
    // credential. This cannot rotate an existing credential or transfer identity.
    const bootstrap = before.people.length === 1 && id === before.primaryPersonId
      && previous?.credentials.length === 0 && previous.identities.every(i => i.kind === 'web')
      && administratorSignIn({ ...previous, credentials: [] }) === administratorSignIn({ ...next, credentials: [] });
    return !bootstrap;
  });
  if (JSON.stringify(administratorIds(before)) !== JSON.stringify(administratorIds(after)) || changedSignIn) {
    throw Object.assign(new Error('Administrator roles and sign-in identities require the dedicated reauthenticated administrator procedure'),
      { code: 'ADMINISTRATOR_PROCEDURE_REQUIRED', statusCode: 403 });
  }
}

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

export function normalizeVoiceShortcutBinding(value) {
  if (value === 'Alt*3' || value === 'Shift*2' || value === 'Alt+Shift' || value === 'Shift+CapsLock') return value;
  if (typeof value !== 'string' || value.length > 80) return '';
  const parts = value.split('+');
  const code = parts.pop();
  const modifiers = parts.filter((part) => ['Ctrl', 'Alt', 'Shift', 'Meta'].includes(part));
  if (modifiers.length !== parts.length || new Set(modifiers).size !== modifiers.length) return '';
  if (modifiers.join('+') !== ['Ctrl', 'Alt', 'Shift', 'Meta'].filter((part) => modifiers.includes(part)).join('+')) return '';
  if (!/^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Space|Enter|Escape|Tab|Arrow(?:Up|Down|Left|Right)|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(code || '')) return '';
  if (modifiers.length === 0 && !/^F(?:[1-9]|1[0-2])$/.test(code)) return '';
  return value;
}

export function normalizeVoiceShortcutPreference(value) {
  const binding = normalizeVoiceShortcutBinding(value?.binding);
  return { enabled: value?.enabled === true, binding };
}

function normalizeIdentity(identity, personId) {
  if (!identity || typeof identity !== 'object') return null;
  const kind = trimString(identity.kind).toLowerCase();
  const realm = trimString(identity.realm);
  const subjectId = trimString(identity.subjectId);
  if (!kind || !subjectId) return null;
  const id = trimString(identity.id) || stableId('identity', kind, realm, subjectId);
  const aliasIds = [...new Set((Array.isArray(identity.aliasIds) ? identity.aliasIds : [])
    .map(trimString).filter(alias => alias && alias !== id))];
  return {
    id,
    ...(aliasIds.length ? { aliasIds } : {}),
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
  if (type === 'feishu') {
    const identityId = trimString(credential.identityId);
    if (!identityId) return null;
    return {
      id: trimString(credential.id) || stableId('credential', personId, type, identityId),
      type, identityId,
      label: 'Feishu',
      createdAt: trimString(credential.createdAt),
      lastUsedAt: trimString(credential.lastUsedAt),
    };
  }
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
  // Imported identities may have UUIDs instead of the current derived ID.
  // Keep their canonical ID and preserve duplicate IDs for historical actors.
  const bySubject = new Map();
  for (const identity of identities) {
    const key = JSON.stringify([identity.kind, identity.realm, identity.subjectId]);
    const existing = bySubject.get(key);
    if (!existing) bySubject.set(key, identity);
    else {
      const aliases = [...new Set([...(existing.aliasIds || []), identity.id, ...(identity.aliasIds || [])])]
        .filter(alias => alias !== existing.id);
      if (aliases.length) existing.aliasIds = aliases;
      if (!existing.displayName) existing.displayName = identity.displayName;
    }
  }
  identities = [...bySubject.values()];
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
  const preferences = person.preferences && typeof person.preferences === 'object' && !Array.isArray(person.preferences)
    ? person.preferences
    : {};
  return {
    id,
    name,
    handle,
    handleSource,
    credentials,
    identities,
    preferences: {
      ...preferences,
      defaultSessionPersonFilter: normalizePreference(preferences.defaultSessionPersonFilter),
      voiceShortcut: normalizeVoiceShortcutPreference(preferences.voiceShortcut),
      mobileInputMode: preferences.mobileInputMode === 'voice' ? 'voice' : 'text',
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
    administratorPersonIds: [person.id],
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
    administratorPersonIds: [...new Set((Array.isArray(value.administratorPersonIds)
      ? value.administratorPersonIds : [resolvedPrimaryPersonId]).filter(id => people.some(p => p.id === id)))],
    people,
    migratedAt: trimString(value.migratedAt),
    updatedAt: trimString(value.updatedAt),
  };
}

async function readNormalizedAuthDocument() {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { raw, normalized: normalizeAuthDocument(raw) };
}

export async function loadAuthDocument({ persistMigration = true } = {}) {
  const { raw, normalized } = await readNormalizedAuthDocument();
  if (persistMigration && JSON.stringify(raw) !== JSON.stringify(normalized)) {
    return mutateAuthDocument(async () => {
      const latest = await readNormalizedAuthDocument();
      if (JSON.stringify(latest.raw) !== JSON.stringify(latest.normalized)) {
        await writeAuthDocument(latest.normalized);
      }
      cachedAuthDocument = latest.normalized;
      return clone(latest.normalized);
    });
  }
  cachedAuthDocument = normalized;
  return clone(normalized);
}

export function getCachedAuthDocument() {
  return clone(cachedAuthDocument);
}

// Request/ACL readers share one immutable snapshot per committed document.
// Cloning the people/credential directory for every Session check makes list
// and WebSocket work grow quadratically with the directory.
export function getAuthReadSnapshot() {
  if (readSnapshotSource !== cachedAuthDocument) {
    const freeze = value => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    readSnapshot = freeze(clone(cachedAuthDocument));
    readSnapshotSource = cachedAuthDocument;
  }
  return readSnapshot;
}

export async function updateAuthDocument(mutator, { afterSave, administratorCapability } = {}) {
  return mutateAuthDocument(async () => {
    const current = await loadAuthDocument({ persistMigration: false });
    const draft = clone(current);
    const result = await mutator(draft);
    const normalized = normalizeAuthDocument(draft);
    if (administratorCapability !== administratorChangeCapability) assertAdministratorProtection(current, normalized);
    normalized.updatedAt = new Date().toISOString();
    await writeAuthDocument(normalized);
    cachedAuthDocument = normalized;
    if (afterSave) {
      try { await afterSave({ before: current, after: normalized, result }); }
      catch { console.warn('[auth-config] Saved-update observer unavailable; save retained.'); }
    }
    return { document: clone(normalized), result };
  });
}

export function findPerson(document, personId) {
  return document?.people?.find((person) => person.id === trimString(personId)) || null;
}

export function findIdentity(document, identityId) {
  for (const person of document?.people || []) {
    const identity = person.identities?.find((entry) => entry.id === trimString(identityId)
      || entry.aliasIds?.includes(trimString(identityId)));
    if (identity) return { person, identity };
  }
  return null;
}

export function getWebIdentity(person) {
  return person?.identities?.find((identity) => identity.kind === 'web') || null;
}

async function readNormalizedAuthFile(authFile) {
  const raw = JSON.parse(await readFile(authFile, 'utf8'));
  const normalized = normalizeAuthDocument(raw);
  if (raw.version !== AUTH_DOCUMENT_VERSION || !Array.isArray(raw.people) || !trimString(raw.serviceToken)) {
    await writeJsonAtomic(authFile, normalized);
    await chmod(authFile, 0o600);
  }
  return normalized;
}

export async function readServiceToken(authFile = AUTH_FILE) {
  const normalized = await readNormalizedAuthFile(authFile);
  return normalized.serviceToken;
}

export async function readPrimaryAccessToken(authFile = AUTH_FILE) {
  const normalized = await readNormalizedAuthFile(authFile);
  const person = findPerson(normalized, normalized.primaryPersonId) || normalized.people[0];
  return person?.credentials?.find((credential) => credential.type === 'token')?.token || '';
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
    const matches = document.people.flatMap(person => person.identities
      .filter(identity => identity.kind === normalizedKind && identity.realm === normalizedRealm
        && identity.subjectId === normalizedSubjectId)
      .map(identity => ({ person, identity })));
    if (matches.length > 1) throw new Error('External identity is linked to multiple people; reconcile ownership first');
    const existing = matches[0];
    if (existing) {
      const resolvedIdentityId = existing.identity.id;
      if (normalizedName && existing.identity.displayName !== normalizedName) {
        existing.identity.displayName = normalizedName;
        existing.identity.updatedAt = new Date().toISOString();
      }
      if (normalizedName && existing.person.discovered === true) {
        existing.person.name = normalizedName;
        if (existing.person.handleSource === 'auto') existing.person.handle = proposedHandle;
        existing.person.updatedAt = new Date().toISOString();
      }
      return { personId: existing.person.id, identityId: resolvedIdentityId, autoLinked: false };
    }
    const now = new Date().toISOString();
    const identity = normalizeIdentity({
      id: identityId,
      kind: normalizedKind,
      realm: normalizedRealm,
      subjectId: normalizedSubjectId,
      displayName: normalizedName,
      discoveredAt: now,
    }, '');
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

// Browser-only callers must also pass the cookie/origin checks at the HTTP
// boundary. A service token or an asserted actor cannot replace the password.
export async function changeAdministratorMembership(actor, input = {}) {
  const fail = (message, code = 'ADMINISTRATOR_PROCEDURE_REQUIRED', statusCode = 403) => {
    throw Object.assign(new Error(message), { code, statusCode });
  };
  if (!actor?.personId || actor.authKind === 'service') fail('Administrator changes require a personal browser session');
  const document = await loadAuthDocument({ persistMigration: false });
  if (!document.administratorPersonIds.includes(actor.personId)) fail('A current administrator is required');
  const person = findPerson(document, actor.personId), target = findPerson(document, input.targetPersonId);
  if (!target || !target.credentials.length || !getWebIdentity(target)) fail('Choose an existing provisioned account', 'INVALID_ADMINISTRATOR_TARGET', 400);
  if (!['grant', 'revoke'].includes(input.action) || trimString(input.confirmation) !== target.handle) fail('Type the exact target username to confirm', 'INVALID_ADMINISTRATOR_CONFIRMATION', 400);
  const reason = trimString(input.reason);
  if (reason.length < 5 || reason.length > 500) fail('A reason of 5–500 characters is required', 'INVALID_ADMINISTRATOR_REASON', 400);
  const { authenticatePasswordIdentityAsync } = await import('./auth.mjs');
  const verified = await authenticatePasswordIdentityAsync(person.handle, input.password);
  if (verified?.personId !== actor.personId) fail('The current administrator password was not verified', 'INVALID_ADMINISTRATOR_PASSWORD');
  const auditId = randomUUID(), at = new Date().toISOString(), directory = join(CONFIG_DIR, 'administrator-changes');
  const result = await updateAuthDocument(async current => {
    if (!current.administratorPersonIds.includes(actor.personId)) fail('The approving administrator no longer has this role');
    const currentTarget = findPerson(current, target.id);
    if (!currentTarget || currentTarget.handle !== target.handle) fail('Target account changed; reload and review it again');
    const before = [...current.administratorPersonIds];
    const after = input.action === 'grant' ? [...new Set([...before, target.id])] : before.filter(id => id !== target.id);
    if (!after.length) fail('The last administrator cannot be removed', 'LAST_ADMINISTRATOR', 409);
    if (JSON.stringify([...before].sort()) === JSON.stringify([...after].sort())) return { changed: false, before, after };
    // Persist the approved decision before writing the role, so audit failure
    // cannot silently produce an unaudited privilege grant. It is not a claim
    // that the auth write has completed; the applied record follows that write.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(directory, auditId + '.json'), { id: auditId, at, status: 'approved', actorPersonId: actor.personId,
      targetPersonId: target.id, targetHandle: target.handle, action: input.action, reason, before, after, channel: 'reauthenticated-web' }, { mode: 0o600 });
    current.administratorPersonIds = after;
    return { changed: true, before, after };
  }, { administratorCapability: administratorChangeCapability });
  if (result.result.changed) await writeJsonAtomic(join(directory, auditId + '.json'), {
    id: auditId, at, appliedAt: new Date().toISOString(), status: 'applied', actorPersonId: actor.personId,
    targetPersonId: target.id, targetHandle: target.handle, action: input.action, reason,
    before: result.result.before, after: result.result.after, channel: 'reauthenticated-web',
  }, { mode: 0o600 });
  return { changed: result.result.changed, administratorPersonIds: result.document.administratorPersonIds,
    ...(result.result.changed ? { auditId } : {}) };
}
