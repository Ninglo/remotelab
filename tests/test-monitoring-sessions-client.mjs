import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSessionMonitoringClient } from '../chat/monitoring-sessions-client.mjs';

// Client timers are unref'd for the server; keep this test process alive.
const keepAlive = setInterval(() => {}, 1000);
const created = [];
function fakeWorker(handler) {
  return () => {
    const worker = new EventEmitter();
    worker.terminated = false;
    worker.postMessage = message => setImmediate(() => handler(worker, message));
    worker.terminate = async () => { worker.terminated = true; worker.emit('exit', 1); };
    created.push(worker);
    return worker;
  };
}

const client = createSessionMonitoringClient({ idleMs: 30, timeoutMs: 1000,
  createWorker: fakeWorker((worker, { id, days, dashboard }) => worker.emit('message', { id, data: { days, dashboard } })) });
assert.deepEqual(await client.read({ days: 7, dashboard: true }), { days: 7, dashboard: true });
assert.deepEqual(await client.read({ days: 1 }), { days: 1, dashboard: false });
assert.equal(created.length, 1, 'consecutive reads reuse one worker');
await new Promise(resolve => setTimeout(resolve, 60));
assert.equal(created[0].terminated, true, 'an idle worker exits so its scan caches are released');
await client.read({ days: 1 });
assert.equal(created.length, 2, 'the next read starts a fresh worker');
client.stop();

const crashing = createSessionMonitoringClient({ createWorker: fakeWorker(worker => worker.emit('error', new Error('heap limit'))) });
await assert.rejects(crashing.read({ days: 1 }), /worker stopped: heap limit/);
crashing.stop();

let calls = 0;
const stuck = createSessionMonitoringClient({ timeoutMs: 20,
  createWorker: fakeWorker((worker, { id }) => { if (++calls > 1) worker.emit('message', { id, data: 'ok' }); }) });
await assert.rejects(stuck.read({ days: 1 }), /timed out/);
assert.equal(await stuck.read({ days: 1 }), 'ok', 'a timed-out scan does not block later reads');
stuck.stop();

const failing = createSessionMonitoringClient({ createWorker: fakeWorker((worker, { id }) => worker.emit('message', { id, error: 'scan failed' })) });
await assert.rejects(failing.read({ days: 1 }), /scan failed/);
failing.stop();
clearInterval(keepAlive);
console.log('test-monitoring-sessions-client: ok (reuse, idle exit, crash, timeout restart, reader error)');
