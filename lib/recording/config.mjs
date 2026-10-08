import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdir, readFile, chmod } from 'node:fs/promises';
import { CONFIG_DIR } from '../config.mjs';
import { writeJsonAtomic } from '../../chat/fs-utils.mjs';

export const SAMPLE_RATE = 16000;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export function recordingRoot(override) { return resolve(override || join(CONFIG_DIR, 'recording')); }
export function requireId(value, label = 'id') {
  if (typeof value !== 'string' || !idPattern.test(value)) throw Error(`Invalid ${label}`);
  return value;
}
function integer(value, fallback, min, max, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw Error(`Invalid ${label}`);
  return result;
}
export function normalizeRecordingConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Recording config must be an object');
  for (const key of ['receivers', 'lanes', 'bindings']) if (value[key] !== undefined && !Array.isArray(value[key])) throw Error(`${key} must be an array`);
  if (value.baseUrl) {
    const url = new URL(value.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Use the RemoteLab instance base URL without credentials or a path');
  }
  const receivers = (value.receivers || []).map((r) => {
    const id = requireId(r.id, 'receiver id');
    if (!['avfoundation', 'alsa', 'pulse'].includes(r.backend)) throw Error(`Unsupported audio backend for ${id}`);
    const source = typeof r.source === 'string' ? r.source.trim() : '';
    if (!source || ['default', ':0', '0'].includes(source)) throw Error(`Bind ${id} to an explicit audio device, not the system default`);
    if (r.backend === 'avfoundation' && !/^(uid|serial):.+/.test(source)) throw Error(`Use uid: or serial: for ${id}; numeric indexes are not durable device identities`);
    if (r.backend === 'alsa' && /^(?:plug)?hw:\d/.test(source)) throw Error(`Use a named ALSA card for ${id}, not a changing numeric card index`);
    return { id, backend: r.backend, source };
  });
  if (new Set(receivers.map((r) => r.id)).size !== receivers.length) throw Error('Duplicate receiver id');
  if (new Set(receivers.map((r) => `${r.backend}:${r.source}`)).size !== receivers.length) throw Error('The same receiver cannot be opened twice');
  const lanes = (value.lanes || []).map((lane) => {
    const id = requireId(lane.id, 'lane id');
    if (!receivers.some((r) => r.id === lane.receiverId)) throw Error(`Unknown receiver for ${id}`);
    if (![0, 1].includes(lane.channel)) throw Error(`Channel for ${id} must be 0 (left) or 1 (right)`);
    if (lane.sessionId && !/^[a-zA-Z0-9_-]{1,128}$/.test(lane.sessionId)) throw Error(`Invalid session id for ${id}`);
    if (lane.conversation && lane.sessionId) throw Error(`Bind ${id} either to a Session or a new Session conversation`);
    return {
      id, receiverId: lane.receiverId, channel: lane.channel,
      label: String(lane.label || id).slice(0, 120),
      ...(lane.sessionId ? { sessionId: lane.sessionId } : {}),
      ...(lane.conversation ? { conversation: lane.conversation } : {}),
    };
  });
  if (new Set(lanes.map((r) => r.id)).size !== lanes.length) throw Error('Duplicate lane id');
  if (new Set(lanes.map((r) => `${r.receiverId}:${r.channel}`)).size !== lanes.length) throw Error('Each receiver channel can belong to only one lane');
  const bindings = (value.bindings || []).map((b) => {
    if (typeof b.deviceId !== 'string' || !b.deviceId || b.deviceId.length > 512) throw Error('A keypad binding needs a device id');
    if (!lanes.some((l) => l.id === b.laneId)) throw Error('Unknown lane in keypad binding');
    const key = integer(b.key, null, 1, 65535, 'key');
    const action = b.action || 'toggle';
    if (!['start', 'stop', 'toggle'].includes(action)) throw Error('Invalid keypad action');
    return { deviceId: b.deviceId, key, laneId: b.laneId, action };
  });
  if (new Set(bindings.map((b) => `${b.deviceId}:${b.key}`)).size !== bindings.length) throw Error('A keypad button can control only one lane');
  const session = value.session || {};
  if (session.tool && !idPattern.test(session.tool)) throw Error('Invalid recording Session tool');
  const submissionMode = value.submissionMode ?? 'automatic';
  if (!['automatic', 'local'].includes(submissionMode)) throw Error('Invalid recording submission mode');
  return {
    version: 1,
    enabled: value.enabled === true,
    submissionMode,
    machineId: requireId(value.machineId || `machine_${randomUUID().replaceAll('-', '')}`, 'machine id'),
    baseUrl: String(value.baseUrl || process.env.REMOTELAB_CHAT_BASE_URL || '').replace(/\/+$/, ''),
    ffmpeg: String(value.ffmpeg || 'ffmpeg'),
    receivers, lanes, bindings,
    session: { folder: String(session.folder || '~'), ...(session.tool ? { tool: session.tool } : {}) },
    limits: {
      segmentSeconds: integer(value.limits?.segmentSeconds, 300, 1, 1800, 'segmentSeconds'),
      maxSpoolBytes: integer(value.limits?.maxSpoolBytes, 5 * 1024 ** 3, 1024, 1024 ** 4, 'maxSpoolBytes'),
      minFreeBytes: integer(value.limits?.minFreeBytes, 512 * 1024 ** 2, 0, 1024 ** 4, 'minFreeBytes'),
      maxRecordingSeconds: integer(value.limits?.maxRecordingSeconds, 6 * 3600, 1, 24 * 3600, 'maxRecordingSeconds'),
      uploadBytesPerSecond: integer(value.limits?.uploadBytesPerSecond, 256 * 1024, 1024, 100 * 1024 ** 2, 'uploadBytesPerSecond'),
    },
  };
}
export async function readRecordingConfig(root) {
  try { return normalizeRecordingConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return normalizeRecordingConfig({});
    throw error;
  }
}
export async function saveRecordingConfig(root, value) {
  const config = normalizeRecordingConfig(value);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await writeJsonAtomic(join(root, 'config.json'), config, { mode: 0o600 });
  return config;
}
