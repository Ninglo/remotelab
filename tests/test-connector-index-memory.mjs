import assert from 'node:assert/strict';
import { mkdtemp, open, copyFile, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { readJsonRecords } from '../lib/json-record-stream.mjs';
import { initializeConnectorMessageIndex, findConnectorMessageIndexRecord, upsertConnectorMessageIndexRecord } from '../lib/connector-message-index.mjs';

if (!process.execArgv.some(arg => arg === '--max-old-space-size=29')) {
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--max-old-space-size=29', '--max-semi-space-size=1', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { timeout: 900_000 });
  console.log(stdout.trim());
} else {
  const root = await mkdtemp(join(tmpdir(), 'index-memory-'));
  const pathname = join(root, 'index.json');
  const started = performance.now();
  try {
    if (process.argv[2]) { await copyFile(process.argv[2], pathname); await chmod(pathname, 0o600); }
    else {
      const file = await open(pathname, 'w');
      try {
        await file.write('{"records":{');
        for (let i = 0; i < 5000; i++) await file.write(`${i ? ',' : ''}${JSON.stringify('feishu:a:m' + i)}:${JSON.stringify({ connector: 'feishu', accountId: 'a', messageId: 'm' + i, sessionId: 's' + i, padding: 'x'.repeat(2048) })}`);
        await file.write('}}');
      } finally { await file.close(); }
    }
    const bytes = (await stat(pathname)).size;
    const { count, heapLimitBytes: workerHeapLimitBytes } = await initializeConnectorMessageIndex(pathname);
    assert.ok(getHeapStatistics().heap_size_limit <= 64 * 1024 * 1024);
    assert.ok(workerHeapLimitBytes + getHeapStatistics().heap_size_limit <= 64 * 1024 * 1024, 'parent + worker total heap ceilings stay within 64 MiB, including young generation');
    const migratedMs = performance.now() - started;
    let checked = 0, peak = 0;
    let batch = [];
    async function verify(entries) {
      await Promise.all(entries.map(async ([, record]) => {
        assert.deepEqual(await findConnectorMessageIndexRecord(pathname, record), record);
        const updated = await upsertConnectorMessageIndexRecord(pathname, record);
        assert.equal(updated.sessionId, record.sessionId);
        assert.equal((await findConnectorMessageIndexRecord(pathname, record)).sessionId, record.sessionId);
      }));
      checked += entries.length; peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    for await (const entry of readJsonRecords(`${pathname}.readonly-backup`)) {
      batch.push(entry);
      if (batch.length === 64) { await verify(batch); batch = []; }
    }
    if (batch.length) await verify(batch);
    assert.equal(checked, count);
    assert.equal((await stat(`${pathname}.readonly-backup`)).mode & 0o222, 0);
    console.log(JSON.stringify({ count, checked, bytes, workerHeapLimitBytes, migratedMs: Math.round(migratedMs), totalMs: Math.round(performance.now() - started), peakHeapBytes: peak, heapLimitBytes: getHeapStatistics().heap_size_limit }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
