import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Free3RecordingLight, selectFree3Port, free3UsbPackets, free3LightCommand } from '../lib/recording/free3-light.mjs';

test('mode-specific light packets retain the same selected bank on start and stop', async () => {
  const writes = [];
  const light = new Free3RecordingLight({ laneId: 'a', key: 1, shift: 'P',
    getStatus: async () => ({ active: [{ laneId: 'a', state: 'recording' }] }),
    send: async command => writes.push(command) });
  await light.refresh(); await light.close();
  assert.deepEqual(writes.map(command => command.s), ['P', 'P']);
  assert.deepEqual(writes.map(command => command.v.enable), [true, false]);
  assert.throws(() => free3LightCommand(1, true, 'invalid'), /shift/);
});

test('indicator follows saved PCM state; stops and an unresponsive recorder clear it', async () => {
  let active = [], fail = false;
  const writes = [];
  const light = new Free3RecordingLight({ laneId: 'a', key: 1,
    getStatus: async () => { if (fail) throw Error('recorder died'); return { active }; },
    send: async (value) => writes.push(value) });
  await light.refresh();
  active = [{ laneId: 'a', state: 'starting' }]; await light.refresh();
  active = [{ laneId: 'b', state: 'recording' }]; await light.refresh();
  assert.equal(writes.length, 1);
  active = [{ laneId: 'a', state: 'recording' }]; await light.refresh(); await light.refresh();
  active = []; await light.refresh();
  active = [{ laneId: 'a', state: 'recording' }]; await light.refresh();
  fail = true; await light.refresh();
  assert.deepEqual(writes.map((w) => w.v.enable), [false, true, false, true, false]);
  assert.ok(writes.every((w) => w.k === 1 && w.m === 'light'));
  const on = writes[1], packets = free3UsbPackets(on, 3);
  assert.ok(packets.every((p) => p.length <= 64));
  assert.deepEqual(JSON.parse(Buffer.concat(packets.map((p) => p.subarray(7))).toString()), on);
});

test('shutdown waits for an in-flight light write then clears; no late turn-on', async () => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  let entered;
  const sending = new Promise((resolve) => { entered = resolve; });
  const writes = [];
  const light = new Free3RecordingLight({ laneId: 'a', key: 1,
    getStatus: async () => ({ active: [{ laneId: 'a', state: 'recording' }] }),
    send: async (w) => { if (w.v.enable) { entered(); await started; } writes.push(w.v.enable); } });
  const refresh = light.refresh(); await sending;
  const stop = light.close(); const late = light.refresh();
  release(); await Promise.all([refresh, stop, late]);
  assert.deepEqual(writes, [true, false]);
});

test('USB write failure is retried with actual state and does not mark a light as changed', async () => {
  let count = 0;
  const light = new Free3RecordingLight({ laneId: 'a', key: 1,
    getStatus: async () => ({ active: [] }), send: async () => { if (!count++) throw Error('USB gone'); } });
  await assert.rejects(light.refresh(), /USB gone/);
  assert.equal(light.last, undefined);
  await light.refresh(); assert.equal(light.last, false);
});

test('selects only the explicit Free3, rejecting a different USB board and ambiguity', () => {
  const target = { path: '/dev/tty.usbmodem1', vendorId: '4C4A', productId: '4155', serialNumber: 'selected' };
  assert.equal(selectFree3Port([target], 'selected'), target.path);
  assert.throws(() => selectFree3Port([{ ...target, vendorId: '1a86' }], 'selected'), /found 0/);
  assert.throws(() => selectFree3Port([target], 'another'), /found 0/);
  assert.throws(() => selectFree3Port([target, { ...target, path: '/dev/tty.usbmodem2' }], 'selected'), /found 2/);
});
