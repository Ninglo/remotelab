import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { USERS_FILE } from '../lib/config.mjs';
import { BASIC_CHAT_APP_ID } from './apps.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';

const runUsersMutation = createSerialTaskQueue();

function cloneUser(user) {
  return user ? JSON.parse(JSON.stringify(user)) : null;
}

function normalizeUserName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeUserAppIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean))];
}

function normalizeDefaultAppId(value, appIds = []) {
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim();
    if (appIds.includes(normalized)) return normalized;
  }
  return appIds[0] || BASIC_CHAT_APP_ID;
}

function normalizeUserRecord(user) {
  if (!user || typeof user !== 'object') return null;
  const id = typeof user.id === 'string' ? user.id.trim() : '';
  if (!id) return null;
  const appIds = normalizeUserAppIds(user.appIds);
  return {
    ...user,
    id,
    name: normalizeUserName(user.name) || 'New user',
    appIds: appIds.length > 0 ? appIds : [BASIC_CHAT_APP_ID],
    defaultAppId: normalizeDefaultAppId(user.defaultAppId, appIds.length > 0 ? appIds : [BASIC_CHAT_APP_ID]),
    createdAt: typeof user.createdAt === 'string' && user.createdAt.trim()
      ? user.createdAt.trim()
      : new Date().toISOString(),
  };
}

function generateUserId() {
  return `user_${randomBytes(12).toString('hex')}`;
}

async function loadUsers() {
  const users = await readJson(USERS_FILE, []);
  return Array.isArray(users)
    ? users.map((user) => normalizeUserRecord(user)).filter(Boolean)
    : [];
}

async function saveUsers(list) {
  const dir = dirname(USERS_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(USERS_FILE, list);
}

export async function listUsers() {
  const users = await loadUsers();
  return users
    .filter((user) => user && !user.deleted)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
    .map((user) => cloneUser(user));
}

export async function getUser(id) {
  if (!id) return null;
  const users = await loadUsers();
  return cloneUser(users.find((user) => user?.id === id && !user.deleted) || null);
}

export async function createUser(input = {}) {
  const name = normalizeUserName(input.name) || 'New user';
  const appIds = normalizeUserAppIds(input.appIds);
  const normalizedAppIds = appIds.length > 0 ? appIds : [BASIC_CHAT_APP_ID];
  const defaultAppId = normalizeDefaultAppId(input.defaultAppId, normalizedAppIds);
  return runUsersMutation(async () => {
    const user = {
      id: generateUserId(),
      name,
      appIds: normalizedAppIds,
      defaultAppId,
      createdAt: new Date().toISOString(),
    };
    const users = await loadUsers();
    users.push(user);
    await saveUsers(users);
    return cloneUser(user);
  });
}

export async function updateUser(id, updates = {}) {
  if (!id) return null;
  return runUsersMutation(async () => {
    const users = await loadUsers();
    const index = users.findIndex((user) => user?.id === id && !user.deleted);
    if (index === -1) return null;
    const nextName = normalizeUserName(updates.name);
    if (nextName) {
      users[index].name = nextName;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'appIds')) {
      const nextAppIds = normalizeUserAppIds(updates.appIds);
      users[index].appIds = nextAppIds.length > 0 ? nextAppIds : [BASIC_CHAT_APP_ID];
    }
    users[index].defaultAppId = normalizeDefaultAppId(
      updates.defaultAppId === undefined ? users[index].defaultAppId : updates.defaultAppId,
      users[index].appIds,
    );
    users[index].updatedAt = new Date().toISOString();
    await saveUsers(users);
    return cloneUser(users[index]);
  });
}

export async function deleteUser(id) {
  if (!id) return false;
  return runUsersMutation(async () => {
    const users = await loadUsers();
    const index = users.findIndex((user) => user?.id === id && !user.deleted);
    if (index === -1) return false;
    users[index] = {
      ...users[index],
      deleted: true,
      deletedAt: new Date().toISOString(),
    };
    await saveUsers(users);
    return true;
  });
}
