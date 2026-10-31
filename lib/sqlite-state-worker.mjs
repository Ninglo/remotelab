import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { getHeapStatistics } from 'node:v8';
import { chmod, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonRecords } from './json-record-stream.mjs';

const databases = new Map();
const statements = new WeakMap();
function prepare(db, sql) {
  if (!statements.has(db)) statements.set(db, new Map());
  const cached = statements.get(db);
  if (!cached.has(sql)) cached.set(sql, db.prepare(sql));
  return cached.get(sql);
}
const exists = path => stat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const encode = value => JSON.stringify(value);
const insertSql = 'INSERT INTO records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value';

async function database(pathname) {
  if (databases.has(pathname)) return databases.get(pathname);
  await mkdir(dirname(pathname), { recursive: true });
  const db = new DatabaseSync(`${pathname}.sqlite`);
  try {
    await chmod(`${pathname}.sqlite`, 0o600);
    db.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records(ordinal INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // Cross-process SQLite writer lock also owns first migration. A crash rolls
    // back the import; a committed import can resume just the backup rename.
    db.exec('BEGIN IMMEDIATE');
    try {
      const imported = prepare(db, "SELECT value FROM metadata WHERE key='legacy'").get();
      const sourceExists = await exists(pathname);
      const backup = `${pathname}.readonly-backup`;
      if (!imported || sourceExists) {
        const source = sourceExists ? pathname : (await exists(backup) ? backup : null);
        const hash = createHash('sha256');
        let count = 0;
        const insert = prepare(db, insertSql);
        const get = prepare(db, 'SELECT value FROM records WHERE key=?');
        if (source) for await (const [key, record] of readJsonRecords(source)) {
          const value = encode(record);
          hash.update(encode([key, record]) + '\n');
          if (!imported) insert.run(key, value);
          // Check a distributed sample without retaining the source map.
          if (count % 1024 === 0 && get.get(key)?.value !== value) throw new Error('Index migration sample mismatch');
          count++;
        }
        const digest = hash.digest('hex');
        if (imported && imported.value !== encode({ count, digest })) throw new Error('Legacy index changed after migration; preserve both copies for reconciliation');
        if (!imported) {
          if (prepare(db, 'SELECT count(*) AS n FROM records').get().n !== count) throw new Error('Index migration count mismatch (duplicate keys)');
          prepare(db, "INSERT INTO metadata(key,value) VALUES('legacy',?)").run(encode({ count, digest }));
        }
        if (sourceExists && await exists(backup)) throw new Error('Legacy backup already exists; refusing to overwrite');
      }
      if (sourceExists) {
        await chmod(pathname, 0o444);
        await rename(pathname, backup);
      }
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    databases.set(pathname, db);
    return db;
  } catch (error) { db.close(); throw error; }
}

async function perform({ pathname, operation, args }) {
  const db = await database(pathname);
  if (operation === 'initialize') {
    for (const fieldSet of args.indexes || []) {
      if (!fieldSet.every(field => /^[a-zA-Z]+$/.test(field))) throw new Error('Invalid index field');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${fieldSet.join('_')} ON records(${fieldSet.map(field => `trim(coalesce(json_extract(value,'$.${field}'),''))`).join(',')})`);
    }
    return { count: prepare(db, 'SELECT count(*) AS n FROM records').get().n, heapLimitBytes: getHeapStatistics().heap_size_limit };
  }
  if (operation === 'get') return JSON.parse(prepare(db, 'SELECT value FROM records WHERE key=?').get(args.key)?.value || 'null');
  if (operation === 'find') return JSON.parse(prepare(db, args.sql).get(...args.params)?.value || 'null');
  if (operation === 'load') return { records: Object.fromEntries(prepare(db, 'SELECT key,value FROM records ORDER BY ordinal').all().map(row => [row.key, JSON.parse(row.value)])) };
  if (operation === 'merge') {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = JSON.parse(prepare(db, 'SELECT value FROM records WHERE key=?').get(args.key)?.value || '{}');
      const next = { ...existing, ...args.value };
      for (const field of args.preserve || []) if (typeof existing?.[field] === 'string' && existing[field].trim()) next[field] = existing[field].trim();
      prepare(db, insertSql).run(args.key, encode(next));
      db.exec('COMMIT'); return next;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  throw new Error(`Unknown SQLite operation: ${operation}`);
}

// FIFO also serializes asynchronous migration with subsequent requests.
let chain = Promise.resolve();
parentPort.on('message', request => {
  chain = chain.then(async () => {
    try { parentPort.postMessage({ id: request.id, result: await perform(request) }); }
    catch (error) { parentPort.postMessage({ id: request.id, error: { name: error.name, message: error.message, code: error.code } }); }
  });
});
