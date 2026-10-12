import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUsageEventStore, normalizeUsageEvent } from '../chat/usage-events.mjs';
import { createContextQueryObserver, summarizeContextQueries } from '../chat/context-query-monitoring.mjs';
const directory = await mkdtemp(join(tmpdir(), 'context-query-'));
try {
  const store = createUsageEventStore({ directory });
  const observe = createContextQueryObserver(store);
  const input = { sessionId: 'session_a', runId: 'run_a', kind: 'work', query: 'private query' };
  const value = { related: [], candidates: [{ body: 'private result' }], background: { coverage: [] } };
  assert.equal(await observe(input, async () => value), value);
  await observe(input, async () => ({ candidates: [], background: { sourceCoverage: [{ result: 'partial' }] } }));
  const expected = Object.assign(Error('private error'), { code: 'ENOENT' });
  await assert.rejects(observe(input, async () => { throw expected; }), e => e === expected);
  await observe({ ...input, sessionId: 'session_b' }, async () => value);
  await store.record({ eventId: 'interrupted', event: 'context_query', state: 'started', kind: 'memory', sessionId: 'session_a', attemptId: 'interrupted', timestamp: Date.now() });
  const query = await store.query({ contextOnly: true, sessionId: 'session_a' });
  const report = summarizeContextQueries(query);
  assert.deepEqual(report.summary, { attempts: 4, succeeded: 1, partial: 1, failed: 1, unfinished: 1, repeated: 3 });
  assert.equal(report.records.find(r => r.state === 'succeeded').resultCount, 1);
  assert.equal(report.records.find(r => r.state === 'failed').errorCode, 'ENOENT');
  assert(!JSON.stringify(report).includes('private'));
  assert(report.collectionStartedAt);
  // Restart reader and same-ID replay do not inflate counts.
  const reopened = createUsageEventStore({ directory });
  await reopened.record(query.events);
  assert.equal(summarizeContextQueries(await reopened.query({ contextOnly: true, sessionId: 'session_a' })).summary.attempts, 4);
  const limited = await reopened.query({ contextOnly: true, sessionId: 'session_a', maxScanned: 1 });
  assert(limited.coverage.incomplete);
  assert.equal(normalizeUsageEvent({ ...query.events[0], query: 'private', body: 'private' }).query, undefined);
  assert.equal(normalizeUsageEvent({ ...query.events[0], state: 'invented' }), null);
  const broken = createContextQueryObserver({ record: async () => { throw Error('disk'); } });
  assert.equal(await broken(input, async () => value), value);
  await assert.rejects(broken(input, async () => { throw expected; }), e => e === expected);
  console.log('context lookup monitoring: real results, partial sources, failure, interruption, restart, scope, bounds and privacy passed');
} finally { await rm(directory, { recursive: true, force: true }); }
