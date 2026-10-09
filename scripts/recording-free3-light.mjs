#!/usr/bin/env node
import { createRequire } from 'node:module';
import { watch } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { Free3RecordingLight, selectFree3Port, indicatorSignature, free3UsbPackets } from '../lib/recording/free3-light.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') {
    console.log('Optional Free3 recording light (does not record):\n'
      + '  --root PATH --lane ID --key 1|2|3 --serial USB_SERIAL --serial-module PATH [--shift P|M|R]\n'
      + '  --probe  Read model/firmware only; leave lights unchanged\n'
      + 'Use the vendor Electron executable with ELECTRON_RUN_AS_NODE=1 when loading its bundled serialport.\n'
      + 'The USB data cable must remain connected. Bluetooth-only control is not verified.');
    process.exit(0);
  }
  if (args[i] === '--probe') { options.probe = true; continue; }
  const name = args[i].slice(2);
  if (!['root', 'lane', 'key', 'serial', 'serial-module', 'shift'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Invalid option ${args[i]}`);
  options[name] = args[++i];
}
for (const name of ['root', 'lane', 'key', 'serial', 'serial-module']) if (!options[name]) throw Error(`Missing --${name}`);
const root = resolve(options.root), key = Number(options.key);
const log = (value) => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
const { SerialPort } = createRequire(import.meta.url)(resolve(options['serial-module']));
let port, watcher, timer, shuttingDown = false, light;

function call(method, ...values) {
  return new Promise((accept, reject) => {
    const deadline = setTimeout(() => reject(Error(`Free3 ${method} timed out`)), 1500);
    port[method](...values, (error) => { clearTimeout(deadline); error ? reject(error) : accept(); });
  });
}
function liveStatus() {
  return new Promise((accept, reject) => {
    const socket = createConnection(join(root, 'control.sock'));
    let buffer = '', done = false;
    const finish = (error, value) => {
      if (done) return; done = true; socket.destroy();
      error ? reject(error) : accept(value);
    };
    socket.setTimeout(700, () => finish(Error('Recording service did not respond')));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(JSON.stringify({ action: 'status' }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 2 * 1024 * 1024) return finish(Error('Oversized recording status'));
      if (!buffer.includes('\n')) return;
      try {
        const value = JSON.parse(buffer.split('\n')[0]);
        if (value.error) throw Error(value.error);
        finish(null, value);
      } catch (error) { finish(error); }
    });
    socket.once('end', () => { if (!done) finish(Error('Recording service closed without status')); });
  });
}
function query(type) {
  return new Promise((accept, reject) => {
    let buffer = '', done = false;
    const deadline = setTimeout(() => finish(Error(`No Free3 response for ${type}`)), 1500);
    const finish = (error, value) => {
      if (done) return; done = true;
      clearTimeout(deadline); port.off('data', receive);
      error ? reject(error) : accept(value);
    };
    const receive = (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 8192) return finish(Error('Oversized Free3 response'));
      // Device info responses are flat JSON objects, sometimes concatenated.
      for (const match of buffer.matchAll(/\{[^{}]*\}/g)) {
        try { const value = JSON.parse(match[0]); if (value.o === 'getresult' && value.t === type) return finish(null, value.v); } catch {}
      }
    };
    port.on('data', receive);
    call('write', JSON.stringify({ o: 'get', t: type })).catch((error) => finish(error));
  });
}
async function shutdown(error) {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(timer); watcher?.close();
  if (error) { log({ error: error.message }); process.exitCode = 1; }
  try { if (light && port?.isOpen) await light.close(); } catch (e) { log({ clearLightError: e.message }); process.exitCode = 1; }
  if (port?.isOpen) await call('close').catch((e) => log({ closeError: e.message }));
}

try {
  const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  if (!config.lanes.some((lane) => lane.id === options.lane)) throw Error('Selected lane is not configured');
  const selected = selectFree3Port(await SerialPort.list(), options.serial);
  const path = process.platform === 'darwin' ? selected.replace('/dev/tty.', '/dev/cu.') : selected;
  await access(path);
  port = new SerialPort({ path, baudRate: 460800, autoOpen: false, lock: true });
  port.on('error', (e) => shutdown(e));
  await call('open');
  const model = await query('model'), firmware = await query('firmware');
  if (model !== 'Free 3') throw Error(`Unexpected model ${model}; no lights changed`);
  log({ model, firmware, serial: options.serial, port: path, probe: !!options.probe });
  if (options.probe) {
    await call('close');
  } else {
    let sequence = 1;
    light = new Free3RecordingLight({ laneId: options.lane, key, shift: options.shift, getStatus: liveStatus,
      send: async (command) => {
        const packets = free3UsbPackets(command, sequence); sequence = sequence % 9 + 1;
        for (const packet of packets) { await call('write', packet); await call('drain'); }
        log({ usbWrite: command, physicalLightVerified: false });
      }, report: log });
    let busy = false, signature = '';
    const refresh = async () => {
      if (busy || shuttingDown) return; busy = true;
      try { await light.refresh(); } catch (e) { await shutdown(e); } finally { busy = false; }
    };
    watcher = watch(root, (_, name) => {
      if (name?.toString() !== 'status.json' || shuttingDown) return;
      readFile(join(root, 'status.json'), 'utf8').then((text) => {
        const next = indicatorSignature(JSON.parse(text));
        if (next !== signature) { signature = next; return refresh(); }
      }).catch(() => refresh());
    });
    watcher.on('error', (error) => shutdown(error));
    port.once('close', () => { if (!shuttingDown) shutdown(Error('Free3 USB disconnected; light control stopped')); });
    process.once('SIGTERM', () => shutdown()); process.once('SIGINT', () => shutdown());
    await refresh();
    // Event-driven changes plus one live health read per second clear a dead/hung recorder.
    if (!shuttingDown) {
      timer = setInterval(refresh, 1000);
      log({ ready: true, lane: options.lane, key, recordingControlledBy: 'existing recorder only' });
    }
  }
} catch (error) { await shutdown(error); }
