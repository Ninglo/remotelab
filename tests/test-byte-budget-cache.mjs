import assert from 'node:assert/strict';
import { ByteBudgetCache } from '../chat/byte-budget-cache.mjs';
const cache = new ByteBudgetCache(400, text => text.length * 2);
cache.set('a', 'a'.repeat(20)); cache.set('b', 'b'.repeat(20));
assert.equal(cache.peek('a').length, 20);
cache.set('c', 'c'.repeat(20));
assert.equal(cache.has('a'), false, 'background peek cannot promote old history');
cache.get('b'); cache.set('d', 'd'.repeat(20));
assert.equal(cache.has('b'), true, 'real interaction keeps hot data');
assert.equal(cache.has('c'), false);
cache.set('huge', 'x'.repeat(1000));
assert.equal(cache.has('huge'), false);
assert.equal(cache.has('b'), true, 'one oversized value cannot flush the hot set');
cache.set('b', 'b'); assert(cache.bytes <= 400);
assert.deepEqual([...cache.keys()], ['d', 'b']);
cache.clear(); assert.equal(cache.bytes, 0); assert.equal(cache.size, 0);

const idle = new ByteBudgetCache(10_000, text => text.length * 2);
const realNow = Date.now;
try {
  let t = 1_000_000; Date.now = () => t;
  idle.set('old', 'o'); t += 1000; idle.set('warm', 'w'); idle.set('touched', 't');
  t += 60_000; idle.get('touched');
  assert.equal(idle.sweepIdle(30_000, t), 2, 'entries untouched past the idle window are released');
  assert.deepEqual([...idle.keys()], ['touched'], 'recently read data stays cached');
  assert.equal(idle.bytes, 'touched'.length * 2 + 't'.length * 2 + 96);
  assert.equal(idle.sweepIdle(30_000, t), 0);
} finally { Date.now = realNow; }
console.log('PASS: byte bound, interaction recency, scan peek, oversized bypass, replacement accounting and idle release');
