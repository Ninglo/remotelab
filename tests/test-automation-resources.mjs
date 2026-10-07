import assert from 'node:assert/strict';
import { createAutomationResources } from '../chat/automation-resources.mjs';

const row = (id, run = 'idle', count = 0, compact = 'idle') => ({ id,
  activity: { run: { state: run }, queue: { count }, compact: { state: compact } } });
let rows = [row('a', 'running'), row('b')], fullReads = 0, singleReads = 0, errors = 0, broken = false;
const wakes = [], timers = new Map(); let nextTimer = 0, listener, subscriptions = 0;
const tracker = createAutomationResources({
  listResources: async () => { fullReads++; if (broken) throw new Error('unavailable'); return rows; },
  getResource: async id => { singleReads++; if (broken) throw new Error('unavailable'); return rows.find(r => r.id === id); },
  subscribe: fn => { listener = fn; subscriptions++; return () => { listener = null; subscriptions--; }; },
  onIdle: cause => wakes.push(cause), onError: () => errors++,
  // Fake timer delays must use a fake clock too: a real 1 ms tick otherwise
  // changes the rearmed delay to 999 ms and quiet() cannot find the timer.
  now: () => 10000,
  setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
  clearTimer: id => timers.delete(id),
});
function quiet() {
  const timer = [...timers.entries()].find(([, t]) => t.ms === 1000);
  if (timer) { timers.delete(timer[0]); timer[1].fn(); }
}
await tracker.start(); await tracker.start();
assert.equal(fullReads, 1); assert.equal(subscriptions, 1);
assert.equal(tracker.snapshot().sessions.length, 1); quiet(); assert.equal(wakes.length, 0);
rows = [row('a'), row('b')]; listener('a'); listener('a');
assert.equal(tracker.snapshot().status, 'observing', 'pending hints must not report stale idle');
await tracker.flush(); assert.equal(singleReads, 1); assert.equal(fullReads, 1);
listener('b'); await tracker.flush(); quiet();
assert.deepEqual(wakes, ['foreground_idle'], 'a hint during the quiet window must preserve the idle edge');
listener('b'); await tracker.refresh(); quiet();
assert.equal(wakes.length, 1, 'unchanged metadata must not wake gates');
assert.equal(fullReads, 1, 'a resource API read flushes pending IDs without a full scan');
for (const busyRow of [row('b', 'idle', 1), row('b', 'idle', 0, 'pending'), row('b', 'running')]) {
  rows = [row('a'), busyRow]; listener('b'); await tracker.flush(); quiet();
  assert.equal(tracker.snapshot().sessions.length, 1); assert.equal(wakes.length, 1);
}
rows = [row('a'), row('b')]; listener('b'); await tracker.flush();
// A new foreground request during the quiet window prevents idle admission.
rows = [row('a', 'running'), row('b')]; listener('a'); await tracker.flush(); quiet();
assert.equal(wakes.length, 1);
broken = true; listener('a'); await tracker.flush(); quiet();
assert.equal(tracker.snapshot().status, 'observing'); assert.equal(errors, 1);
broken = false; rows = [row('a'), row('b')]; listener('a'); await tracker.flush(); quiet();
assert.equal(fullReads, 2, 'recovery reseeds the complete resource map');
assert.equal(wakes.at(-1), 'resource_recovery');
tracker.stop(); assert.equal(subscriptions, 0); assert.equal(timers.size, 0);
await tracker.start(); quiet(); assert.equal(wakes.at(-1), 'resource_recovery');
tracker.stop();

let completeRead;
const late = createAutomationResources({ listResources: () => new Promise(resolve => { completeRead = resolve; }),
  subscribe: () => () => {}, onIdle: () => assert.fail('stopped observers cannot wake work') });
const startup = late.start(); late.stop(); completeRead([]); await startup;
assert.equal(late.snapshot().status, 'observing');
console.log('automation resource observation: transition, deduplication, queue/compact, recovery and stop passed');

// A five-minute timer is one event-driven confirmation, not 300 gate calls.
let clock = Date.parse('2026-10-07T00:00:00Z'), stableRows = [], stableListener;
const stableTimers = new Map(), stableWakes = []; let stableId = 0;
const stable = createAutomationResources({ listResources: async () => stableRows,
  getResource: async id => stableRows.find(r => r.id === id), subscribe: fn => { stableListener = fn; return () => {}; },
  onIdle: cause => stableWakes.push(cause), now: () => clock,
  setTimer: (fn, ms) => { const id = ++stableId; stableTimers.set(id, { fn, at: clock + ms }); return id; },
  clearTimer: id => stableTimers.delete(id) });
stable.setQuietPeriods([300000]); await stable.start();
const began = stable.snapshot().idleSince;
function advance(ms) { clock += ms; for (const [id, timer] of [...stableTimers]) {
  if (timer.at <= clock) { stableTimers.delete(id); timer.fn(); }
} }
advance(299000); assert.equal(stableWakes.length, 0);
stableListener('title-only'); await stable.flush();
assert.equal(stable.snapshot().idleSince, began, 'metadata updates retain a genuinely stable idle window');
// Even a request that finishes before the coalesced resource read resets idle.
stableListener('brief-request', { resetIdle: true }); await stable.flush();
advance(1000); assert.equal(stableWakes.length, 0);
advance(299000); assert.equal(stableWakes.length, 1);
stableRows = [row('busy', 'running')]; stableListener('busy', { resetIdle: true }); await stable.flush();
assert.equal(stable.snapshot().idleSince, '');
stable.stop(); assert.equal(stableTimers.size, 0);
await stable.start(); assert.equal(stable.snapshot().idleSince, '');
stableRows = []; stableListener('busy'); await stable.flush();
advance(300000); assert.equal(stableWakes.length, 2, 'restart starts a fresh confirmation window'); stable.stop();
