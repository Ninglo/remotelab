import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeishuMeetingObserver } from '../connectors/feishu/meeting-observer.mjs';
const root = await mkdtemp(join(tmpdir(), 'meeting-retention-'));
const base = join(root, 'meeting-observer');
const runtime = { config: { appId: 'app', storageDir: root } };
let receipts = 0, fail = true;
const read = [], now = Date.parse('2026-10-31T12:00:00Z');
const options = { now: () => now, onRead: id => read.push(id), onEnded: async () => {
  if (fail) throw new Error('interrupted before durable handoff'); receipts++;
}, request: async () => { throw new Error('no historical attendance'); } };
try {
  await mkdir(base);
  await writeFile(join(root, 'meeting-observer-policy.json'), JSON.stringify({ enabled: true, appId: 'app', tenantKey: 'tenant', targets: [] }));
  const id = '123456789012';
  await writeFile(join(base, id + '.json'), JSON.stringify({ meetingId: id, appId: 'app', tenantKey: 'tenant', endedAt: '1793448000', transcript: [{ text: 'preserve permanently' }] }));
  const migration = createFeishuMeetingObserver(runtime, options);
  await assert.rejects(migration.restore(), /Migrate legacy/);
  await assert.rejects(migration.migrate(), /interrupted before durable/);
  await assert.rejects(migration.restore(), /Migrate legacy/, 'partial migration is never accepted');
  fail = false;
  assert.deepEqual(await migration.migrate(), { migrated: true, historical: 1, active: 0 });
  assert.equal(receipts, 1);
  assert.deepEqual(await migration.migrate(), { migrated: false });
  assert.deepEqual(JSON.parse(await readFile(join(base, id + '.json'))).transcript, [{ text: 'preserve permanently' }]);
  for (let i = 0; i < 1024; i++) {
    const f = await open(join(base, `${200000000000 + i}.json`), 'w');
    await f.truncate(1024 * 1024); await f.close();
  }
  // Crash after admission but before its marker is removed: recovery reads just
  // the one pending state and does not repeat the completed durable handoff.
  await writeFile(join(base, 'active', id + '.json'), ''); read.length = 0;
  const restarted = createFeishuMeetingObserver(runtime, options);
  await restarted.restore(); await restarted.idle(); restarted.stop();
  assert.deepEqual(read, [id]); assert.equal(receipts, 1);
  assert.deepEqual(await readdir(join(base, 'active')), []);
  read.length = 0;
  const settled = createFeishuMeetingObserver(runtime, options);
  await settled.restore(); await settled.idle(); settled.stop();
  assert.deepEqual(read, [], 'startup does not read any permanent history');
  assert.equal((await readdir(base)).filter(x => /^\d+\.json$/.test(x)).length, 1025);
  console.log(JSON.stringify({ permanentHistoryFiles: 1025, historicalBytes: 1024 ** 3, startupHistoryReads: 0, interruptedHandoffRecovered: true, receipts, heapUsed: process.memoryUsage().heapUsed }));
} finally { await rm(root, { recursive: true, force: true }); }
