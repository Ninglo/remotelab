import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'usage-attribution-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_MACHINE_CODEX_HOME = join(home, '.codex');
const { readLatestCodexSessionMetrics } = await import('../chat/codex-session-metrics.mjs');
const { queryUsageLedger } = await import('../chat/usage-ledger.mjs');
const { recordUsageCorrection } = await import('../chat/usage-ledger-corrections.mjs');
try {
  const sessions = join(home, '.codex', 'sessions'); await mkdir(sessions, { recursive: true });
  const thread = '019d6383-beec-7ae2-9b12-264f2fcf075b';
  const count = (timestamp, input) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, output_tokens: 20, total_tokens: input + 20 },
    last_token_usage: { input_tokens: 100 }, model_context_window: 200000,
  } } });
  await writeFile(join(sessions, `rollout-${thread}.jsonl`), [
    count('2026-10-12T01:00:00Z', 1_500_000_000),
    count('2026-10-12T01:10:00Z', 1_500_000_100),
  ].join('\n'));
  assert.equal(await readLatestCodexSessionMetrics(thread, { startedAt: '2026-10-12T01:05:00Z', completedAt: '2026-10-12T01:05:05Z' }), null,
    'cancelled before usage: never bill historical or future lifetime counters');
  const delta = await readLatestCodexSessionMetrics(thread, { startedAt: '2026-10-12T01:05:00Z', completedAt: '2026-10-12T01:11:00Z' });
  assert.equal(delta.inputTokens, 100);
  assert.equal(delta.outputTokens, 0);
  assert.equal((await readLatestCodexSessionMetrics(thread)).contextTokens, 100, 'unbounded context inspection is unchanged');
  assert.equal(await readLatestCodexSessionMetrics(thread, { startedAt: 'invalid' }), null);
  assert.equal(await readLatestCodexSessionMetrics(thread, { completedAt: '2026-10-12T01:05:00Z' }), null);
  assert.equal(await readLatestCodexSessionMetrics(thread, { startedAt: '2026-10-12T01:11:00Z', completedAt: '2026-10-12T01:05:00Z' }), null);
  const ledgerDir = join(home, 'ledger'); await mkdir(ledgerDir);
  const file = join(ledgerDir, '2026-10-12.jsonl');
  const bad = { type: 'run_usage', ts: '2026-10-12T02:00:00Z', runId: 'bad', sessionId: 's', tool: 'codex', model: 'gpt-6-sol', inputTokens: 1_500_000_000, outputTokens: 20, state: 'cancelled' };
  const good = { ...bad, runId: 'good', inputTokens: 200 };
  const raw = [bad, good].map(JSON.stringify).join('\n') + '\n'; await writeFile(file, raw);
  const options = { ledgerDir, startMs: Date.parse('2026-10-12T00:00:00Z'), endMs: Date.parse('2026-10-13T00:00:00Z'), days: 1, top: 10 };
  const correction = { ledgerDir, record: bad, reason: 'No provider usage in the accepted Run window', evidence: { source: 'fixture:bounded-provider-log' } };
  await recordUsageCorrection(correction); await recordUsageCorrection(JSON.parse(JSON.stringify(correction)));
  assert.equal((await readFile(join(ledgerDir, 'corrections.jsonl'), 'utf8')).trim().split('\n').length, 1, 'retries are idempotent');
  const repaired = await queryUsageLedger(options);
  assert.equal(repaired.totals.totalTokens, 220);
  assert.equal(repaired.runCount, 1);
  assert.equal(repaired.quality.excludedRunCount, 1);
  assert.equal(repaired.quality.excludedRuns[0].usageStatus, 'unknown', 'unknown is excluded, not a zero-valued sample');
  assert.equal(repaired.bySession[0].totalTokens, 220);
  assert.equal(repaired.topRuns[0].runId, 'good', 'a legitimate cancelled Run is retained');
  assert.equal((await queryUsageLedger({ ...options, sessionId: 'another' })).quality.excludedRunCount, 0);
  assert.equal(await readFile(file, 'utf8'), raw, 'original ledger remains byte-for-byte intact');
  await recordUsageCorrection({ ...correction, action: 'restore' });
  assert.equal((await queryUsageLedger(options)).runCount, 2, 'correction can be explicitly reversed');
  await recordUsageCorrection(correction);
  await appendFile(file, JSON.stringify({ ...bad, inputTokens: 40, outputTokens: 2 }) + '\n');
  const newer = await queryUsageLedger(options);
  assert.equal(newer.runCount, 2);
  assert.equal(newer.totals.totalTokens, 262, 'new evidence for the same Run is not suppressed by an old correction');
  console.log('PASS: bounded usage never falls back to lifetime totals; audited exclusions preserve source records, legitimate cancellations, filters and later evidence.');
} finally { await rm(home, { recursive: true, force: true }); }
