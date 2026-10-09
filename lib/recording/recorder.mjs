import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createSerialTaskQueue } from '../../chat/fs-utils.mjs';
import { SAMPLE_RATE } from './config.mjs';
import { StereoSplitter, WavWriter } from './pcm.mjs';
import { recordDir, saveRecord, spoolBytes } from './store.mjs';

export function captureArgs(receiver) {
  const input = receiver.backend === 'avfoundation'
    ? ['-f', 'avfoundation', '-audio_device_id', receiver.source, '-i', 'none:none']
    : ['-f', receiver.backend, '-i', receiver.source];
  // Keep both channels; split to mono only after the receiver stream is read.
  return ['-nostdin', '-hide_banner', '-loglevel', 'info', ...input, '-vn', '-ac', '2', '-ar', String(SAMPLE_RATE), '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
}
export class RecordingManager extends EventEmitter {
  constructor({ root, config, spawnCapture = (r) => spawn(config.ffmpeg, captureArgs(r), { stdio: ['ignore', 'pipe', 'pipe'] }) }) {
    super(); this.root = root; this.config = config; this.spawnCapture = spawnCapture;
    this.receivers = new Map(); this.active = new Map(); this.serial = createSerialTaskQueue(); this.storedBytes = 0;
  }
  async init() { this.storedBytes = await spoolBytes(this.root); }
  async spaceCheck() {
    if (this.storedBytes >= this.config.limits.maxSpoolBytes) throw Error('Recording cache is full; preserve or remove delivered recordings before continuing');
    if (!fs.statfs) throw Error('Hardware recording requires Node.js 18.15 or newer for disk-space checks');
    const disk = await fs.statfs(this.root);
    if (Number(disk.bavail) * Number(disk.bsize) < this.config.limits.minFreeBytes) throw Error('Not enough free disk space for recording');
  }
  start(laneId) { return this.serial(() => this.startLane(laneId)); }
  async startLane(laneId) {
      if (!this.config.enabled) throw Error('Recording is disabled');
      const lane = this.config.lanes.find((l) => l.id === laneId);
      if (!lane) throw Error('Unknown recording lane');
      if (this.active.has(laneId)) return { duplicate: true, recording: this.active.get(laneId).record };
      await this.spaceCheck();
      const record = {
        id: `rec_${randomUUID().replaceAll('-', '')}`, machineId: this.config.machineId,
        laneId, receiverId: lane.receiverId, channel: lane.channel, label: lane.label,
        destination: structuredClone({ ...(lane.sessionId ? { sessionId: lane.sessionId } : {}), ...(lane.conversation ? { conversation: lane.conversation } : {}), ...(lane.publishAudio ? { publishAudio: true } : {}) }),
        session: { ...this.config.session }, baseUrl: this.config.baseUrl,
        submissionMode: this.config.submissionMode || 'automatic',
        status: 'recording', startedAt: new Date().toISOString(), segments: [], sampleRate: SAMPLE_RATE,
      };
      await saveRecord(this.root, record);
      const active = { record, lane, writer: null, segment: 0, audioBytes: 0 };
      try { await this.openSegment(active); }
      catch (error) {
        record.status = 'failed'; record.error = error.message; record.endedAt = new Date().toISOString();
        await saveRecord(this.root, record); this.emit('status', { laneId, state: 'failed', error: error.message }); throw error;
      }
      this.active.set(laneId, active);
      try { if (!this.receivers.has(lane.receiverId)) this.openReceiver(lane.receiverId); }
      catch (error) { await this.finishLane(laneId, error.message); throw error; }
      active.deadline = setTimeout(() => { this.stop(laneId, 'Maximum recording duration reached').catch((e) => this.emit('fault', e.message)); }, this.config.limits.maxRecordingSeconds * 1000);
      this.emit('status', { laneId, state: 'starting', recordingId: record.id });
      return { recording: record };
  }
  async openSegment(active) {
    if (this.storedBytes + 44 > this.config.limits.maxSpoolBytes) throw Error('Recording cache limit reached');
    const filename = `${String(active.segment++).padStart(5, '0')}.wav`;
    active.writer = new WavWriter(join(recordDir(this.root, active.record.id), filename));
    await active.writer.start(); this.storedBytes += 44;
    active.record.segments.push({ filename });
    await saveRecord(this.root, active.record);
  }
  openReceiver(id) {
    const receiver = this.config.receivers.find((r) => r.id === id);
    const child = this.spawnCapture(receiver);
    const entry = { child, stopping: false, stderr: '', splitter: new StereoSplitter() };
    entry.format = new Promise((resolve) => { entry.resolveFormat = resolve; });
    entry.exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
    entry.formatTimer = setTimeout(() => entry.resolveFormat(false), 5000);
    this.receivers.set(id, entry);
    child.stderr?.on('data', (chunk) => {
      entry.stderr = (entry.stderr + chunk.toString()).slice(-8192);
      // Never silently upmix a mono receiver: M/Ms mode cannot isolate two meetings.
      const format = /Audio:([^\n]*)/.exec(entry.stderr);
      if (format && !entry.formatResolved) {
        entry.formatResolved = true; clearTimeout(entry.formatTimer);
        const stereo = /\bstereo\b|2 channels/.test(format[1]);
        entry.resolveFormat(stereo);
        if (!stereo) child.kill('SIGTERM');
      }
    });
    child.on('error', (error) => { entry.stderr = error.message; clearTimeout(entry.formatTimer); entry.resolveFormat(false); });
    entry.drained = (async () => {
      try {
        for await (const chunk of child.stdout) {
          await this.serial(async () => {
            if (entry.stopping || this.receivers.get(id) !== entry) return;
            if (!await entry.format) throw Error('Receiver did not confirm a stereo input; configure S mode before recording');
            const channels = entry.splitter.split(chunk);
            const lanes = [...this.active.values()].filter((a) => a.lane.receiverId === id);
            for (const active of lanes) {
              try {
                if (!channels[active.lane.channel].length) continue;
                if (this.storedBytes + channels[active.lane.channel].length > this.config.limits.maxSpoolBytes) throw Error('Recording cache limit reached');
                await this.append(active, channels[active.lane.channel]);
                if (!active.started) {
                  active.started = true;
                  this.emit('status', { laneId: active.lane.id, state: 'recording', recordingId: active.record.id });
                }
              } catch (error) { await this.finishLane(active.lane.id, error.message); }
            }
            this.emit('audio', { receiverId: id, bytes: chunk.length });
          });
        }
      } catch (error) { entry.stderr = error.message; child.kill('SIGTERM'); }
    })();
    child.on('close', () => {
      clearTimeout(entry.formatTimer); entry.resolveFormat(false);
      entry.drained.then(() => this.serial(async () => {
        if (this.receivers.get(id) !== entry) return;
        this.receivers.delete(id);
        if (entry.stopping) return;
        for (const [laneId, active] of this.active) {
          if (active.lane.receiverId === id) await this.finishLane(laneId, `Receiver disconnected or capture failed: ${entry.stderr.slice(-1000)}`);
        }
      })).catch((e) => this.emit('fault', e.message));
    });
  }
  async append(active, data) {
    const maxBytes = this.config.limits.segmentSeconds * SAMPLE_RATE * 2;
    let offset = 0;
    while (offset < data.length) {
      if (active.writer.bytes === maxBytes) {
        await active.writer.finish(); await this.spaceCheck(); await this.openSegment(active);
      }
      const size = Math.min(data.length - offset, maxBytes - active.writer.bytes);
      await active.writer.append(data.subarray(offset, offset + size));
      active.audioBytes += size;
      this.storedBytes += size; offset += size;
    }
  }
  async finishLane(laneId, reason = '') {
    const active = this.active.get(laneId);
    if (!active) return null;
    clearTimeout(active.deadline); this.active.delete(laneId);
    try { await active.writer.finish(); }
    catch (error) { reason = reason || error.message; }
    const record = active.record;
    const hasAudio = active.audioBytes > 0;
    record.status = hasAudio ? (record.submissionMode === 'local' ? 'held' : 'pending') : 'failed';
    record.endedAt = new Date().toISOString();
    if (reason) { record.interrupted = true; record.error = reason; }
    await saveRecord(this.root, record);
    this.emit('status', { laneId, state: record.status, recordingId: record.id, ...(reason ? { error: reason } : {}) });
    if (record.status === 'pending') this.emit('pending', record.id);
    const receiver = this.receivers.get(active.lane.receiverId);
    if (receiver && ![...this.active.values()].some((a) => a.lane.receiverId === active.lane.receiverId)) {
      receiver.stopping = true; this.receivers.delete(active.lane.receiverId); receiver.child.kill('SIGTERM');
      const killTimer = setTimeout(() => receiver.child.kill('SIGKILL'), 1500);
      await receiver.exited; clearTimeout(killTimer);
    }
    return record;
  }
  stop(laneId, reason = '') { return this.serial(async () => ({ recording: await this.finishLane(laneId, reason) })); }
  toggle(laneId) { return this.serial(async () => this.active.has(laneId) ? { recording: await this.finishLane(laneId) } : this.startLane(laneId)); }
  status() { return [...this.active.values()].map((a) => ({ laneId: a.lane.id, recordingId: a.record.id, startedAt: a.record.startedAt, state: a.started ? 'recording' : 'starting' })); }
  async shutdown() { for (const laneId of [...this.active.keys()]) await this.stop(laneId, 'Recording service stopped'); }
}
