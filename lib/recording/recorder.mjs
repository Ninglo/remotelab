import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createSerialTaskQueue } from '../../chat/fs-utils.mjs';
import { SAMPLE_RATE } from './config.mjs';
import { StereoSplitter, WavWriter } from './pcm.mjs';
import { pcmMeter } from './meter.mjs';
import { AutoChannelSelector } from './auto-channel.mjs';
import { recordDir, saveRecord, spoolBytes, finalizeRecordingStatus } from './store.mjs';

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
      const peers = [...this.active.values()].filter(a => a.lane.receiverId === lane.receiverId);
      const available = [0, 1].filter(channel => !peers.some(a => a.channel === channel));
      if (lane.channel === 'auto') {
        if (!available.length) throw Error('两只麦克风都在录音，请先结束其中一段');
        if (peers.some(a => a.channel === null)) throw Error('请先对上一段使用的麦克风说话，听到开始提示后再开始第二段');
      } else if (!available.includes(lane.channel)) throw Error('这只麦克风已被另一段录音使用');
      await this.spaceCheck();
      const record = {
        id: `rec_${randomUUID().replaceAll('-', '')}`, machineId: this.config.machineId,
        laneId, receiverId: lane.receiverId, channel: lane.channel === 'auto' ? null : lane.channel, label: lane.label,
        ...(lane.channel === 'auto' ? { channelSelection: 'auto' } : lane.deviceLabel ? { deviceLabel: lane.deviceLabel } : {}),
        destination: structuredClone({ ...(lane.sessionId ? { sessionId: lane.sessionId } : {}), ...(lane.conversation ? { conversation: lane.conversation } : {}), ...(lane.publishAudio ? { publishAudio: true } : {}) }),
        session: { ...this.config.session }, baseUrl: this.config.baseUrl,
        submissionMode: this.config.submissionMode || 'automatic',
        minUploadSeconds: this.config.minUploadSeconds || 0,
        status: 'recording', startedAt: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, segments: [], sampleRate: SAMPLE_RATE,
      };
      await saveRecord(this.root, record);
      const active = { record, lane, channel: record.channel, writer: null, segment: 0, audioBytes: 0 };
      if (lane.channel === 'auto') {
        active.selector = new AutoChannelSelector(this.config.autoSelect);
        active.preRoll = [Buffer.alloc(0), Buffer.alloc(0)];
      }
      try { await this.openSegment(active); }
      catch (error) {
        record.status = 'failed'; record.error = error.message; record.endedAt = new Date().toISOString();
        await saveRecord(this.root, record); this.emit('status', { laneId, state: 'failed', error: error.message }); throw error;
      }
      this.active.set(laneId, active);
      try { if (!this.receivers.has(lane.receiverId)) this.openReceiver(lane.receiverId); }
      catch (error) { await this.finishLane(laneId, error.message); throw error; }
      active.deadline = setTimeout(() => { this.stop(laneId, 'Maximum recording duration reached').catch((e) => this.emit('fault', e.message)); }, this.config.limits.maxRecordingSeconds * 1000);
      if (active.selector) active.selectionDeadline = setTimeout(() => {
        this.stop(laneId, '未能确认使用哪只麦：请将要用的麦靠近嘴边说话，另一只放远后重试').catch(e => this.emit('fault', e.message));
      }, this.config.autoSelect.timeoutSeconds * 1000);
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
                let data;
                if (active.channel === null) {
                  // Only memory is buffered until one source is identified. Never
                  // write an undecided mixture or audio from the other discussion.
                  const available = [0, 1].filter(ch => !lanes.some(a => a !== active && a.channel === ch));
                  const selected = active.selector.accept(channels, available);
                  if (selected === null) {
                    const maxPreRoll = (this.config.autoSelect.confirmMs / 1000 + 1) * SAMPLE_RATE * 2;
                    active.preRoll = channels.map((chunk, ch) => Buffer.from(Buffer.concat([active.preRoll[ch], chunk]).subarray(-maxPreRoll)));
                    continue;
                  }
                  active.channel = selected; active.record.channel = selected;
                  active.record.deviceLabel = `${active.lane.label} · ${selected === 0 ? '左' : '右'}声道麦`;
                  active.record.selectedAt = new Date().toISOString();
                  data = Buffer.concat([active.preRoll[selected], channels[selected]]);
                  active.record.requestedAt = active.record.startedAt;
                  active.record.startedAt = new Date(Date.now() - data.length / (SAMPLE_RATE * 2) * 1000).toISOString();
                  delete active.preRoll; delete active.selector; clearTimeout(active.selectionDeadline);
                  await saveRecord(this.root, active.record);
                } else data = channels[active.channel];
                if (!data.length) continue;
                if (this.storedBytes + data.length > this.config.limits.maxSpoolBytes) throw Error('Recording cache limit reached');
                await this.append(active, data);
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
    active.meter = pcmMeter(data);
    active.meter.updatedAt = Date.now();
    if (!active.lastMeterAt || active.meter.updatedAt - active.lastMeterAt >= 100) {
      active.lastMeterAt = active.meter.updatedAt;
      this.emit('meter');
    }
  }
  meters() {
    return [...this.active.values()].filter((a) => a.meter).map((a) => ({ laneId: a.lane.id, recordingId: a.record.id, ...a.meter }));
  }
  async finishLane(laneId, reason = '') {
    const active = this.active.get(laneId);
    if (!active) return null;
    clearTimeout(active.deadline); clearTimeout(active.selectionDeadline); this.active.delete(laneId); this.emit('meter');
    try { await active.writer.finish(); }
    catch (error) { reason = reason || error.message; }
    const record = active.record;
    finalizeRecordingStatus(record, active.audioBytes);
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
  status() { return [...this.active.values()].map((a) => ({ laneId: a.lane.id, recordingId: a.record.id, startedAt: a.record.startedAt, channel: a.channel,
    state: a.started ? 'recording' : a.channel === null ? 'selecting' : 'starting' })); }
  async shutdown() { for (const laneId of [...this.active.keys()]) await this.stop(laneId, 'Recording service stopped'); }
}
