import { randomBytes } from 'crypto';
import { dirname } from 'path';

import { TEAM_SESSION_VIEW_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  readJson,
  writeJsonAtomic,
} from './fs-utils.mjs';

const runTeamSessionViewMutation = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAccountName(value) {
  return trimString(value).replace(/\s+/g, ' ');
}

function normalizeUsername(value) {
  return trimString(value);
}

function normalizeAccount(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = trimString(record.id);
  const username = normalizeUsername(record.username);
  const passwordHash = trimString(record.passwordHash);
  if (!id || !username || !passwordHash) return null;
  return {
    id,
    username,
    name: normalizeAccountName(record.name) || username,
    passwordHash,
    enabled: record.enabled !== false,
    createdAt: trimString(record.createdAt) || new Date().toISOString(),
    updatedAt: trimString(record.updatedAt),
  };
}

function normalizeTeamSessionView(rawValue = {}) {
  const value = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
    ? rawValue
    : {};
  const accounts = Array.isArray(value.accounts)
    ? value.accounts.map(normalizeAccount).filter(Boolean)
    : [];
  const seenIds = new Set();
  const seenUsernames = new Set();
  return {
    version: 1,
    enabled: value.enabled === true,
    accounts: accounts.filter((account) => {
      const usernameKey = account.username.toLowerCase();
      if (seenIds.has(account.id) || seenUsernames.has(usernameKey)) return false;
      seenIds.add(account.id);
      seenUsernames.add(usernameKey);
      return true;
    }),
    updatedAt: trimString(value.updatedAt),
  };
}

function createClientAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    enabled: account.enabled !== false,
    createdAt: account.createdAt || '',
    updatedAt: account.updatedAt || '',
  };
}

function createAccountId() {
  return `user_${randomBytes(12).toString('hex')}`;
}

async function loadStoredTeamSessionView() {
  return normalizeTeamSessionView(await readJson(TEAM_SESSION_VIEW_FILE, {}));
}

async function saveStoredTeamSessionView(value) {
  const normalized = normalizeTeamSessionView(value);
  await ensureDir(dirname(TEAM_SESSION_VIEW_FILE));
  await writeJsonAtomic(TEAM_SESSION_VIEW_FILE, normalized);
  return normalized;
}

function accountUsernameExists(accounts, username, { excludeId = '' } = {}) {
  const normalized = normalizeUsername(username).toLowerCase();
  return accounts.some((account) => (
    account.id !== excludeId
    && account.username.toLowerCase() === normalized
  ));
}

function validateAccountInput({ username, name, passwordHash }) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedName = normalizeAccountName(name) || normalizedUsername;
  const normalizedPasswordHash = trimString(passwordHash);
  if (!normalizedUsername) throw new Error('username is required');
  if (!normalizedPasswordHash) throw new Error('password is required');
  return {
    username: normalizedUsername,
    name: normalizedName,
    passwordHash: normalizedPasswordHash,
  };
}

export function isTeamSessionViewMember(authSession) {
  return authSession?.role === 'owner'
    && trimString(authSession?.accountKind) === 'member'
    && !!trimString(authSession?.accountId);
}

export function isTeamSessionViewAdmin(authSession) {
  return authSession?.role === 'owner' && !isTeamSessionViewMember(authSession);
}

export function getAuthSessionViewAccount(authSession, { ownerName = 'Owner' } = {}) {
  if (isTeamSessionViewMember(authSession)) {
    return {
      id: trimString(authSession.accountId),
      name: normalizeAccountName(authSession.accountName) || trimString(authSession.accountId),
      username: normalizeUsername(authSession.accountUsername),
      kind: 'member',
    };
  }
  return {
    id: 'owner',
    name: normalizeAccountName(authSession?.accountName) || normalizeAccountName(ownerName) || 'Owner',
    username: normalizeUsername(authSession?.accountUsername),
    kind: 'admin',
  };
}

export async function loadTeamSessionView({ includeSecrets = false } = {}) {
  const stored = await loadStoredTeamSessionView();
  return {
    version: stored.version,
    enabled: stored.enabled,
    accounts: stored.accounts.map((account) => (
      includeSecrets ? { ...account } : createClientAccount(account)
    )),
    updatedAt: stored.updatedAt,
  };
}

export async function buildTeamSessionViewBootstrap(authSession, { ownerName = 'Owner' } = {}) {
  const stored = await loadStoredTeamSessionView();
  return {
    enabled: authSession?.role === 'owner' && stored.enabled,
    currentAccount: authSession?.role === 'owner'
      ? getAuthSessionViewAccount(authSession, { ownerName })
      : null,
    canManage: isTeamSessionViewAdmin(authSession),
  };
}

export async function findActiveTeamSessionAccountByUsername(username) {
  const normalized = normalizeUsername(username).toLowerCase();
  if (!normalized) return null;
  const stored = await loadStoredTeamSessionView();
  if (!stored.enabled) return null;
  return stored.accounts.find((account) => (
    account.enabled !== false
    && account.username.toLowerCase() === normalized
  )) || null;
}

export async function setTeamSessionViewEnabled(enabled) {
  return runTeamSessionViewMutation(async () => {
    const stored = await loadStoredTeamSessionView();
    const updated = await saveStoredTeamSessionView({
      ...stored,
      enabled: enabled === true,
      updatedAt: new Date().toISOString(),
    });
    return {
      ...updated,
      accounts: updated.accounts.map(createClientAccount),
    };
  });
}

export async function createTeamSessionAccount(input = {}) {
  const accountInput = validateAccountInput(input);
  return runTeamSessionViewMutation(async () => {
    const stored = await loadStoredTeamSessionView();
    if (accountUsernameExists(stored.accounts, accountInput.username)) {
      throw new Error('username already exists');
    }
    const now = new Date().toISOString();
    const account = {
      id: createAccountId(),
      ...accountInput,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    stored.accounts.push(account);
    await saveStoredTeamSessionView({
      ...stored,
      accounts: stored.accounts,
      updatedAt: now,
    });
    return createClientAccount(account);
  });
}

export async function updateTeamSessionAccount(accountId, updates = {}) {
  const normalizedId = trimString(accountId);
  if (!normalizedId) return null;
  return runTeamSessionViewMutation(async () => {
    const stored = await loadStoredTeamSessionView();
    const index = stored.accounts.findIndex((account) => account.id === normalizedId);
    if (index === -1) return null;
    const current = stored.accounts[index];
    const nextUsername = Object.prototype.hasOwnProperty.call(updates, 'username')
      ? normalizeUsername(updates.username)
      : current.username;
    if (!nextUsername) throw new Error('username is required');
    if (accountUsernameExists(stored.accounts, nextUsername, { excludeId: normalizedId })) {
      throw new Error('username already exists');
    }
    const nextPasswordHash = Object.prototype.hasOwnProperty.call(updates, 'passwordHash')
      ? trimString(updates.passwordHash)
      : current.passwordHash;
    if (!nextPasswordHash) throw new Error('password is required');
    const now = new Date().toISOString();
    const next = {
      ...current,
      username: nextUsername,
      name: Object.prototype.hasOwnProperty.call(updates, 'name')
        ? (normalizeAccountName(updates.name) || nextUsername)
        : current.name,
      passwordHash: nextPasswordHash,
      enabled: Object.prototype.hasOwnProperty.call(updates, 'enabled')
        ? updates.enabled !== false
        : current.enabled,
      updatedAt: now,
    };
    stored.accounts[index] = next;
    await saveStoredTeamSessionView({
      ...stored,
      accounts: stored.accounts,
      updatedAt: now,
    });
    return createClientAccount(next);
  });
}

export async function deleteTeamSessionAccount(accountId) {
  const normalizedId = trimString(accountId);
  if (!normalizedId) return false;
  return runTeamSessionViewMutation(async () => {
    const stored = await loadStoredTeamSessionView();
    const nextAccounts = stored.accounts.filter((account) => account.id !== normalizedId);
    if (nextAccounts.length === stored.accounts.length) return false;
    await saveStoredTeamSessionView({
      ...stored,
      accounts: nextAccounts,
      updatedAt: new Date().toISOString(),
    });
    return true;
  });
}
