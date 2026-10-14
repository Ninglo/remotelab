import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { usageEvents } from './usage-events.mjs';

// This is transport evidence, never an assertion about the model's memory.
export async function observeContextRule(scope, detail, store = usageEvents) {
  if (!scope.sessionId) return;
  try { await store.record({ ...scope, ...detail, event: 'context_rule',
    eventId: detail.eventId || randomUUID(), surface: 'runtime', actorKind: 'system' }); }
  catch { /* Observation failure must not alter native recovery or reception. */ }
}

export async function observeAcceptedRules({ text, id }, receipt, scope, store = usageEvents, configDir = CONFIG_DIR) {
  if (receipt?.accepted !== true || !scope.sessionId) return;
  const match = String(text || '').match(/## Current RemoteLab rules\n([^]*?)Recovery snapshot: ([^\n]+?\.json)\./);
  if (!match) return;
  const file = resolve(match[2]);
  const sessionHash = createHash('sha256').update(JSON.stringify(scope.sessionId)).digest('hex').slice(0, 24);
  if (dirname(file) !== join(configDir, 'rule-context', sessionHash) || !/^[a-f0-9]{64}\.json$/.test(basename(file))) return;
  await observeContextRule({ ...scope, requestId: id }, { state: 'accepted',
    kind: match[1].includes('It is unchanged from the previous accepted input;') ? 'reference'
      : match[1].includes('Only these slots changed:') ? 'delta' : 'full',
    fingerprint: basename(file, '.json'), timestamp: Date.now(),
    eventId: createHash('sha256').update(JSON.stringify([scope.sessionId, scope.runId, id, 'accepted-rules'])).digest('hex'),
  }, store);
}

export function summarizeContextRules(value, limit = 100) {
  const rows = (value.events || []).filter(row => row.event === 'context_rule').sort((a, b) => b.timestamp - a.timestamp);
  const attempts = new Map();
  for (const row of [...rows].reverse()) if (row.attemptId && (!attempts.has(row.attemptId) || row.state !== 'started')) attempts.set(row.attemptId, row);
  return { collectionStartedAt: value.ruleCollectionStartedAt || null,
    summary: { accepted: rows.filter(r => r.state === 'accepted').length,
      compacted: rows.filter(r => r.state === 'compacted').length,
      prepared: rows.filter(r => r.state === 'prepared').length,
      failed: rows.filter(r => r.state === 'failed').length,
      skipped: rows.filter(r => r.state === 'skipped').length,
      unfinished: [...attempts.values()].filter(r => r.state === 'started').length },
    records: rows.slice(0, limit), hasMore: rows.length > limit };
}
