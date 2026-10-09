import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// One process owns this store. Queues serialize short disk commits, never external work.
export function serialQueue() {
  let pending = Promise.resolve();
  const run = operation => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  run.idle = () => pending;
  return run;
}

export async function readRecord(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeDurableJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

// A durable start receipt outlives the process and prevents re-executing an attempt.
export async function claimOnce(path, value) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.claim`;
  await writeDurableJson(temporary, value);
  try {
    await link(temporary, path);
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally { await rm(temporary, { force: true }); }
}

export function createRecordStore(root) {
  const queue = serialQueue();
  const readCache = new Map();
  const readCached = async file => {
    let version;
    try { version = await stat(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      readCache.delete(file);
      return null;
    }
    const cached = readCache.get(file);
    // Atomic replacement changes the inode; mtime/ctime/size also cover other
    // processes writing the same store. Never serve a time-based stale value.
    if (cached && cached.ino === version.ino && cached.mtimeMs === version.mtimeMs
        && cached.ctimeMs === version.ctimeMs && cached.size === version.size) return cached.record;
    const record = await readRecord(file);
    readCache.set(file, { ino: version.ino, mtimeMs: version.mtimeMs,
      ctimeMs: version.ctimeMs, size: version.size, record });
    if (readCache.size > 4096) readCache.delete(readCache.keys().next().value);
    return record;
  };
  // Parsed JSON contains only structured-cloneable values. Copy objects for
  // callers without serializing and reparsing every unchanged large string.
  const copy = record => record ? structuredClone(record) : record;
  const path = (area, key) => {
    if (!/^[a-f0-9]{24}$/.test(key)) throw new Error('Invalid durable record key');
    return join(root, area, `${key}.json`);
  };
  const validate = record => {
    if (record && record.schema !== 1) throw new Error('Unsupported runtime schema; convert state before starting');
    return record;
  };
  const get = async key => copy(validate(await readCached(path('active', key)) || await readCached(path('archive', key))));
  const active = async () => {
    let entries;
    try { entries = await readdir(join(root, 'active')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = await Promise.all(entries.filter(x => /^[a-f0-9]{24}\.json$/.test(x))
      .map(name => readCached(join(root, 'active', name))));
    const present = new Set(entries.map(name => join(root, 'active', name)));
    for (const file of readCache.keys()) if (file.startsWith(join(root, 'active') + '/') && !present.has(file)) readCache.delete(file);
    return records.filter(Boolean).map(record => copy(validate(record))).sort((a, b) => a.sequence - b.sequence);
  };
  return {
    get, active, idle: queue.idle,
    mutate: (key, update) => queue(async () => {
      const current = await get(key);
      const next = await update(current);
      if (!next || next === current) return current;
      const record = { ...next, schema: 1, key, revision: (current?.revision || 0) + 1 };
      await writeDurableJson(path('active', key), record);
      readCache.delete(path('active', key));
      return record;
    }),
    archive: key => queue(async () => {
      await mkdir(join(root, 'archive'), { recursive: true });
      try { await rename(path('active', key), path('archive', key)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return; }
      await syncDirectory(join(root, 'archive'));
      await syncDirectory(join(root, 'active'));
      readCache.delete(path('active', key));
      readCache.delete(path('archive', key));
    }),
  };
}

export function canonicalJson(value) {
  const stable = input => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]));
    return input;
  };
  return JSON.stringify(stable(value));
}
