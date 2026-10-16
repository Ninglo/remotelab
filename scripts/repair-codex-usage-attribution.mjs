import { readRunState } from '../lib/run-state.mjs';
// Targeted, dry-run by default. No provider calls and no source-ledger rewrites.
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CHAT_RUNS_DIR, USAGE_LEDGER_DIR } from '../lib/config.mjs';
import { readLatestCodexSessionMetrics } from '../chat/codex-session-metrics.mjs';
import { recordUsageCorrection, usageRecordHash } from '../chat/usage-ledger-corrections.mjs';

const args = process.argv.slice(2), ids = [], apply = args.includes('--apply');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run' && /^run_[a-zA-Z0-9_-]+$/.test(args[i + 1] || '')) ids.push(args[++i]);
  else if (args[i] !== '--apply') throw new Error('Usage: node scripts/repair-codex-usage-attribution.mjs --run run_ID [--run run_ID] [--apply]');
}
if (!ids.length) throw new Error('Explicit Run IDs are required');
const selected = new Set(ids), records = new Map();
for (const name of (await readdir(USAGE_LEDGER_DIR)).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
  const stream = createReadStream(join(USAGE_LEDGER_DIR, name));
  try { for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    let value; try { value = JSON.parse(line); } catch { continue; }
    if (selected.has(value.runId)) {
      if (!records.has(value.runId)) records.set(value.runId, new Map());
      records.get(value.runId).set(usageRecordHash(value), value);
    }
  } } finally { stream.destroy(); }
}
const reports = [];
for (const id of selected) {
  const versions = [...(records.get(id)?.values() || [])], record = versions.at(-1);
  const run = await readRunState(join(CHAT_RUNS_DIR, id));
  const start = Date.parse(run.startedAt), end = Date.parse(run.completedAt);
  if (!record || record.contextSource !== 'provider_last_token_count' || record.state !== 'cancelled'
      || run.state !== 'cancelled' || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    reports.push({ runId: id, action: 'unchanged', reason: 'Not a verified legacy cancelled-Run record' }); continue;
  }
  const latest = await readLatestCodexSessionMetrics(run.codexThreadId);
  if (!latest?.sessionLogPath) throw new Error(`Cannot verify provider source for ${id}`);
  let windowRecords = 0, before = null, after = null;
  const hash = createHash('sha256'), stream = createReadStream(latest.sessionLogPath);
  stream.on('data', chunk => hash.update(chunk));
  try { for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    let value; try { value = JSON.parse(line); } catch { continue; }
    if (value.type !== 'event_msg' || value.payload?.type !== 'token_count' || !value.payload.info?.total_token_usage) continue;
    const at = Date.parse(value.timestamp); if (!Number.isFinite(at)) continue;
    if (at < start) before = value.timestamp;
    else if (at <= end) windowRecords++;
    else if (!after) after = value.timestamp;
  } } finally { stream.destroy(); }
  const evidence = { providerLog: latest.sessionLogPath, providerLogSha256: hash.digest('hex'),
    startedAt: run.startedAt, completedAt: run.completedAt, windowRecords, nearestBefore: before, nearestAfter: after };
  if (windowRecords) { reports.push({ runId: id, action: 'unchanged', reason: 'Provider usage exists inside the Run window', evidence }); continue; }
  const reason = 'Legacy fallback attributed a thread lifetime total to a cancelled Run with no provider usage record in its window; actual Run usage remains unknown.';
  const eligible = versions.filter(value => value.sessionId === record.sessionId
    && value.contextSource === 'provider_last_token_count' && value.state === 'cancelled');
  if (apply) for (const version of eligible) await recordUsageCorrection({ ledgerDir: USAGE_LEDGER_DIR, record: version, reason, evidence });
  reports.push({ runId: id, action: apply ? 'excluded-unknown' : 'would-exclude-unknown',
    recordHash: usageRecordHash(record), correctedVersionHashes: eligible.map(usageRecordHash), excludedTokens: record.totalTokens, evidence });
}
console.log(JSON.stringify({ applied: apply, reports }, null, 2));
