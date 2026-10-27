#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { artifactToken } from '../connectors/feishu/meeting-materials.mjs';
import { unresolvedMeetingScope } from '../connectors/feishu/meeting-scope.mjs';

// Operator commands use a private durable mailbox. Only the existing Connector
// consumes jobs; this CLI never starts another worker or reads app credentials.
const args = process.argv.slice(2);
const [action] = args;
const value = flag => { const i = args.indexOf(flag); return i < 0 ? '' : args[i + 1] || ''; };
if (!['status', 'retry', 'retry-pending'].includes(action) || !value('--storage-dir')) {
  console.log('Usage: node scripts/feishu-meeting-ingest.mjs status|retry|retry-pending --storage-dir <connector-state> [--dry-run] [--meeting-id <id>] [--minute-url <url>] [--note-url <url>] [--source-ref <ref>]');
  process.exitCode = action === '--help' ? 0 : 1;
} else {
  try {
    if (args.includes('--dry-run') && action !== 'retry-pending') throw new Error('--dry-run requires retry-pending');
    const root = join(value('--storage-dir'), 'meeting-ingest');
    const meetingId = value('--meeting-id');
    if (meetingId && !/^\d{10,30}$/.test(meetingId)) throw new Error('Invalid meeting ID');
    if (action === 'status' || action === 'retry-pending') {
      const records = new Map();
      for (const area of ['archive', 'active']) {
        let files = []; try { files = await readdir(join(root, 'jobs', area)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        for (const file of files.filter(f => /^[a-f0-9]{24}\.json$/.test(f))) {
          const r = await readRecord(join(root, 'jobs', area, file));
          if (!meetingId || r.meetingId === meetingId) records.set(r.meetingId, r);
        }
      }
      const policy = await readRecord(join(value('--storage-dir'), 'meeting-ingest-policy.json'));
      if (action === 'retry-pending') {
        if (!policy?.enabled || policy.recovery?.dailyRetry !== true) throw new Error('Daily material recovery is not enabled');
        const queued = [], skipped = [];
        const candidates = new Map();
        const eligible = discovery => {
          const end = /^\d+$/.test(String(discovery?.endedAt))
            ? Number(discovery.endedAt) * 1000 : Date.parse(discovery?.endedAt);
          return discovery?.appId === policy.appId && discovery?.tenantKey === policy.tenantKey
            && end >= Date.parse(policy.notBefore)
            && (!policy.ownerOpenIds?.length || policy.ownerOpenIds.includes(discovery.ownerOpenId));
        };
        for (const record of records.values()) {
          if (!record.complete || !record.receipt?.failed || record.submission || record.messageId
            || !['waiting_material', 'material_deadline_expired', 'permission_denied'].includes(record.status)
            || !eligible(record.discovery)) continue;
          const decision = await readRecord(join(root, 'scope', `${record.meetingId}.json`));
          if (decision?.allowed === false && !unresolvedMeetingScope(decision)) continue;
          candidates.set(record.meetingId, 'daily_material_recovery');
        }
        // Scope lookup failures happen before inbox admission, so there may be
        // no job to retry. Recover metadata from the same observer only; the
        // Connector checks current scope again before any content/ACL work.
        let scopeFiles = [];
        try { scopeFiles = await readdir(join(root, 'scope')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const file of scopeFiles.filter(f => /^\d{10,30}\.json$/.test(f))) {
          const id = file.slice(0, -5);
          if (meetingId && id !== meetingId) continue;
          const decision = await readRecord(join(root, 'scope', file));
          if (decision?.meetingId !== id || decision.appId !== policy.appId || decision.tenantKey !== policy.tenantKey
            || !unresolvedMeetingScope(decision)) continue;
          const record = records.get(id);
          if (record && (!record.complete || !record.receipt?.failed || record.submission || record.messageId)) continue;
          const discovery = await readRecord(join(value('--storage-dir'), 'meeting-observer', file));
          if (discovery?.meetingId !== id || !eligible(discovery)) continue;
          candidates.set(id, 'daily_scope_recovery');
        }
        const dryRun = args.includes('--dry-run');
        for (const [id, source] of candidates) {
          const key = createHash('sha256').update(`daily-retry:${id}:${new Date().toISOString().slice(0, 10)}`).digest('hex').slice(0, 24);
          if (await readRecord(join(root, 'command-receipts', key + '.json'))
            || await readRecord(join(root, 'commands', key + '.json'))) { skipped.push(id); continue; }
          if (!dryRun) await writeDurableJson(join(root, 'commands', key + '.json'), { action: 'retry', meetingId: id,
            requestedAt: new Date().toISOString(), source, hints: {} });
          queued.push({ meetingId: id, source, receiptPath: join(root, 'command-receipts', key + '.json') });
        }
        console.log(JSON.stringify({ ...(dryRun ? { dryRun, candidates: queued } : { queued }), skipped,
          boundary: 'Existing Connector rechecks current scope before recovery; queued is not transcribed.' }, null, 2));
      } else {
      console.log(JSON.stringify({ enabled: policy?.enabled === true, chatId: policy?.chatId, notBefore: policy?.notBefore,
        scopeMode: policy?.scope?.mode || 'unconfigured', processingMode: policy?.processingMode || 'analyze',
        jobs: [...records.values()].map(r => ({ meetingId: r.meetingId, status: r.status, complete: r.complete,
          attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, messageId: r.messageId, threadId: r.threadId,
          analysis: r.analysis, archive: r.archive, intake: r.intake, failure: r.failure, sourcePath: r.material?.sourcePath, receipt: r.receipt })) }, null, 2));
      }
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
