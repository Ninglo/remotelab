// Synthetic 5x the 2026-11-11 Request archive count (32,994), without disk IO.
// Run under a fixed small V8 heap; the real store must evict bodies during scans.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const root = '/synthetic-record-cache-scale';
const originalStat = fs.promises.stat, originalRead = fs.promises.readFile;
const body = 'x'.repeat(32000);
fs.promises.stat = async function (file, ...args) {
  if (!String(file).startsWith(root)) return originalStat.call(this, file, ...args);
  if (String(file).includes('/active/')) throw Object.assign(Error('absent'), { code: 'ENOENT' });
  return { ino: String(file), mtimeMs: 1, ctimeMs: 1, size: body.length + 200 };
};
fs.promises.readFile = async function (file, ...args) {
  if (!String(file).startsWith(root)) return originalRead.call(this, file, ...args);
  return JSON.stringify({ schema: 1, key: String(file).slice(-29, -5), body });
};
syncBuiltinESMExports();
try {
  const { createRecordStore } = await import('../lib/durable-records.mjs');
  const store = createRecordStore(root, { maxCacheBytes: 32 * 1024 ** 2 });
  for (let i = 0; i < 165000; i++) {
    const key = i.toString(16).padStart(24, '0');
    assert.equal((await store.get(key)).key, key);
    if (i % 10000 === 0) assert.ok(store.cacheStats().estimatedBytes <= 32 * 1024 ** 2);
  }
  assert.equal((await store.get('0'.repeat(24))).body.length, 32000);
  console.log(JSON.stringify({ syntheticRecords: 165000, bodyBytesRead: 165000 * body.length,
    cache: store.cacheStats(), heapUsed: process.memoryUsage().heapUsed }));
} finally {
  fs.promises.stat = originalStat; fs.promises.readFile = originalRead; syncBuiltinESMExports();
}
