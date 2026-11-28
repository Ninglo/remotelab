import assert from 'node:assert/strict';
import { createSessionListCache } from '../chat/session-list-cache.mjs';

let clock = 10000, fullReads = 0;
const singleReads = [];
const store = new Map(Array.from({ length: 7000 }, (_, n) => {
  const s = { id: `s${n}`, sourceId: 'chat', name: `Cold ${n}`, created: new Date(n * 1000).toISOString() };
  return [s.id, s];
}));
store.get('s2099').activity = { run: { state: 'running' } };
const cache = createSessionListCache({ now: () => clock,
  loadAll: async () => { fullReads++; return [...store.values()].map(s => ({ ...s })); },
  loadOne: async id => { singleReads.push(id); const s = store.get(id); return s ? { ...s } : null; },
  project: (s, person) => ({ ...s, group: person }),
});
const initial = await cache.read({ personId: 'p' });
assert.equal(JSON.parse(initial.body).sessions.length, 7000);
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
await Promise.all(Array.from({ length: 8 }, (_, n) => cache.read({ personId: `viewer-${n}`, refs: true })));
assert.equal(fullReads, 1, 'global changes and eight viewer keys reuse the same base');
clock += 600001;
await cache.read({ personId: 'p' });
assert.equal(fullReads, 1, 'ten minutes does not force a cold re-read');
for (const field of ['activity', 'localBridge', 'connectors', 'contextMode', 'deliveryIssueCount']) {
  store.get('s0')[field] = field;
  cache.invalidate({ type: 'session_invalidated', sessionId: 's0' });
  const result = await cache.read({ personId: 'p' });
  assert.equal(JSON.parse(result.body).sessions.find(s => s.id === 's0')[field], field);
}

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

let idleLoads = 0, idleClock = 0;
const idleViews = createSessionListCache({ now: () => idleClock, maxAgeMs: 3_600_000,
  loadAll: async () => { idleLoads++; return [{ id: 'i' }]; }, loadOne: async () => null });
await idleViews.read({ personId: 'a' }); await idleViews.read({ personId: 'b' });
idleClock = 9 * 60_000; await idleViews.read({ personId: 'b' });
assert.equal(idleViews.sweepIdle(10 * 60_000, 11 * 60_000), 1, 'only the view unread for the idle window is released');
await idleViews.read({ personId: 'b' });
assert.equal(idleLoads, 1, 'a recently read view keeps its overlay');
await idleViews.read({ personId: 'a' });
assert.equal(idleLoads, 1, 'overlay eviction never rereads the base');
console.log('test-session-list-cache: ok (7000 records, 8 viewer keys, no cold rebuild after hints or 10 minutes)');
