import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = fs.mkdtempSync(join(tmpdir(), 'remotelab-event-cursor-'));
setIsolatedTestHome(home);
let eventReads = 0;
const originalReadFile = fs.promises.readFile;
fs.promises.readFile = async (path, ...args) => {
  if (String(path).includes('/events/')) eventReads++;
  return originalReadFile.call(fs.promises, path, ...args);
};
syncBuiltinESMExports();
try {
  const { CHAT_HISTORY_DIR, CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
  const id = 'cursor-large-history';
  const dir = join(CHAT_HISTORY_DIR, id);
  fs.mkdirSync(join(dir, 'events'), { recursive: true });
  fs.writeFileSync(CHAT_SESSIONS_FILE, JSON.stringify([{ id, created: '2026-01-01T00:00:00Z', name: 'Old conversation' }]));
  fs.writeFileSync(join(dir, 'meta.json'), JSON.stringify({ latestSeq: 10000, size: 10000, counts: {} }));
  for (const seq of [9998, 9999, 10000]) {
    fs.writeFileSync(join(dir, 'events', `${String(seq).padStart(9, '0')}.json`),
      JSON.stringify({ seq, type: 'usage', inputTokens: seq, timestamp: seq }));
  }
  const { getSessionEventsAfter } = await import('../chat/session-manager.mjs');
  const tail = await getSessionEventsAfter(id, 9998);
  assert.deepEqual(tail.map(e => e.seq), [9999, 10000]);
  assert.equal(eventReads, 2, 'reading new events must never open the 9998 cold event files');
  eventReads = 0;
  assert.deepEqual(await getSessionEventsAfter(id, 10000), []);
  assert.equal(eventReads, 0, 'an unchanged session has no history event reads');
  eventReads = 0;
  assert.deepEqual((await getSessionEventsAfter(id, 9997, { limit: 1 })).map(e => e.seq), [9998]);
  assert.equal(eventReads, 1, 'a page enforces its read budget before accessing events');
  console.log('test-session-event-cursor: ok (10000-event history; empty tail reads zero events)');
} finally {
  fs.promises.readFile = originalReadFile;
  syncBuiltinESMExports();
  fs.rmSync(home, { recursive: true, force: true });
}
