import assert from 'node:assert/strict';
import { setImmediate as flush, setTimeout as sleep } from 'node:timers/promises';
import { watchFeishuAdmission } from '../connectors/feishu/admission-watch.mjs';
import { FEISHU_ADMISSION_TIMEOUT } from '../lib/recent-errors.mjs';

const events = [];
const observe = (source, event) => events.push({source, ...event});
let now = 1;
assert.equal(await watchFeishuAdmission('fast', async () => 'receipt', {startedAt: 1, now: () => now, observe}), 'receipt');
assert.equal(events.length, 0);
let release;
const pending = watchFeishuAdmission('waiting', () => new Promise(res => { release = res; }),
  {startedAt: Date.now(), thresholdMs: 10, observe});
await sleep(30);
assert.equal(events.length, 1, 'late while still awaiting the receipt');
release('late receipt');
assert.equal(await pending, 'late receipt');
assert.equal(events.length, 1, 'do not record again on completion');
assert.deepEqual({source: events[0].source, operation: events[0].operation, error: events[0].error.message},
  {source: 'feishu-inbox', operation: 'waiting', error: FEISHU_ADMISSION_TIMEOUT});
const action = async () => { now = 30_002; throw new Error('original transport failure'); };
await assert.rejects(watchFeishuAdmission('late failure', action, {startedAt: 1, now: () => now, observe}), /original transport failure/);
await flush();
assert.equal(events.length, 2, 'record slow failures even when the timer did not run');
console.log('Feishu admission watch: fast, pending, late success, and late failure passed');
