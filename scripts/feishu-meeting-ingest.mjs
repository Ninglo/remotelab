#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { artifactToken } from '../connectors/feishu/meeting-materials.mjs';

// Operator commands use a private durable mailbox. Only the existing Connector
// consumes jobs; this CLI never starts another worker or reads app credentials.
const args = process.argv.slice(2);
const [action] = args;
const value = flag => { const i = args.indexOf(flag); return i < 0 ? '' : args[i + 1] || ''; };
if (!['status', 'retry'].includes(action) || !value('--storage-dir')) {
  console.log('Usage: node scripts/feishu-meeting-ingest.mjs status|retry --storage-dir <connector-state> [--meeting-id <id>] [--minute-url <url>] [--note-url <url>] [--source-ref <ref>]');
  process.exitCode = action === '--help' ? 0 : 1;
} else {
  try {
    const root = join(value('--storage-dir'), 'meeting-ingest');
    const meetingId = value('--meeting-id');
    if (meetingId && !/^\d{10,30}$/.test(meetingId)) throw new Error('Invalid meeting ID');
    if (action === 'status') {
      const records = new Map();
      for (const area of ['archive', 'active']) {
        let files = []; try { files = await readdir(join(root, 'jobs', area)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        for (const file of files.filter(f => /^[a-f0-9]{24}\.json$/.test(f))) {
          const r = await readRecord(join(root, 'jobs', area, file));
          if (!meetingId || r.meetingId === meetingId) records.set(r.meetingId, r);
        }
      }
      const policy = await readRecord(join(value('--storage-dir'), 'meeting-ingest-policy.json'));
      console.log(JSON.stringify({ enabled: policy?.enabled === true, chatId: policy?.chatId, notBefore: policy?.notBefore,
        scopeMode: policy?.scope?.mode || 'unconfigured', processingMode: policy?.processingMode || 'analyze',
        jobs: [...records.values()].map(r => ({ meetingId: r.meetingId, status: r.status, complete: r.complete,
          attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, messageId: r.messageId, threadId: r.threadId,
          analysis: r.analysis, archive: r.archive, failure: r.failure, sourcePath: r.material?.sourcePath, receipt: r.receipt })) }, null, 2));
    } else {
      if (!meetingId) throw new Error('--meeting-id is required');
      const hints = {};
      for (const [flag, field, kind] of [['--minute-url', 'minuteUrl', 'minutes'], ['--note-url', 'noteUrl', 'docx']]) {
        const url = value(flag);
        if (url && !artifactToken(url, kind)) throw new Error(`Invalid ${flag}`);
        if (url) hints[field] = url;
      }
      if (Object.keys(hints).length && !value('--source-ref')) throw new Error('--source-ref is required for supplied material links');
      if (value('--source-ref')) hints.sourceRefs = [value('--source-ref')];
      const key = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 24);
      await mkdir(join(root, 'commands'), { recursive: true, mode: 0o700 });
      await writeDurableJson(join(root, 'commands', key + '.json'), { action, meetingId, hints, requestedAt: new Date().toISOString() });
      console.log(JSON.stringify({ queued: true, commandId: key, receiptPath: join(root, 'command-receipts', key + '.json'),
        boundary: 'Queued for the existing Connector; this is not a delivery receipt. Delivery-unknown retries only read back.' }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
