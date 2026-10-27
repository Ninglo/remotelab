import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readRecord, serialQueue, writeDurableJson } from '../../lib/durable-records.mjs';

const exec = promisify(execFile);
export const meetingSourceId = id => `feishu-meeting:${id}`;
export function meetingIntakeKey(route, chat, id) {
  // The existing intake registry uses Python json.dumps's spaced separators.
  return createHash('sha256').update(`[${[route, chat, meetingSourceId(id)].map(x => JSON.stringify(x)).join(', ')}]`).digest('hex').slice(0, 24);
}

// Reuse the instance's existing versioned intake registry, including its lock,
// file hashes and readback. The producer owns pipeline metadata only; consumers
// retain their analysis, action and consumption results.
export function createMeetingIntakeWriter(runtime, options = {}) {
  const queue = serialQueue();
  const run = options.exec || exec;
  return (record, policy) => queue(async () => {
    const config = policy?.intake;
    if (!config?.root || !config?.scriptPath) return null;
    if (!config.root.startsWith('/') || !config.scriptPath.startsWith('/')) throw Error('Meeting intake paths must be absolute');
    const route = runtime.config.sourceRouteId || 'default';
    const key = meetingIntakeKey(route, record.chatId, record.meetingId);
    const target = join(config.root, 'records', `${key}.json`);
    const bundle = join(runtime.config.storageDir, 'meeting-ingest', 'materials', record.meetingId);
    const sourcePath = join(bundle, 'intake-source.json');
    const inputPath = join(bundle, 'intake-input.json');
    const receipt = record.archive || record.analysis;
    const pipeline = {
      meetingId: record.meetingId, status: record.status,
      lastAttemptAt: record.lastAttemptAt, materialDeadline: record.materialDeadline,
      failure: record.failure || null, requestId: receipt?.requestId, sessionId: receipt?.sessionId,
      messageId: record.messageId, threadId: record.threadId,
      scopePath: join(runtime.config.storageDir, 'meeting-ingest', 'scope', `${record.meetingId}.json`),
      retryCommand: `node scripts/feishu-meeting-ingest.mjs retry --storage-dir ${runtime.config.storageDir} --meeting-id ${record.meetingId}`,
      admissionIsCompletion: false,
    };
    await writeDurableJson(sourcePath, { discovery: record.discovery, material: record.material, pipeline });
    // A concurrent consumer can finish while this worker is saving metadata.
    // Re-read and merge on the registry's explicit version conflict only.
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = await readRecord(target);
      const files = { ...old?.files, source: sourcePath };
      if (record.material?.sourcePath) files.material_source = record.material.sourcePath;
      if (record.material?.transcriptPath) {
        files.transcript = record.material.transcriptPath;
        files.original ||= record.material.transcriptPath;
      }
      const hasTranscript = !!files.transcript;
      const failed = ['permission_denied', 'material_deadline_expired'].includes(record.status)
        || (record.status === 'waiting_material' && record.attempts >= 12);
      const stages = { capture: hasTranscript ? 'complete' : 'partial',
        transcription: hasTranscript ? 'complete' : failed ? 'failed' : 'pending',
        analysis: old?.stages?.analysis || 'pending' };
      const gaps = (old?.gaps || []).filter(gap => !String(gap).startsWith('meeting-ingest:'));
      if (!hasTranscript) gaps.push(`meeting-ingest: ${record.status}; ${record.failure?.message || '等待取得完整原文'}`);
      const value = { ...old, source: { ...old?.source, id: meetingSourceId(record.meetingId), kind: 'feishu_meeting',
        route_id: route, chat_id: record.chatId, meeting_id: record.meetingId,
        ...(receipt ? { session_id: receipt.sessionId, request_id: receipt.requestId } : {}),
        ...(record.messageId ? { message_id: record.messageId, thread_id: record.threadId } : {}) },
        received_at: old?.received_at || record.discovery.discoveryEvents?.at(-1)?.receivedAt || new Date().toISOString(),
        title: record.discovery.topic || `会议 ${record.meetingId}`, bundle_dir: bundle,
        files, stages, gaps, consumption: old?.consumption || { status: 'pending', receipts: [] }, pipeline };
      await writeDurableJson(inputPath, value);
      try {
        const { stdout } = await run('python3', [config.scriptPath, 'register', '--record', inputPath,
          '--root', config.root, '--expected-version', String(old?.version || 0)], { timeout: 60000, maxBuffer: 1024 * 1024 });
        const result = JSON.parse(stdout);
        return { ...result, sourceId: meetingSourceId(record.meetingId) };
      } catch (error) {
        if (attempt === 2 || !String(error.stderr || '').includes('version conflict')) throw error;
      }
    }
  });
}
