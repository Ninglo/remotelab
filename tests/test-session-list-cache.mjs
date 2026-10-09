import assert from 'node:assert/strict';
import { createSessionListCache } from '../chat/session-list-cache.mjs';

let clock = 10000, fullReads = 0;
const singleReads = [];
const store = new Map(Array.from({ length: 2100 }, (_, n) => {
  const s = { id: `s${n}`, sourceId: 'chat', name: `Cold ${n}`, created: new Date(n * 1000).toISOString() };
  return [s.id, s];
}));
store.get('s2099').activity = { run: { state: 'running' } };
const cache = createSessionListCache({ now: () => clock,
  loadAll: async person => { fullReads++; return [...store.values()].map(s => ({ ...s, group: person })); },
  loadOne: async (id, person) => { singleReads.push(id); const s = store.get(id); return s ? { ...s, group: person } : null; },
});
const initial = await cache.read({ personId: 'p' });
assert.equal(JSON.parse(initial.body).sessions.length, 2100);
for (const response of await Promise.all(Array.from({ length: 20 }, () => cache.read({ personId: 'p' })))) {
  assert.equal(response, initial, 'unchanged reads reuse the serialized response and ETag');
}
assert.equal(fullReads, 1);
assert.deepEqual(singleReads, [], 'unchanged cold sessions never trigger a read');
store.set('s0', { ...store.get('s0'), updatedAt: '2026-10-09T00:00:00Z', name: 'Reopened cold conversation' });
cache.invalidate({ type: 'session_invalidated', sessionId: 's0' });
const changed = await cache.read({ personId: 'p' });
assert.equal(JSON.parse(changed.body).sessions[0].name, 'Reopened cold conversation');
assert.deepEqual(singleReads, ['s0'], 'a cold session wakes only when it changes');
assert.equal(fullReads, 1);
clock += 1001;
await cache.read({ personId: 'p' });
assert.deepEqual(singleReads, ['s0', 's2099'], 'only the running session needs time-sensitive refresh');
store.get('s1').archived = true;
cache.invalidate({ type: 'session_invalidated', sessionId: 's1' });
const archived = JSON.parse((await cache.read({ personId: 'p', archived: true })).body);
assert.equal(archived.archivedCount, 1);
assert.deepEqual(archived.sessions.map(s => s.id), ['s1']);
store.delete('s2');
cache.invalidate({ type: 'session_invalidated', sessionId: 's2' });
assert.ok(!JSON.parse((await cache.read({ personId: 'p' })).body).sessions.some(s => s.id === 's2'));
assert.equal(JSON.parse((await cache.read({ personId: 'other' })).body).sessions[0].group, 'other');
const refs = JSON.parse((await cache.read({ personId: 'p', refs: true })).body);
assert.equal(refs.sessions, undefined);
assert.match(refs.sessionRefs[0].summaryEtag, /^"[a-f0-9]+"$/);
cache.invalidate({ type: 'sessions_invalidated' });
await cache.read({ personId: 'p' });
assert.equal(fullReads, 3, 'global changes rediscover membership, separate person views remain isolated');
clock += 300001;
await cache.read({ personId: 'p' });
assert.equal(fullReads, 4, 'missed external hints have a bounded demand-driven recovery');

// A mutation arriving while its record is being read must not get swallowed.
let release, called = 0;
const racing = createSessionListCache({ now: () => 0, loadAll: async () => [{ id: 'r', name: 'initial' }],
  loadOne: async () => { called++; if (called === 1) await new Promise(resolve => { release = resolve; }); return { id: 'r', name: String(called) }; },
});
await racing.read();
racing.invalidate({ type: 'session_invalidated', sessionId: 'r' });
const pending = racing.read();
await new Promise(resolve => setImmediate(resolve));
racing.invalidate({ type: 'session_invalidated', sessionId: 'r' });
release(); await pending; await racing.read();
assert.equal(called, 2);

let versions = new Map([['external', 'v1']]);
let externalReads = 0;
const external = createSessionListCache({ loadVersions: async () => versions,
  loadAll: async () => [{ id: 'external', name: 'initial' }],
  loadOne: async () => { externalReads++; return { id: 'external', name: 'changed by CLI' }; },
});
await external.read();
versions = new Map([['external', 'v2']]);
assert.equal(JSON.parse((await external.read()).body).sessions[0].name, 'changed by CLI');
assert.equal(externalReads, 1, 'external metadata edits refresh just their changed IDs without a WS hint');
console.log('test-session-list-cache: ok (2100 records; unchanged cold records are not reread)');
