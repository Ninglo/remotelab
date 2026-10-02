import { createServer, createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, createSerialTaskQueue } from '../../chat/fs-utils.mjs';
import { isProcessIdentityAlive, readProcessIdentity } from '../process-identity.mjs';
import { RecordingManager } from './recorder.mjs';
import { listRecords, loadRecord, saveRecord, recoverRecordings, recordingSummary } from './store.mjs';
import { submitRecording } from './transport.mjs';
import { inputCommand, keepAwake } from './platform.mjs';

export async function controlRecording(root, action, laneId) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(root, 'control.sock'));
    let text = '';
    socket.setTimeout(10000, () => socket.destroy(Error('Recording service did not respond')));
    socket.on('connect', () => socket.write(JSON.stringify({ action, laneId }) + '\n'));
    socket.on('data', (chunk) => { text += chunk; if (text.length > 2 * 1024 ** 2) socket.destroy(Error('Recording response is too large')); });
    socket.on('error', reject);
    socket.on('end', () => {
      try { const result = JSON.parse(text); if (result.error) reject(Error(result.error)); else resolve(result); }
      catch (error) { reject(error); }
    });
  });
}
export class RecordingUploadQueue {
  constructor({ root, config, submit = submitRecording, changed = () => {} }) {
    this.root = root; this.config = config; this.submit = submit; this.changed = changed; this.closed = false;
  }
  run() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  async drain() {
    clearTimeout(this.timer);
    try {
      for (const record of await listRecords(this.root)) {
        if (this.closed) break;
        if (record.status !== 'pending' || (record.retryAt && Date.parse(record.retryAt) > Date.now())) continue;
        this.controller = new AbortController();
        try { await this.submit(this.root, record, { config: this.config, signal: this.controller.signal }); }
        catch (error) {
          if (this.closed) break;
          record.attempts = (record.attempts || 0) + 1;
          record.lastError = error.message;
          if (record.attempts >= 6) { record.status = 'blocked'; delete record.retryAt; }
          else record.retryAt = new Date(Date.now() + Math.min(5000, 250 * 2 ** (record.attempts - 1))).toISOString();
          await saveRecord(this.root, record);
        }
        this.changed();
      }
      const pending = (await listRecords(this.root)).filter((r) => r.status === 'pending');
      if (pending.length && !this.closed) {
        const next = Math.min(...pending.map((r) => Date.parse(r.retryAt || '') || Date.now()));
        this.timer = setTimeout(() => this.run().catch((e) => this.changed(e.message)), Math.max(0, next - Date.now()));
      }
    } finally { this.controller = null; }
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.controller?.abort(Error('Recording service stopped')); await this.running; }
}
export async function startRecordingDaemon({ root, config, manager = new RecordingManager({ root, config }), uploadQueue, listenInput = true }) {
  if (!['darwin', 'linux'].includes(process.platform)) throw Error('Recording service supports macOS and Linux');
  if (!config.enabled || !config.lanes.length) throw Error('Enable recording and bind receiver channels before starting');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const lockPath = join(root, 'daemon.lock'), socketPath = join(root, 'control.sock');
  const old = await readJson(lockPath);
  if (old && await isProcessIdentityAlive(old)) throw Error('Recording service is already running for this instance');
  if (old) await rm(lockPath);
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify(await readProcessIdentity(process.pid))); await lock.close();
  let server, input, inputLines, awake, inputError = '';
  const persistQueue = createSerialTaskQueue();
  const persist = (error) => persistQueue(async () => {
    if (error !== undefined) inputError = error;
    return writeJsonAtomic(join(root, 'status.json'), {
    pid: process.pid, enabled: config.enabled, active: manager.status(),
    records: (await listRecords(root)).map(recordingSummary),
    updatedAt: new Date().toISOString(), ...(inputError ? { inputError } : {}),
  }, { mode: 0o600 });
  });
  const queue = uploadQueue || new RecordingUploadQueue({ root, config, changed: (e) => persist(e).catch(() => {}) });
  manager.on('status', () => {
    if (manager.active.size && !awake) awake = keepAwake();
    if (!manager.active.size && awake) { awake.kill(); awake = null; }
    persist().catch(() => {});
  });
  manager.on('fault', (e) => persist(e).catch(() => {}));
  manager.on('pending', () => queue.run().catch((e) => persist(e).catch(() => {})));
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    await queue.close(); inputLines?.close(); input?.kill(); awake?.kill();
    await manager.shutdown();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true }); await rm(lockPath, { force: true });
    await persist();
  };
  try {
    await recoverRecordings(root); await manager.init(); await rm(socketPath, { force: true });
    server = createServer((socket) => {
      let text = '';
      socket.setTimeout(10000, () => socket.destroy());
      socket.on('data', (chunk) => {
        text += chunk;
        if (text.length > 4096) { socket.destroy(); return; }
        if (!text.includes('\n')) return;
        socket.pause();
        socket.removeAllListeners('data');
        (async () => {
          const message = JSON.parse(text.split('\n')[0]);
          let result;
          if (['start', 'stop', 'toggle'].includes(message.action)) result = await manager[message.action](message.laneId);
          else if (message.action === 'status') result = { active: manager.status(), records: (await listRecords(root)).map(recordingSummary), ...(inputError ? { inputError } : {}) };
          else if (message.action === 'retry') {
            if (queue.running) throw Error('Wait for the current upload to finish before retrying');
            const record = await loadRecord(root, message.laneId);
            if (!['pending', 'blocked'].includes(record.status)) throw Error('Only saved, unsubmitted recordings can retry');
            record.status = 'pending'; record.attempts = 0; delete record.retryAt;
            await saveRecord(root, record); queue.run().catch(() => {}); result = { recording: recordingSummary(record) };
          } else throw Error('Unknown recording action');
          await persist(); socket.end(JSON.stringify(result) + '\n');
        })().catch((error) => socket.end(JSON.stringify({ error: error.message }) + '\n'));
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    if (listenInput && config.bindings.length) {
      try {
        const spec = await inputCommand(root, config.bindings);
        input = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
        input.on('error', (e) => persist(e.message).catch(() => {}));
        input.on('close', (code) => { if (!stopped) persist(`Keypad listener stopped (${code}); CLI start/stop remains available`).catch(() => {}); });
        const debounce = new Map();
        inputLines = createInterface({ input: input.stdout });
        inputLines.on('line', (line) => {
          try {
            const event = JSON.parse(line);
            if (event.error) { persist(event.error).catch(() => {}); return; }
            if (!event.pressed) return;
            const binding = config.bindings.find((b) => b.deviceId === event.deviceId && b.key === event.key);
            if (!binding) return;
            const identity = `${event.deviceId}:${event.key}`;
            if (Date.now() - (debounce.get(identity) || 0) < 250) return;
            debounce.set(identity, Date.now());
            manager[binding.action](binding.laneId).then(() => persist()).catch((e) => persist(e.message).catch(() => {}));
          } catch (error) { persist(error.message).catch(() => {}); }
        });
      } catch (error) { await persist(error.message); }
    }
    await persist(); queue.run().catch((e) => persist(e.message).catch(() => {}));
    return { stop, server, manager, queue };
  } catch (error) { await stop(); throw error; }
}
