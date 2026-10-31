import { constants } from 'fs';
import { randomUUID } from 'crypto';
import { access, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

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
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

// Only the owning module's direct state directory, never a historical tree scan.
// A live/reused PID, unknown liveness, foreign owner or symlink stays untouched.
export async function cleanupAtomicTemps(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const removed = [];
  for (const entry of entries) {
    const match = /\.tmp-([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) continue;
    try { process.kill(pid, 0); continue; }
    catch (error) { if (error.code !== 'ESRCH') continue; }
    const path = join(directory, entry.name);
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) continue;
    await rm(path, { force: true });
    removed.push(path);
  }
  return removed;
}

export async function writeJsonAtomic(path, value, { mode } = {}) {
  await ensureDir(dirname(path));
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
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
