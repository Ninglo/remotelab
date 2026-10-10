import assert from 'node:assert/strict';
import { createLatestChannel } from '../lib/latest-projection-channel.mjs';

let next = 0;
const timers = new Map(), sent = [], expired = [];
const channel = createLatestChannel(packet => { sent.push(packet.serial); }, {
  schedule(callback) { timers.set(++next, callback); return next; },
  cancel(id) { timers.delete(id); },
  onTimeout(packet) { expired.push(packet.serial); },
});
channel.offer({ serial: 1 });
channel.offer({ serial: 2 });
channel.offer({ serial: 3 });
assert.deepEqual(sent, [1]);
assert.equal(channel.ack(99), false);
channel.ack(1);
assert.deepEqual(sent, [1, 3]);
assert.equal(timers.size, 1, 'acknowledged packet cancels its deadline');
const timeout = [...timers.values()][0];
timers.clear();
timeout();
assert.deepEqual(expired, [3], 'a lost receipt causes transport recovery');
assert.equal(channel.activeSerial, undefined);
assert.equal(channel.ack(3), false, 'late receipts cannot certify the recovered channel');
channel.offer({ serial: 4 });
assert.deepEqual(sent, [1, 3, 4], 'recovery sends a fresh snapshot');
channel.reset();
assert.equal(timers.size, 0, 'disconnects cancel receipt deadlines');
console.log('test-latest-projection-channel: ok');
