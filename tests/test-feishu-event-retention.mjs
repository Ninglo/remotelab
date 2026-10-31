import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, writeFile, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { appendFeishuEvent, initializeFeishuEventLog, migrateFeishuEventLog, readFeishuEventWindow } from '../lib/feishu-event-log.mjs';
import { createRecordStore } from '../lib/durable-records.mjs';
import { createConnectorInbox } from '../lib/connector-inbox.mjs';

const root = await mkdtemp(join(tmpdir(), 'event-retention-'));
const now = Date.parse('2026-10-31T12:00:00Z'), DAY = 86400_000;
const path = join(root, 'events.jsonl');
const event = (id, at) => ({ receivedAt: new Date(at).toISOString(), allowed: true, summary: { messageId: id, chatId: 'chat' } });
try {
  await writeFile(path, [event('expired', now - 31 * DAY), event('yesterday', now - DAY), event('today', now)].map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(initializeFeishuEventLog(path), /Migrate legacy/);
  assert.deepEqual(await migrateFeishuEventLog(path, now), { migrated: true, retained: 2, expired: 1, unparsed: 0, days: 2 });
  await initializeFeishuEventLog(path);
  assert.deepEqual(await migrateFeishuEventLog(path, now), { migrated: false });
  const opened = [];
  const baseline = performance.now();
  assert.deepEqual((await readFeishuEventWindow(path, { now, onFile: file => opened.push(file) })).map(row => row.summary.messageId), ['yesterday', 'today']);
  const baselineMs = performance.now() - baseline;
  for (let i = 40; i < 48; i++) {
    const file = await open(join(root, `events.${new Date(now - i * DAY).toISOString().slice(0,10)}.jsonl`), 'w');
    await file.truncate(128 * 1024 * 1024); await file.close();
  }
  const hugeHistory = performance.now(), afterOpened = [];
  assert.deepEqual((await readFeishuEventWindow(path, { now, onFile: file => afterOpened.push(file) })).map(row => row.summary.messageId), ['yesterday', 'today']);
  const historicalMs = performance.now() - hugeHistory;
  assert.deepEqual(afterOpened, opened, '1 GiB historical logs cause no additional opens or reads');
  await appendFeishuEvent(path, event('new', now), { now });
  assert.deepEqual((await readdir(root)).sort(), ['events.2026-10-30.legacy.jsonl', 'events.2026-10-31.jsonl', 'events.2026-10-31.legacy.jsonl']);
  assert.deepEqual((await readFeishuEventWindow(path, { now })).map(row => row.summary.messageId), ['yesterday', 'today', 'new']);
  await appendFeishuEvent(path, event('tomorrow', now + DAY), { now: now + DAY });
  assert.deepEqual((await readFeishuEventWindow(path, { now: now + DAY })).map(row => row.summary.messageId), ['today', 'new', 'tomorrow']);
  // Only inbox opts into pruning. Identical old receipt archives stay forever.
  for (const name of ['inbox', 'receipts']) {
    const store = createRecordStore(join(root, name));
    await store.mutate('a'.repeat(24), () => ({ sequence: 1, complete: true })); await store.archive('a'.repeat(24));
    await utimes(join(root, name, 'archive', 'a'.repeat(24) + '.json'), new Date(now - 91 * DAY), new Date(now - 91 * DAY));
  }
  const inbox = createConnectorInbox(join(root, 'inbox'), { archiveRetentionDays: 90, now: () => now,
    conversationKey: record => record.id, process: async () => ({ ok: true }) });
  await inbox.tick(); await inbox.idle();
  assert.equal((await readdir(join(root, 'inbox', 'archive'))).length, 1, 'startup does not prune archives');
  await inbox.accept('new', { summary: { messageId: 'new' } }); await inbox.tick(); await inbox.idle();
  assert.equal((await readdir(join(root, 'inbox', 'archive'))).length, 1, 'runtime completion removes only the expired inbox record');
  assert.equal((await readdir(join(root, 'receipts', 'archive'))).length, 1, 'receipt archives are permanent');
  console.log(JSON.stringify({ historicalBytes: 1024 ** 3, startupOpenedFiles: afterOpened.length,
    baselineMs, historicalMs, heapUsed: process.memoryUsage().heapUsed,
    migration: 'verified', rotation: 'verified', inbox90Days: 'verified', permanentReceipts: 'verified' }));
} finally { await rm(root, { recursive: true, force: true }); }
