// Run with node --max-old-space-size=128 to exercise the archive under a small heap.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-search-scale-'));
setIsolatedTestHome(home);
try {
  const { createSessionLogSearch } = await import('../chat/session-log-search.mjs');
  const historyDir = join(home, 'history');
  const indexDir = join(home, 'index');
  await mkdir(indexDir);
  const sessionCount = Number(process.argv[2] ?? 480);
  assert.ok(Number.isSafeInteger(sessionCount) && sessionCount > 9);
  const sessions = [];
  let indexBytes = 0;
  for (let i = 0; i < sessionCount; i++) {
    const id = i.toString(16).padStart(32, '0');
    sessions.push({ id, name: `Session ${i}` });
    const dir = join(historyDir, id);
    await mkdir(dir, { recursive: true });
    const terms = Array.from({ length: 4_000 }, (_, n) => `document${i}term${n}`);
    if (i === 8) terms.push('firstneedle');
    if (i === sessionCount - 1) terms.push('lastneedle');
    const index = JSON.stringify({ version: 3, seq: 1, stamp: '1:fixed', length: terms.length,
      counts: terms.map(term => [term, 1]), postings: terms.map(term => [term, [1]]) });
    indexBytes += Buffer.byteLength(index);
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ latestSeq: 1, lastEventAt: 'fixed' }));
    await writeFile(join(indexDir, `${id}.json`), index);
  }

  const search = createSessionLogSearch({ historyDir, indexDir, list: async () => sessions,
    readCaseConfig: async () => ({}), latestCase: async () => null, sessionHref: id => id });
  const [first, last] = await Promise.all([search('firstneedle'), search('lastneedle')]);
  for (const [result, index] of [[first, 8], [last, sessionCount - 1]]) {
    assert.equal(result.incomplete, false);
    assert.deepEqual(result.sessions.map(row => row.id), [sessions[index].id]);
  }
  assert.deepEqual(await search('lastneedle'), last);
  console.log(JSON.stringify({ sessions: sessions.length, indexBytes, heapUsed: process.memoryUsage().heapUsed }));
} finally {
  await rm(home, { recursive: true, force: true });
}
