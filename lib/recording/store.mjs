import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../chat/fs-utils.mjs';
import { requireId, SAMPLE_RATE } from './config.mjs';
import { recoverPartialWav } from './pcm.mjs';

// Use saved mono PCM duration, not button timing or speech recognition. The
// threshold is snapshotted at capture start so restart/config changes cannot
// accidentally release a short recording.
export function finalizeRecordingStatus(record, audioBytes) {
  record.durationSeconds = audioBytes / (SAMPLE_RATE * 2);
  const short = record.minUploadSeconds > 0 && record.durationSeconds <= record.minUploadSeconds;
  if (audioBytes > 0 && short) record.holdReason = 'short-recording';
  record.status = audioBytes > 0
    ? (record.submissionMode === 'local' || short ? 'held' : 'pending') : 'failed';
}

export function recordDir(root, id) { return join(root, 'records', requireId(id, 'recording id')); }
export async function saveRecord(root, record) {
  const dir = recordDir(root, record.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(dir, 'record.json'), record, { mode: 0o600 });
}
export async function loadRecord(root, id) {
  return JSON.parse(await readFile(join(recordDir(root, id), 'record.json'), 'utf8'));
}
export async function listRecords(root) {
  let entries;
  try { entries = await readdir(join(root, 'records')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const id of entries.filter((id) => /^rec_[a-f0-9]{32}$/.test(id))) {
    try { records.push(await loadRecord(root, id)); }
    catch (error) { records.push({ id, status: 'failed', error: `Cannot read recording manifest: ${error.message}` }); }
  }
  return records.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
}
// Signed upload intents stay in the private manifest, never in ordinary status output.
export function recordingSummary(record) {
  const { id, label, laneId, receiverId, channel, status, startedAt, endedAt, sessionId, runId, analysisState, lastError, error, interrupted, audioPublishedAt, durationSeconds, holdReason } = record;
  return { id, label, laneId, receiverId, channel, status, startedAt, endedAt, sessionId, runId, analysisState, lastError, error, interrupted, audioPublishedAt, durationSeconds, holdReason,
    publishAudio: record.destination?.publishAudio === true,
    speakers: (record.speakers || []).filter((s) => s?.verified === true && typeof s.name === 'string').map((s) => ({ name: s.name, verified: true })) };
}
export async function spoolBytes(root) {
  let size = 0;
  for (const record of await listRecords(root)) {
    const dir = recordDir(root, record.id);
    for (const name of await readdir(dir)) if (/\.wav(?:\.partial)?$/.test(name)) size += (await stat(join(dir, name))).size;
  }
  return size;
}
export async function recoverRecordings(root) {
  for (const record of await listRecords(root)) {
    if (record.status !== 'recording') continue;
    const dir = recordDir(root, record.id);
    let repairError = '';
    for (const name of await readdir(dir)) {
      if (/^\d{5}\.wav\.partial$/.test(name)) {
        try { await recoverPartialWav(join(dir, name.replace(/\.partial$/, ''))); }
        catch (error) { repairError = `; ${name} was preserved but could not be repaired: ${error.message}`; }
      }
    }
    record.segments = (await readdir(dir)).filter((name) => /^\d{5}\.wav$/.test(name)).sort().map((filename) => ({
      ...(record.segments.find((s) => s.filename === filename) || {}), filename,
    }));
    const sizes = await Promise.all(record.segments.map((s) => stat(join(dir, s.filename))));
    finalizeRecordingStatus(record, sizes.reduce((total, s) => total + Math.max(0, s.size - 44), 0));
    record.interrupted = true;
    record.error = 'Recording service stopped before the recording was closed' + repairError;
    record.endedAt = new Date().toISOString();
    await saveRecord(root, record);
  }
}
