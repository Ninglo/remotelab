import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRecordingConfig, readRecordingConfig, saveRecordingConfig } from '../lib/recording/config.mjs';
import { StereoSplitter, WavWriter, wavHeader } from '../lib/recording/pcm.mjs';
import { RecordingManager } from '../lib/recording/recorder.mjs';
import { loadRecord, recordDir, saveRecord, recoverRecordings, recordingSummary } from '../lib/recording/store.mjs';
import { startRecordingDaemon, controlRecording, RecordingUploadQueue } from '../lib/recording/daemon.mjs';
import { submitRecording } from '../lib/recording/transport.mjs';
import { recordingServiceSpec } from '../lib/recording/service.mjs';

function config(extra = {}) {
  return normalizeRecordingConfig({ enabled: true, machineId: 'test_machine',
    receivers: [{ id: 'rx1', backend: 'alsa', source: 'hw:CARD=DJI1' }, { id: 'rx2', backend: 'alsa', source: 'hw:CARD=DJI2' }],
    lanes: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, receiverId: i < 2 ? 'rx1' : 'rx2', channel: i % 2 })),
    limits: { minFreeBytes: 0 }, ...extra });
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'remotelab-recording-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function stereo(left, right, frames = 4) {
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) { data.writeInt16LE(left, i * 4); data.writeInt16LE(right, i * 4 + 2); }
  return data;
}
function captureFactory() {
  const captures = new Map();
  const spawnCapture = (receiver) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => {
      if (child.killed) return; child.killed = true;
      child.emit('exit', 0); child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    };
    captures.set(receiver.id, child);
    return child;
  };
  return { captures, spawnCapture };
}
async function feed(manager, child, receiverId, data) {
  const heard = once(manager, 'audio', { signal: AbortSignal.timeout(3000) });
  child.stderr.write('Stream #0:0: Audio: pcm_s16le, 48000 Hz, stereo, s16\n');
  child.stdout.write(data);
  const [event] = await heard; assert.equal(event.receiverId, receiverId);
}
async function samples(root, record) {
  const out = [];
  for (const { filename } of record.segments) {
    const file = await readFile(join(recordDir(root, record.id), filename));
    assert.equal(file.readUInt32LE(40), file.length - 44);
    for (let i = 44; i < file.length; i += 2) out.push(file.readInt16LE(i));
  }
  return out;
}

test('explicit device identities, unique lane/key bindings, and machine identity survive configure', async (t) => {
  const root = await temporary(t);
  const first = await saveRecordingConfig(root, config());
  assert.equal((await readRecordingConfig(root)).machineId, first.machineId);
  assert.equal((await stat(join(root, 'config.json'))).mode & 0o777, 0o600);
  assert.throws(() => config({ receivers: [{ id: 'rx1', backend: 'alsa', source: 'default' }] }), /explicit audio/);
  assert.throws(() => config({ receivers: [{ id: 'rx1', backend: 'avfoundation', source: ':1' }] }), /uid: or serial:/);
  assert.throws(() => config({ lanes: [{ id: 'a', receiverId: 'rx1', channel: 0 }, { id: 'b', receiverId: 'rx1', channel: 0 }] }), /only one lane/);
  assert.throws(() => config({ bindings: [{ deviceId: 'keypad', key: 104, laneId: 'a' }, { deviceId: 'keypad', key: 104, laneId: 'b' }] }), /only one lane/);
  assert.doesNotMatch(recordingServiceSpec(root, { platform: 'darwin' }).body, /<string>HOME<\/string>/);
  assert.notEqual(recordingServiceSpec(root, { platform: 'linux' }).name, recordingServiceSpec(root + '2', { platform: 'linux' }).name);
});

test('arbitrary pipe boundaries preserve per-channel PCM without mixing receivers', () => {
  const splitter = new StereoSplitter(), chunks = [stereo(1234, -5678), stereo(2468, -1357)];
  const joined = Buffer.concat(chunks), left = [], right = [];
  for (let offset = 0; offset < joined.length; offset += 3) {
    const split = splitter.split(joined.subarray(offset, offset + 3)); left.push(split[0]); right.push(split[1]);
  }
  const a = Buffer.concat(left), b = Buffer.concat(right);
  assert.equal(a.length, 16); assert.equal(b.length, 16);
  assert.equal(a.readInt16LE(0), 1234); assert.equal(a.readInt16LE(8), 2468);
  assert.equal(b.readInt16LE(0), -5678); assert.equal(b.readInt16LE(8), -1357);
});

test('four independent discussions on two receivers: stopping one leaves the other three recording', async (t) => {
  const root = await temporary(t), factory = captureFactory();
  const manager = new RecordingManager({ root, config: config(), spawnCapture: factory.spawnCapture });
  await manager.init(); t.after(() => manager.shutdown());
  for (const lane of ['a', 'b', 'c', 'd']) await manager.start(lane);
  assert.equal(factory.captures.size, 2);
  await feed(manager, factory.captures.get('rx1'), 'rx1', stereo(1001, 2002));
  await feed(manager, factory.captures.get('rx2'), 'rx2', stereo(3003, 4004));
  const a = (await manager.stop('a')).recording;
  assert.equal(factory.captures.get('rx1').killed, false);
  assert.equal(manager.status().length, 3);
  await feed(manager, factory.captures.get('rx1'), 'rx1', stereo(5005, 6006));
  const b = (await manager.stop('b')).recording;
  assert.equal(factory.captures.get('rx1').killed, true);
  assert.equal(factory.captures.get('rx2').killed, false);
  const c = (await manager.stop('c')).recording, d = (await manager.stop('d')).recording;
  assert.deepEqual(await samples(root, a), Array(4).fill(1001));
  assert.deepEqual(await samples(root, b), [...Array(4).fill(2002), ...Array(4).fill(6006)]);
  assert.deepEqual(await samples(root, c), Array(4).fill(3003));
  assert.deepEqual(await samples(root, d), Array(4).fill(4004));
  assert.equal(a.status, 'pending'); assert.equal(manager.status().length, 0);
});

test('receiver loss saves interrupted audio while another receiver keeps working; toggles serialize', async (t) => {
  const root = await temporary(t), factory = captureFactory();
  const manager = new RecordingManager({ root, config: config(), spawnCapture: factory.spawnCapture });
  await manager.init(); t.after(() => manager.shutdown());
  const a = (await manager.start('a')).recording;
  await manager.start('c');
  await feed(manager, factory.captures.get('rx1'), 'rx1', stereo(111, 222));
  const saved = new Promise((resolve) => manager.on('pending', (id) => { if (id === a.id) resolve(id); }));
  factory.captures.get('rx1').kill(); await saved;
  assert.equal((await loadRecord(root, a.id)).interrupted, true);
  await feed(manager, factory.captures.get('rx2'), 'rx2', stereo(333, 444));
  const c = (await manager.stop('c')).recording;
  assert.deepEqual(await samples(root, c), Array(4).fill(333));
  await Promise.all([manager.toggle('b'), manager.toggle('b')]);
  assert.equal(manager.status().length, 0);
});

test('mono inputs fail visibly rather than upmixing two supposed discussions', async (t) => {
  const root = await temporary(t), factory = captureFactory();
  const manager = new RecordingManager({ root, config: config(), spawnCapture: factory.spawnCapture });
  await manager.init(); t.after(() => manager.shutdown());
  const first = (await manager.start('a')).recording;
  const stopped = new Promise((resolve) => manager.on('status', (s) => { if (s.state === 'failed') resolve(s); }));
  const child = factory.captures.get('rx1'); child.stderr.write('Stream #0:0: Audio: pcm_s16le, 48000 Hz, mono, s16\n');
  await stopped;
  const record = await loadRecord(root, first.id); assert.equal(record.status, 'failed'); assert.match(record.error, /failed/);
});

test('segment rotation and crash recovery leave valid, ordered, interrupted WAV files', async (t) => {
  const root = await temporary(t), factory = captureFactory();
  const manager = new RecordingManager({ root, config: config({ limits: { segmentSeconds: 1, minFreeBytes: 0 } }), spawnCapture: factory.spawnCapture });
  await manager.init(); t.after(() => manager.shutdown());
  await manager.start('a');
  await feed(manager, factory.captures.get('rx1'), 'rx1', stereo(777, 888, 16003));
  const recorded = (await manager.stop('a')).recording;
  assert.equal(recorded.segments.length, 2); assert.equal((await samples(root, recorded)).length, 16003);
  const crashed = { ...recorded, id: 'rec_' + 'e'.repeat(32), status: 'recording', segments: [{ filename: '00000.wav' }] };
  await saveRecord(root, crashed);
  await writeFile(join(recordDir(root, crashed.id), '00000.wav.partial'), Buffer.concat([wavHeader(0), Buffer.from([1, 0, 2])]));
  await recoverRecordings(root);
  const recovered = await loadRecord(root, crashed.id);
  assert.equal(recovered.status, 'pending'); assert.equal(recovered.interrupted, true);
  assert.deepEqual(await samples(root, recovered), [1]);
  assert.equal(recordingSummary({ ...recovered, intent: { upload: 'secret' } }).intent, undefined);
});

test('disk limit ends only affected channels and preserves the saved audio', async (t) => {
  const root = await temporary(t), factory = captureFactory();
  const manager = new RecordingManager({ root, config: config({ limits: { maxSpoolBytes: 1024, minFreeBytes: 0 } }), spawnCapture: factory.spawnCapture });
  await manager.init(); t.after(() => manager.shutdown());
  await manager.start('a'); await feed(manager, factory.captures.get('rx1'), 'rx1', stereo(7, 8, 100));
  const stopped = new Promise((resolve) => manager.on('pending', resolve));
  await feed(manager, factory.captures.get('rx1'), 'rx1', stereo(7, 8, 500)); await stopped;
  assert.equal(manager.status().length, 0); assert.ok(manager.storedBytes <= 1024);
});

test('instance-local control socket enforces one daemon and independent lane commands', async (t) => {
  const root = await temporary(t), cfg = config(), factory = captureFactory();
  const manager = new RecordingManager({ root, config: cfg, spawnCapture: factory.spawnCapture });
  const uploadQueue = { run: async () => {}, close: async () => {} };
  const daemon = await startRecordingDaemon({ root, config: cfg, manager, uploadQueue, listenInput: false });
  t.after(() => daemon.stop());
  assert.equal((await stat(join(root, 'control.sock'))).mode & 0o777, 0o600);
  await assert.rejects(startRecordingDaemon({ root, config: cfg, listenInput: false }), /already running/);
  await controlRecording(root, 'start', 'a'); await controlRecording(root, 'start', 'b');
  assert.equal((await controlRecording(root, 'status')).active.length, 2);
  await controlRecording(root, 'stop', 'a');
  assert.deepEqual((await controlRecording(root, 'status')).active.map((s) => s.laneId), ['b']);
  await daemon.stop(); await assert.rejects(stat(join(root, 'daemon.lock')), { code: 'ENOENT' });
});

async function pendingRecord(root, extra = {}) {
  const record = { id: 'rec_' + 'f'.repeat(32), machineId: 'test_machine', laneId: 'a', receiverId: 'rx1', channel: 0, label: '讨论 A',
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: 'pending', destination: {}, session: { folder: '~', tool: 'fake-codex' },
    segments: [{ filename: '00000.wav' }], ...extra };
  await saveRecord(root, record); const wav = new WavWriter(join(recordDir(root, record.id), '00000.wav')); await wav.start();
  await wav.append(Buffer.from([123, 0])); await wav.finish(); return record;
}

test('accepted-but-lost replies retry the same request and reuse finalized assets without leaking cookies to storage', async (t) => {
  const root = await temporary(t), record = await pendingRecord(root), requests = [];
  let fail = true, uploads = 0, intents = 0, finalized = false;
  const client = { baseUrl: 'http://remotelab.invalid', ensureAuthCookie: async () => { throw Error('Storage must not receive local auth'); },
    request: async (path, options = {}) => {
      requests.push([path, options.body]); let json;
      if (path === '/api/sessions') json = { session: { id: 'session_recording' } };
      else if (path === '/api/assets/upload-intents') { intents++; json = { asset: { id: 'asset_audio' }, upload: { url: 'https://storage.invalid/audio', headers: {} } }; }
      else if (path.endsWith('/finalize')) { finalized = true; json = { asset: { status: 'ready' } }; }
      else if (path === '/api/assets/asset_audio') json = { asset: { status: finalized ? 'ready' : 'uploading' } };
      else if (path.endsWith('/messages')) { if (fail) { fail = false; throw Error('Reply lost after acceptance'); } json = { duplicate: true, run: { id: 'run_recording' } }; }
      else throw Error('Unexpected route ' + path);
      return { response: { ok: true }, json };
    } };
  const upload = async (url, options) => {
    assert.equal(options.headers.Cookie, undefined); assert.equal(options.redirect, 'manual');
    const data = []; for await (const chunk of options.body) data.push(chunk);
    assert.equal(Buffer.concat(data).length, 46); uploads++;
    return { ok: true, headers: new Headers() };
  };
  await assert.rejects(submitRecording(root, record, { config: config(), client, upload }), /lost/);
  await submitRecording(root, await loadRecord(root, record.id), { config: config(), client, upload });
  const sent = requests.filter(([p]) => p.endsWith('/messages'));
  assert.equal(sent.length, 2); assert.equal(sent[0][1].requestId, sent[1][1].requestId);
  assert.equal(uploads, 1); assert.equal(intents, 1); assert.equal(requests.filter(([p]) => p === '/api/sessions').length, 1);
  const saved = await loadRecord(root, record.id); assert.equal(saved.status, 'submitted'); assert.equal(saved.analysisState, 'accepted');
});

test('service shutdown aborts an in-flight upload without losing its pending manifest', async (t) => {
  const root = await temporary(t), record = await pendingRecord(root);
  let started;
  const entering = new Promise((resolve) => { started = resolve; });
  const queue = new RecordingUploadQueue({ root, config: config(), submit: async (_, __, { signal }) => {
    started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const running = queue.run(); await entering; await queue.close(); await running;
  const saved = await loadRecord(root, record.id); assert.equal(saved.status, 'pending'); assert.equal(saved.attempts, undefined);
});

test('one damaged interrupted header cannot block recovery of other recordings', async (t) => {
  const root = await temporary(t), record = await pendingRecord(root);
  const damaged = { ...record, status: 'recording', id: 'rec_' + '9'.repeat(32) };
  await saveRecord(root, damaged);
  const partial = join(recordDir(root, damaged.id), '00000.wav.partial'); await writeFile(partial, Buffer.from('RIF'));
  await recoverRecordings(root);
  assert.equal((await loadRecord(root, damaged.id)).status, 'failed');
  assert.match((await loadRecord(root, damaged.id)).error, /could not be repaired/);
  assert.equal((await stat(partial)).size, 3);
  assert.equal((await loadRecord(root, record.id)).status, 'pending');
});

test('spawn failures settle capture and incomplete PCM frames do not claim recording', async (t) => {
  const root = await temporary(t), factory = captureFactory();
  const manager = new RecordingManager({ root, config: config(), spawnCapture: factory.spawnCapture });
  await manager.init(); t.after(() => manager.shutdown());
  await manager.start('a');
  await feed(manager, factory.captures.get('rx1'), 'rx1', Buffer.from([1]));
  assert.equal(manager.status()[0].state, 'starting');
  const failed = new Promise((resolve) => manager.on('status', (s) => { if (s.state === 'failed') resolve(s); }));
  const child = factory.captures.get('rx1'); child.emit('error', Error('spawn ffmpeg ENOENT')); child.stdout.end(); child.emit('close');
  await failed; assert.equal(manager.status().length, 0);
});
