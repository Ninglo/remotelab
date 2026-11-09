import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { bluetoothKnobReports, bluetoothKnobLight, RecordingKnobTransport } from '../lib/recording/knob-transport.mjs';

// Synthetic protocol/transport fixtures; no Bluetooth radio or recorder is opened.
const config = [0, 2, 3, 4, 5, 6].map(type => {
  const bytes = Buffer.alloc(64); bytes.set([3, 253, type]);
  if (type === 3) bytes.set([1, 1, 0, 1, 0, 0, 104], 3);
  return bytes;
});
const queryOutput = config.map(bytes => JSON.stringify({ type: 'notify', short_uuid: 'AE42',
  data: Buffer.concat([Buffer.from([3]), bytes]).toString('hex') })).join('\n');
assert.equal(bluetoothKnobReports(queryOutput).length, 6);
assert.equal(bluetoothKnobReports(queryOutput)[2][9], 104);
assert.throws(() => bluetoothKnobReports(queryOutput.split('\n').slice(1).join('\n')), /Incomplete/);
assert.throws(() => bluetoothKnobReports(queryOutput.replaceAll('AE42', 'AE02')), /Incomplete/);
const light = { action: 'light', rgb: [100, 160, 255], brightness: 25, enabled: true };
const packet = Buffer.from(bluetoothKnobLight(light), 'hex');
assert.equal(packet.length, 64);
assert.deepEqual([...packet.subarray(0, 9)], [3, 253, 0, 6, 100, 160, 255, 25, 1]);
assert.throws(() => bluetoothKnobLight({ ...light, brightness: 101 }), /Invalid/);

function setup() {
  const events = [], children = [], calls = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.commands = [];
    child.stdin.on('data', chunk => child.commands.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
    child.report = value => child.stdout.write(JSON.stringify(value) + '\n');
    children.push(child); calls.push({ file, args });
    return child;
  };
  const run = async (file, args) => { calls.push({ file, args }); return { stdout: queryOutput }; };
  const bridge = new RecordingKnobTransport({ serial: 'verified-serial', usbHelper: '/usb',
    bleHelper: '/official-ble', bluetooth: 'verified-uuid' }, value => events.push(value), { spawn, run });
  bridge.start();
  return { bridge, children, events, calls };
}

const { bridge, children, events, calls } = setup();
const usb = children[0];
usb.report({ event: 'usb-absent' });
await setImmediate();
assert.deepEqual(calls[1].args.slice(0, 3), ['connect', 'verified-uuid', '--query']);
const ble = children[1];
ble.report({ type: 'session_ready', short_uuid: 'AE41' });
assert.equal(events.at(-1).transport, 'bluetooth');
bridge.command({ id: 1, action: 'query' });
assert.equal(events.filter(event => event.event === 'report').length, 6);
bridge.command({ id: 2, action: 'map-press' });
assert.match(events.at(-1).error, /requires USB/);
bridge.command({ id: 3, ...light });
assert.equal(ble.commands.at(-1).packets[0], packet.toString('hex'));
assert.ok(!events.some(event => event.id === 3), 'a queued write is not an acknowledgement');
ble.report({ type: 'write_ok', length: 64 });
assert.deepEqual(events.at(-1), { id: 3, code: 0 });
bridge.command({ id: 4, ...light });
usb.report({ event: 'connected' });
assert.ok(events.some(event => event.id === 4 && event.superseded));
assert.equal(ble.commands.at(-1).type, 'quit');
assert.equal(events.at(-1).transport, 'usb');
bridge.command({ id: 5, ...light });
assert.equal(usb.commands.at(-1).id, 5);
ble.report({ type: 'error', message: 'late old connection failure' });
assert.ok(!events.some(event => event.error?.includes('late old')));
usb.report({ event: 'disconnected' });
await setImmediate();
const ble2 = children[2];
ble2.report({ type: 'session_ready', short_uuid: 'AE41' });
bridge.close();
assert.equal(Buffer.from(ble2.commands.at(-2).packets[0], 'hex')[8], 0, 'shutdown disables the LED');
assert.equal(ble2.commands.at(-1).type, 'quit');

const disconnected = setup();
disconnected.children[0].report({ event: 'usb-absent' });
await setImmediate();
disconnected.children[1].report({ type: 'session_ready', short_uuid: 'AE41' });
disconnected.children[1].report({ type: 'session_disconnected' });
assert.match(disconnected.events.at(-1).error, /disconnected/);
assert.equal(disconnected.bridge.bleReady, false);
disconnected.bridge.close();
console.log('synthetic USB/Bluetooth selection, protocol, acknowledgement and cleanup verified');
