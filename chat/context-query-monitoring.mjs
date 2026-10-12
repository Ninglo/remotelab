import { randomUUID } from 'node:crypto';
import { usageEvents, usageKey } from './usage-events.mjs';

// Observe explicit lookup boundaries, not guessed shell commands or model intent.
// Query text and returned bodies stay in their original Session, not this ledger.
export function createContextQueryObserver(store = usageEvents) {
  return async function observe({ sessionId, runId, requestId, kind, query, actorKind = 'agent' }, lookup) {
    const attemptId = randomUUID(), started = Date.now();
    const base = { event: 'context_query', sessionId, runId, requestId, kind, actorKind, surface: 'runtime',
      attemptId, queryHash: usageKey(`context:${sessionId}:${String(query || '').trim()}`) };
    const emit = async value => { try { await store.record({ ...base, ...value, eventId: `${attemptId}:${value.state}` }); } catch { /* telemetry cannot break retrieval */ } };
    await emit({ state: 'started', timestamp: started });
    try {
      const value = await lookup();
      const coverage = [...(value?.background?.coverage || value?.coverage || []), ...(value?.background?.sourceCoverage || value?.sourceCoverage || [])];
      const unavailableSources = coverage.filter(c => c.result === 'source-unavailable' || ['unavailable', 'missing', 'too-large-or-not-file'].includes(c.status)).length;
      const partial = unavailableSources > 0 || coverage.some(c => String(c.result || '').startsWith('partial') || c.omittedCount > 0 || c.skipped > 0);
      const resultCount = kind === 'work' ? (value?.related?.length || 0) + (value?.candidates?.length || 0) : undefined;
      await emit({ state: partial ? 'partial' : 'succeeded', timestamp: Date.now(), durationMs: Date.now() - started,
        sizeBytes: Buffer.byteLength(JSON.stringify(value) || '', 'utf8'), resultCount, unavailableSources });
      return value;
    } catch (error) {
      await emit({ state: 'failed', timestamp: Date.now(), durationMs: Date.now() - started,
        errorCode: typeof error.code === 'string' ? error.code : error.statusCode ? `http_${error.statusCode}` : 'lookup_error' });
      throw error;
    }
  };
}
export const observeContextQuery = createContextQueryObserver();

export function summarizeContextQueries(value, limit = 100) {
  const attempts = new Map();
  for (const event of value.events || []) {
    if (!event.attemptId) continue;
    const previous = attempts.get(event.attemptId);
    if (!previous || event.state !== 'started') attempts.set(event.attemptId, event);
  }
  const rows = [...attempts.values()].sort((a, b) => b.timestamp - a.timestamp);
  const count = state => rows.filter(row => row.state === state).length;
  const repeats = new Map();
  for (const row of rows) if (row.queryHash) repeats.set(`${row.kind}:${row.queryHash}`, (repeats.get(`${row.kind}:${row.queryHash}`) || 0) + 1);
  return { ...value, events: undefined,
    summary: { attempts: rows.length, succeeded: count('succeeded'), partial: count('partial'), failed: count('failed'),
      unfinished: count('started'), repeated: rows.filter(row => repeats.get(`${row.kind}:${row.queryHash}`) > 1).length },
    records: rows.slice(0, limit), hasMore: rows.length > limit,
    semantics: 'Only explicit work context / work people / memory context lookups since collection began. Returned results are not proof of reading or use; no observations are not proof of missed lookup. Direct file reads and other tools are outside coverage.' };
}
export async function readContextQueries({ sessionId, days = 1 } = {}) {
  return summarizeContextQueries(await usageEvents.query({ sessionId, days, contextOnly: true }));
}
