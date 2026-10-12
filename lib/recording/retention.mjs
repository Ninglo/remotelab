import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { listRecords, loadRecord, recordDir, saveRecord } from './store.mjs';
import { createRemoteLabHttpClient } from '../remotelab-http-client.mjs';

const DAY = 86400000;
// Disabled by default. A new policy first keeps a full observation window.
// A submitted manifest alone is insufficient: recheck every remote audio asset.
export async function pruneUploadedRecordings(root, config, { now = Date.now(), verifyAsset } = {}) {
  const policy = config.retention;
  const started = Date.parse(policy?.startedAt || '');
  const result = { removed: [], skipped: [], errors: [] };
  if (!policy?.days || !Number.isFinite(started) || now < started + policy.days * DAY) return result;
  for (const candidate of await listRecords(root)) {
    if (candidate.status !== 'submitted' || candidate.submissionMode === 'local' || candidate.localAudioRemovedAt) continue;
    const ended = Date.parse(candidate.endedAt || '');
    if (!Number.isFinite(ended) || now - ended < policy.days * DAY) continue;
    const id = candidate.id;
    try {
      const record = await loadRecord(root, id);
      const segments = record.segments || [];
      if (record.status !== 'submitted' || !record.submittedAt || !record.runId || !segments.length
        || (record.destination?.publishAudio && !record.audioPublishedAt)
        || segments.some(s => !/^\d{5}\.wav$/.test(s.filename) || !s.assetId || !s.ready)) {
        result.skipped.push(id); continue;
      }
      const dir = recordDir(root, id);
      if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) { result.skipped.push(id); continue; }
      const names = await readdir(dir);
      if (names.some(name => name.endsWith('.partial') || (/\.wav$/.test(name) && !segments.some(s => s.filename === name)))) {
        result.skipped.push(id); continue;
      }
      const client = verifyAsset ? null : createRemoteLabHttpClient({ baseUrl: record.baseUrl });
      const verified = [];
      for (const segment of segments) {
        const path = join(dir, segment.filename);
        let local;
        try { local = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (local && (!local.isFile() || local.isSymbolicLink())) throw Error('Audio is not a regular file');
        const response = verifyAsset ? await verifyAsset(record, segment) : await client.request(`/api/assets/${encodeURIComponent(segment.assetId)}`, { signal: AbortSignal.timeout(10000) });
        const asset = verifyAsset ? response : response.response.ok ? response.json?.asset : null;
        if (!asset || asset.id !== segment.assetId || asset.status !== 'ready' || asset.sessionId !== record.sessionId
          || !(asset.sizeBytes > 44) || (local && asset.sizeBytes !== local.size)) throw Error('Remote audio copy could not be verified');
        verified.push({ path, filename: segment.filename, assetId: asset.id, sizeBytes: asset.sizeBytes });
      }
      // Save verification before deletion; reruns recover a partially completed prune.
      record.retentionVerification = { at: new Date(now).toISOString(), days: policy.days, assets: verified.map(({ path, ...value }) => value) };
      await saveRecord(root, record);
      for (const file of verified) { try { await unlink(file.path); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      record.localAudioRemovedAt = new Date(now).toISOString();
      await saveRecord(root, record); result.removed.push(id);
    } catch (error) { result.errors.push({ id, error: error.message }); }
  }
  return result;
}
