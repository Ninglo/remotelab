import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await fs.mkdtemp('/tmp/session-meta-sharing-');
setIsolatedTestHome(home);
const { CHAT_SESSIONS_FILE: file } = await import('../lib/config.mjs');
const originalRead = fs.readFile;
let reads = 0, blockNext = false, captured, release;
fs.readFile = async function(path, ...args) {
  const value = await originalRead.call(this, path, ...args);
  if (String(path) === file) {
    reads++;
    if (blockNext) {
      blockNext = false;
      await new Promise(resolve => { release = resolve; captured(); });
    }
  }
  return value;
};
syncBuiltinESMExports();
const write = async name => {
  await fs.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(file + '.next', JSON.stringify([{ id: 'a', name, folder: home, systemPrompt: 'large'.repeat(20000) }]));
  await fs.rename(file + '.next', file);
};
try {
  const m = await import('../chat/session-meta-store.mjs');
  await write('initial');
  const snapshots = await Promise.all(Array.from({ length: 32 }, () => m.loadSessionsMeta()));
  assert.equal(reads, 1, 'concurrent cold readers share one file read and normalization');
  assert.ok(snapshots.every(s => s === snapshots[0]));
  const first = await m.loadSessionMetaVersionIndex();
  assert.match(first.get('a'), /^[a-f0-9]{64}$/, 'version comparison retains a digest, not the catalog text');
  assert.equal(await m.loadSessionMetaVersionIndex(), first);
  await write('older');
  blockNext = true;
  const started = new Promise(resolve => { captured = resolve; });
  const older = m.loadSessionsMeta();
  await started;
  await write('newer');
  const newer = await m.loadSessionsMeta();
  release();
  assert.equal((await older)[0].name, 'older', 'in-flight callers retain their consistent snapshot');
  assert.equal((await m.loadSessionsMeta()), newer, 'an older read cannot replace a newer cached snapshot');
  assert.equal(newer[0].name, 'newer');
  assert.notEqual((await m.loadSessionMetaVersionIndex()).get('a'), first.get('a'));
  await write('older-index');
  blockNext = true;
  const indexStarted = new Promise(resolve => { captured = resolve; });
  const olderIndex = m.loadSessionMetaVersionIndex();
  await indexStarted;
  await write('newer-index');
  const newerIndex = await m.loadSessionMetaVersionIndex();
  release();
  assert.notEqual((await olderIndex).get('a'), newerIndex.get('a'));
  assert.equal(await m.loadSessionMetaVersionIndex(), newerIndex, 'an older read cannot poison the current version index');
  await m.mutateSessionMeta('a', draft => { draft.name = 'saved'; return true; });
  assert.equal((await m.loadSessionsMeta())[0].name, 'saved');
  console.log('PASS: shared cold reads, compact version fingerprints, external replacement and stale-read isolation');
} finally {
  release?.(); fs.readFile = originalRead; syncBuiltinESMExports();
  await fs.rm(home, { recursive: true, force: true });
}
