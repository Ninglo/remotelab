import { constants } from 'fs';
import { randomUUID } from 'crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';

export async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(path, value) {
  await ensureDir(dirname(path));
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await rename(tempPath, path);
}

export async function writeTextAtomic(path, value) {
  await ensureDir(dirname(path));
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, value, 'utf8');
  await rename(tempPath, path);
}

export async function removePath(path) {
  await rm(path, { recursive: true, force: true });
}

export function createSerialTaskQueue() {
  let pending = Promise.resolve();
  return async function run(task) {
    const next = pending.catch(() => {}).then(task);
    pending = next;
    try {
      return await next;
    } finally {
      if (pending === next) {
        pending = Promise.resolve();
      }
    }
  };
}

export function createKeyedTaskQueue() {
  const pendingByKey = new Map();
  return async function run(key, task) {
    const previous = pendingByKey.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    pendingByKey.set(key, next);
    try {
      return await next;
    } finally {
      if (pendingByKey.get(key) === next) {
        pendingByKey.delete(key);
      }
    }
  };
}
