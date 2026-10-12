import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const usageRecordHash = record => createHash('sha256').update(JSON.stringify(record)).digest('hex');
const correctionPath = directory => join(directory, 'corrections.jsonl');

export async function readUsageCorrections(directory) {
  let text;
  try { text = await readFile(correctionPath(directory), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(Boolean).map(line => {
    const value = JSON.parse(line);
    if (value.version !== 1 || !value.runId || !value.sessionId || !/^[a-f0-9]{64}$/.test(value.recordHash)
      || !['exclude', 'restore'].includes(value.action) || !value.reason || !value.evidence) throw new Error('Invalid usage correction');
    return value;
  });
}

// Append an explicit, reversible correction; never edit the source ledger or
// infer invalidity from a large number/cancelled state alone.
export async function recordUsageCorrection({ ledgerDir, record, reason, evidence, action = 'exclude' }) {
  if (!record?.runId || !record.sessionId || !reason || !evidence || !['exclude', 'restore'].includes(action)) throw new Error('Correction requires source identity, reason and evidence');
  const value = { version: 1, runId: record.runId, sessionId: record.sessionId,
    recordHash: usageRecordHash(record), action, reason, evidence, recordedAt: new Date().toISOString() };
  await mkdir(ledgerDir, { recursive: true });
  const previous = (await readUsageCorrections(ledgerDir)).filter(c => c.runId === value.runId && c.recordHash === value.recordHash).at(-1);
  if (previous?.action === action && previous.reason === reason && JSON.stringify(previous.evidence) === JSON.stringify(evidence)) return previous;
  await appendFile(correctionPath(ledgerDir), JSON.stringify(value) + '\n', { mode: 0o600 });
  return value;
}

export function applyUsageCorrections(records, hashes, corrections) {
  const latest = new Map();
  for (const c of corrections) latest.set(`${c.runId}:${c.recordHash}`, c);
  const excluded = [];
  for (const [runId, record] of records) {
    const c = latest.get(`${runId}:${hashes.get(runId)}`);
    if (c?.action === 'exclude' && c.sessionId === record.sessionId) {
      excluded.push({ ...record, correction: c });
      records.delete(runId);
    }
  }
  return excluded;
}
