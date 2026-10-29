import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, readdir, unlink, link } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { writeDurableJson, serialQueue } from './durable-records.mjs';

export const CATALOG_SCHEMA = 'session-catalog-v1';
const digest = text => createHash('sha256').update(text).digest('hex');
const version = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

// An OS lock is released even on OOM/SIGKILL. It protects the entire read-modify-
// commit, including offline tools. Linux record catalogs explicitly require flock.
export async function withCatalogLock(file, operation) {
  await mkdir(dirname(file), { recursive: true });
  const child = spawn('flock', ['--exclusive', '--timeout', '30', `${file}.lock`, process.execPath,
    '-e', "process.stdout.write('locked\\n');process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe'] });
  let error = '', acquired = false;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Register rejection handling immediately even if acquisition fails first.
  closed.catch(() => {});
  child.stderr.on('data', data => { error = (error + data).slice(-2000); });
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', data => { output += data; if (output.includes('locked\n')) { acquired = true; resolve(); } });
      child.once('error', reject);
      child.once('close', () => { if (!acquired) reject(new Error(`CATALOG_LOCK_UNAVAILABLE: ${error}`)); });
    });
    return await operation();
  } finally { child.stdin.end(); await closed; }
}

export function createSessionCatalog(file, { normalize = value => value } = {}) {
  const directory = `${file}.records`;
  let cached = null, loading = null;
  const records = new Map(), identities = new WeakMap();
  const queue = serialQueue();
  async function snapshot() {
    let s;
    try { s = await stat(file); } catch (error) { if (error.code === 'ENOENT') return { data: [], version: null }; throw error; }
    const key = version(s);
    if (cached?.version === key) return cached;
    if (loading?.version === key) return loading.promise;
    const task = { version: key }; loading = task;
    task.promise = (async () => {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(data) && (data?.schema !== CATALOG_SCHEMA || !Array.isArray(data.order) || !data.records)) throw new Error('UNSUPPORTED_SESSION_CATALOG');
      const next = { data, version: key };
      if (loading === task) cached = next;
      return next;
    })().finally(() => { if (loading === task) loading = null; });
    return task.promise;
  }
  async function record(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('INVALID_CATALOG_RECORD_HASH');
    if (records.has(hash)) return records.get(hash);
    const pending = (async () => {
      const text = await readFile(join(directory, `${hash}.json`), 'utf8');
      if (digest(text) !== hash) throw new Error('CATALOG_RECORD_HASH_MISMATCH');
      const value = normalize(JSON.parse(text));
      identities.set(value, hash);
      return value;
    })();
    records.set(hash, pending);
    while (records.size > 8192) records.delete(records.keys().next().value);
    try { return await pending; } catch (error) { records.delete(hash); throw error; }
  }
  async function all(s) {
    s ||= await snapshot();
    if (Array.isArray(s.data)) return s.list ||= s.data.map(normalize).filter(Boolean);
    if (s.list) return s.list;
    s.list = (async () => {
      const values = [];
      // Four workers match the default native fs pool; bounded cold allocations.
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < s.data.order.length) {
          const index = next++, id = s.data.order[index];
          values[index] = await record(s.data.records[id]);
          if (values[index]?.id !== id) throw new Error('CATALOG_RECORD_ID_MISMATCH');
        }
      }));
      const live = new Set(Object.values(s.data.records));
      for (const hash of records.keys()) if (!live.has(hash)) records.delete(hash);
      return values;
    })();
    try { return await s.list; } catch (error) { delete s.list; throw error; }
  }
  async function readAll() {
    try { return await all(); } catch (error) {
      // A reader holding an index older than the retention window can retry
      // against the latest committed index after record garbage collection.
      if (error.code !== 'ENOENT') throw error;
      cached = null; return all();
    }
  }
  async function get(id, s) {
    s ||= await snapshot();
    if (Array.isArray(s.data)) return (await all(s)).find(v => v.id === id) || null;
    const hash = Object.hasOwn(s.data.records, id) ? s.data.records[id] : null;
    if (!hash) return null;
    try {
      const value = await record(hash);
      if (value.id !== id) throw new Error('CATALOG_RECORD_ID_MISMATCH');
      return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      cached = null; const fresh = await snapshot();
      if (fresh.version === s.version) throw error;
      return get(id, fresh);
    }
  }
  async function commit(list, previous) {
    const next = { schema: CATALOG_SCHEMA, revision: (previous?.data?.revision || 0) + 1, order: [], records: {} };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const value of list) {
      if (!value?.id || Object.hasOwn(next.records, value.id)) throw new Error('INVALID_OR_DUPLICATE_SESSION_ID');
      let hash = identities.get(value);
      if (!hash || previous?.data?.records?.[value.id] !== hash) {
        const text = JSON.stringify(value); hash = digest(text);
        // Immutable bodies become visible before the single atomic index commit.
        await writeDurableJson(join(directory, `${hash}.json`), value);
        identities.set(value, hash); records.set(hash, Promise.resolve(value));
      }
      next.order.push(value.id); Object.defineProperty(next.records, value.id, { value: hash, enumerable: true, configurable: true });
    }
    await writeDurableJson(file, next);
    cached = null; loading = null;
  }
  async function mutate(operation) {
    return queue(() => withCatalogLock(file, async () => {
      const s = await snapshot();
      if (Array.isArray(s.data)) throw new Error('SESSION_CATALOG_NOT_MIGRATED');
      return operation(s, list => commit(list, s));
    }));
  }
  return { snapshot, readSnapshot: all, all: readAll, get, directory,
    adoptLegacy: async list => { cached = { data: list, list, version: version(await stat(file)) }; loading = null; },
    enabled: async () => (await snapshot()).data?.schema === CATALOG_SCHEMA,
    versions: async () => {
      const s = await snapshot();
      return Array.isArray(s.data) ? null : new Map(s.data.order.map(id => [id, s.data.records[id]]));
    },
    mutateAll: operation => mutate(async (s, save) => operation((await all(s)).slice(), save)),
    mutateOne: (id, operation) => mutate(async (s) => {
      const current = await get(id, s);
      if (!current) return { meta: null, changed: false };
      const draft = { ...current };
      if (operation(draft, current) !== true) return { meta: current, changed: false };
      const text = JSON.stringify(draft), hash = digest(text);
      await writeDurableJson(join(directory, `${hash}.json`), draft);
      const next = { ...s.data, revision: s.data.revision + 1, records: { ...s.data.records, [id]: hash } };
      await writeDurableJson(file, next);
      records.delete(s.data.records[id]); records.set(hash, Promise.resolve(draft)); identities.set(draft, hash);
      cached = null; loading = null;
      return { meta: draft, changed: true };
    }),
    migrate: () => queue(() => withCatalogLock(file, async () => {
      const s = await snapshot();
      if (!Array.isArray(s.data)) return { alreadyMigrated: true, count: s.data.order.length };
      const backup = `${file}.legacy-${randomUUID()}.json`;
      await link(file, backup);
      await commit(s.data, s);
      const result = await readAll();
      if (JSON.stringify(result) !== JSON.stringify(s.data.map(normalize))) throw new Error('CATALOG_MIGRATION_MISMATCH');
      return { count: result.length, backup };
    })),
    exportLegacy: () => queue(() => withCatalogLock(file, async () => {
      const values = await readAll();
      await writeDurableJson(file, values); cached = null; loading = null;
      return { count: values.length };
    })),
    prune: async () => {
      const initial = await snapshot();
      if (Array.isArray(initial.data)) return { removed: 0 };
      const liveAtStart = new Set(Object.values(initial.data.records));
      const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name) && !liveAtStart.has(name.slice(0, -5)));
      let removed = 0;
      // Release the writer queue between short batches; old-body cleanup must
      // not put an entire directory scan on the message admission path.
      for (let offset = 0; offset < names.length; offset += 32) {
        removed += await queue(() => withCatalogLock(file, async () => {
          const s = await snapshot(); if (Array.isArray(s.data)) return 0;
          const live = new Set(Object.values(s.data.records));
          const deleted = await Promise.all(names.slice(offset, offset + 32).map(async name => {
            if (live.has(name.slice(0, -5))) return 0;
            const path = join(directory, name);
            try {
              if (Date.now() - (await stat(path)).mtimeMs <= 86400_000) return 0;
              await unlink(path); records.delete(name.slice(0, -5)); return 1;
            } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
          }));
          return deleted.reduce((sum, count) => sum + count, 0);
        }));
      }
      return { removed };
    },
  };
}

const catalogs = new Map();
export function readSessionCatalog(file) {
  if (!catalogs.has(file)) catalogs.set(file, createSessionCatalog(file));
  return catalogs.get(file).all();
}
