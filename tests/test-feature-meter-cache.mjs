import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feature-meter-cache-'));
setIsolatedTestHome(home);
const { runDir } = await import('../chat/runs.mjs');
const { readFeatureMeter } = await import('../chat/feature-observation.mjs');
const runId = 'run_meter_cache_test', file = join(runDir(runId), 'spool.jsonl');
await mkdir(runDir(runId), { recursive: true });
const record = (at, tokens) => JSON.stringify({ ts: new Date(at).toISOString(), json: {
  type: 'remotelab.context_metrics', featureUsage: { threadId: 'synthetic-thread',
    inputTokens: tokens, outputTokens: tokens, cachedInputTokens: 0 },
} }) + '\n';
const original = fs.createReadStream;
let reads = 0;
fs.createReadStream = (path, ...args) => { if (path === file) reads++; return original(path, ...args); };
syncBuiltinESMExports();
try {
  await writeFile(file, record(1000, 10) + record(2000, 20));
  const values = await Promise.all([readFeatureMeter(runId), readFeatureMeter(runId, { firstAtOrAfter: 1000 }),
    readFeatureMeter(runId, { firstAtOrAfter: 1500 }), readFeatureMeter(runId, { firstAtOrAfter: 2500 })]);
  assert.deepEqual(values.map(v => v?.inputTokens ?? null), [20, 10, 20, null]);
  assert.equal(reads, 1, 'phase-boundary reads share one scan');
  values[0].inputTokens = 999;
  assert.equal((await readFeatureMeter(runId)).inputTokens, 20);
  assert.equal(reads, 1, 'unchanged closed spool is not rescanned');
  const partial = record(3000, 30);
  await appendFile(file, partial.slice(0, 20));
  assert.equal(await readFeatureMeter(runId, { firstAtOrAfter: 2500 }), null);
  await appendFile(file, partial.slice(20));
  assert.equal((await readFeatureMeter(runId, { firstAtOrAfter: 2500 })).inputTokens, 30);
  await writeFile(file + '.replacement', record(1000, 11) + record(2000, 21));
  await rename(file + '.replacement', file);
  assert.equal((await readFeatureMeter(runId)).inputTokens, 21, 'atomic replacement invalidates the index');
  await rm(file);
  assert.equal(await readFeatureMeter(runId), null, 'missing source never serves stale meters');
  await writeFile(file, record(4000, 40));
  assert.equal((await readFeatureMeter(runId)).inputTokens, 40);
  console.log('PASS shared meter scan, boundaries, immutable results, append/partial/replace/delete recovery');
} finally {
  fs.createReadStream = original; syncBuiltinESMExports();
  await rm(home, { recursive: true, force: true });
}
