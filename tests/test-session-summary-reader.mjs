import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSessionSummaryReader } from '../lib/session-summary-reader.mjs';

const store = new Map(Array.from({ length: 2100 }, (_, n) => [String(n), { id: String(n), name: `Cold ${n}` }]));
const calls = [];
let fail = false;
const reader = createSessionSummaryReader(async path => {
  calls.push(path);
  if (path === '/api/sessions') return { sessions: [...store.values()] };
  if (path.endsWith('?view=refs')) return { sessionRefs: [...store.values()].reverse().map(session => ({ id: session.id,
    summaryEtag: `"${createHash('sha1').update(JSON.stringify({ session })).digest('hex')}"` })) };
  if (fail) { fail = false; throw new Error('temporary API failure'); }
  return { session: store.get(path.split('/')[3].split('?')[0]) };
});
assert.equal((await reader.read()).length, 2100);
const before = calls.length;
const unchanged = await Promise.all(Array.from({ length: 10 }, () => reader.read()));
assert.equal(calls.length, before + 1, 'concurrent readers share one small index request');
assert.equal(unchanged[0][0], store.get('2099'), 'current index ordering and existing summaries are preserved');
store.set('0', { ...store.get('0'), name: 'Reopened', activity: { run: { state: 'running' } } });
const changed = await reader.read();
assert.equal(changed.at(-1).name, 'Reopened');
assert.deepEqual(calls.filter(path => path.includes('?view=summary')), ['/api/sessions/0?view=summary'],
  'one changed conversation fetches one summary, never the 2099 cold summaries');
store.delete('1'); store.set('new', { id: 'new', name: 'New conversation' });
const updated = await reader.read();
assert.equal(updated.length, 2100); assert.equal(updated[0].id, 'new'); assert.ok(!updated.some(s => s.id === '1'));
store.set('0', { ...store.get('0'), name: 'Retry preserved' }); fail = true;
await assert.rejects(reader.read(), /temporary API failure/);
assert.equal((await reader.read()).at(-1).name, 'Retry preserved', 'failed reads do not advance the cached version');
assert.equal(calls.filter(path => path === '/api/sessions').length, 1, 'full catalog is loaded once at bootstrap');
console.log('test-session-summary-reader: ok (2100 conversations; cold summaries reused, changed IDs only, atomic retry)');
