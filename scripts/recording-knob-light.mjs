#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { RecordingKnobLight, knobStatusSignature } from '../lib/recording/knob-light.mjs';

const options = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const name = args[i].slice(2);
  if (name === 'help') {
    console.log('ANTICATER USB recording light:\n  --root PATH --lane ID --serial USB_SERIAL --helper COMPILED_SWIFT_PATH\n'
      + '  [--probe | --configure-button | --demo] [--cue PATH (demo only)]\n'
      + 'Compile recording-knob-hid-macos.swift with swiftc. --probe is read-only.\n'
      + '--configure-button saves the original six reports and maps only press to F13.\n'
      + 'Normal mode follows the existing recorder; audio/cues/uploads remain with it.');
    process.exit(0);
  }
  if (['probe', 'configure-button', 'demo'].includes(name)) { options[name] = true; continue; }
  if (!['root', 'lane', 'serial', 'helper', 'cue'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Invalid option ${args[i]}`);
  options[name] = args[++i];
}
for (const name of ['root', 'lane', 'serial', 'helper']) if (!options[name]) throw Error(`Missing --${name}`);
if (!/^[A-Za-z0-9_-]+$/.test(options.serial)) throw Error('Invalid USB serial');
if (['probe', 'configure-button', 'demo'].filter(key => options[key]).length > 1) throw Error('Choose only one operation');
const root = resolve(options.root), log = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
const projection = new RecordingKnobLight(options.lane), pending = new Map();
let child, lines, watcher, healthTimer, frameTimer, stopping = false, connected = false, sequence = 0;
let lastFrame = '', frameBusy = false, refreshing = false, signature = '', seenPhase = '', queryCollector;
let readyResolve, readyReject;
const ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
const readyTimeout = setTimeout(() => readyReject(Error('Knob USB interface did not appear')), 8000);

function send(action) {
  if (!connected) return Promise.reject(Error('Knob USB disconnected'));
  return new Promise((accept, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error('Knob command timed out')); }, 1500);
    pending.set(id, { accept, reject, timeout });
    child.stdin.write(JSON.stringify({ id, ...action }) + '\n');
  });
}
async function configuration() {
  const reports = new Map();
  const complete = new Promise((accept, reject) => {
    const timeout = setTimeout(() => { queryCollector = null; reject(Error('Incomplete knob configuration')); }, 2000);
    queryCollector = bytes => {
      if (bytes.length !== 64 || bytes[0] !== 3 || bytes[1] !== 253) return;
      reports.set(bytes[2], bytes);
      if ([0, 2, 3, 4, 5, 6].every(key => reports.has(key))) {
        clearTimeout(timeout); queryCollector = null; accept(Object.fromEntries(reports));
      }
    };
  });
  const [, reportsRead] = await Promise.all([send({ action: 'query' }), complete]);
  return reportsRead;
}
function liveStatus() {
  return new Promise((accept, reject) => {
    const socket = createConnection(join(root, 'control.sock'));
    let buffer = '', done = false;
    const finish = (error, value) => { if (done) return; done = true; socket.destroy(); error ? reject(error) : accept(value); };
    socket.setTimeout(700, () => finish(Error('Recorder is not responding')));
    socket.once('error', error => finish(error));
    socket.once('connect', () => socket.write('{"action":"status"}\n'));
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 8 * 1024 * 1024) return finish(Error('Oversized recording status'));
      if (!buffer.includes('\n')) return;
      try {
        const value = JSON.parse(buffer.split('\n')[0]);
        if (value.error) throw Error(value.error);
        if (!Array.isArray(value.active) || !Array.isArray(value.records)) throw Error('Invalid recorder status');
        finish(null, value);
      } catch (error) { finish(error); }
    });
    socket.once('end', () => { if (!done) finish(Error('Recorder closed without a response')); });
  });
}
async function frame() {
  if (frameBusy || stopping || !connected) return;
  frameBusy = true;
  try {
    const settings = projection.frame(performance.now()), key = JSON.stringify(settings);
    if (projection.phase !== seenPhase) { seenPhase = projection.phase; log({ phase: seenPhase, lane: options.lane, recordingId: projection.activeId }); }
    if (key !== lastFrame) { await send({ action: 'light', ...settings }); lastFrame = key; }
  } catch (error) { if (connected) await shutdown(error); }
  finally { frameBusy = false; }
}
async function refresh() {
  if (refreshing || stopping) return;
  refreshing = true;
  try { projection.update(await liveStatus(), performance.now()); }
  catch (error) { if (projection.phase !== 'offline') log({ recorderError: error.message }); projection.reset(); }
  finally { refreshing = false; }
  await frame();
}
async function shutdown(error) {
  if (stopping) return; stopping = true;
  clearTimeout(readyTimeout); clearInterval(healthTimer); clearInterval(frameTimer); watcher?.close();
  if (error) { log({ error: error.message }); process.exitCode = 1; }
  // No new frame can follow the clear command; FIFO stdin preserves ordering.
  if (connected && !options.probe && !options['configure-button']) {
    await send({ action: 'light', rgb: [0, 0, 0], brightness: 0, enabled: false }).catch(() => {});
  }
  child?.stdin.end();
  for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(Error('Knob controller stopped')); }
  pending.clear();
}

try {
  const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  if (!config.lanes.some(lane => lane.id === options.lane)) throw Error('Selected recording lane is not configured');
  child = spawn(resolve(options.helper), ['--serial', options.serial], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.once('error', error => { readyReject(error); shutdown(error); });
  child.stdin.on('error', error => { if (!stopping) shutdown(error); });
  lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.event === 'connected') { connected = true; lastFrame = ''; clearTimeout(readyTimeout); readyResolve(); log(event); }
      else if (event.event === 'disconnected') { connected = false; log(event); }
      else if (event.event === 'report') queryCollector?.(event.bytes);
      else if (pending.has(event.id)) {
        const request = pending.get(event.id); pending.delete(event.id); clearTimeout(request.timeout);
        event.code === 0 ? request.accept(event) : request.reject(Error(event.error || `Knob HID error ${event.code}`));
      } else if (event.error) shutdown(Error(event.error));
    } catch (error) { shutdown(error); }
  });
  child.once('exit', (code, signal) => {
    connected = false; lines.close();
    if (!stopping) { const error = Error(`Knob helper exited (${code ?? signal})`); readyReject(error); shutdown(error); }
  });
  process.once('SIGTERM', () => shutdown()); process.once('SIGINT', () => shutdown());
  await ready;
  const original = await configuration();
  log({ configurationRead: true, press: original[3].slice(0, 10), light: original[0].slice(0, 9) });
  if (options['configure-button']) {
    const backup = join(root, `knob-${options.serial}-original.json`);
    try { await writeFile(backup, JSON.stringify({ serial: options.serial, reports: original }, null, 2), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await send({ action: 'map-press' });
    const readback = await configuration(), expected = [3, 253, 3, 1, 1, 0, 1, 0, 0, 104];
    if (JSON.stringify(readback[3].slice(0, 10)) !== JSON.stringify(expected)) throw Error('F13 mapping readback failed; inspect original backup');
    log({ configured: 'F13', backup }); await shutdown();
  } else if (options.probe) {
    log({ reports: original }); await shutdown();
  } else if (options.demo) {
    const status = await liveStatus();
    if (status.active.length) throw Error('Finish active recording before a light demo');
    if (options.cue) await promisify(execFile)('/usr/bin/afplay', [resolve(options.cue)]);
    const start = performance.now();
    projection.update({ active: [], records: [] }, start);
    let step = -1;
    frameTimer = setInterval(() => {
      const now = performance.now(), elapsed = now - start, next = elapsed < 500 ? 0 : elapsed < 5000 ? 1 : 2;
      if (step !== next) {
        step = next;
        const active = next < 2 ? [{ laneId: options.lane, recordingId: 'demo', state: next ? 'recording' : 'starting' }] : [];
        projection.update({ active, records: next === 2 ? [{ id: 'demo', laneId: options.lane, status: 'held', endedAt: 'demo' }] : [] }, now);
      }
      if (elapsed >= 7000) { log({ demoComplete: true }); shutdown(); } else frame();
    }, 50);
  } else {
    watcher = watch(root, (_, name) => {
      if (name?.toString() !== 'status.json' || stopping) return;
      readFile(join(root, 'status.json'), 'utf8').then(text => {
        const next = knobStatusSignature(JSON.parse(text));
        if (next !== signature) { signature = next; return refresh(); }
      }).catch(() => refresh());
    });
    watcher.on('error', error => shutdown(error));
    await refresh();
    if (!stopping) {
      frameTimer = setInterval(frame, 50);
      // Native file events deliver transitions; a live health read clears a dead recorder.
      healthTimer = setInterval(refresh, 1000);
      log({ ready: true, lane: options.lane, serial: options.serial });
    }
  }
} catch (error) { await shutdown(error); }
