import { createReadStream } from 'fs';
import { readdir } from 'fs/promises';
import { extname, join } from 'path';
import readline from 'readline';
import { resolveCodexHomeDir } from '../lib/codex-home.mjs';
import { statOrNull } from './fs-utils.mjs';
import { findCodexSessionLog } from './codex-session-metrics.mjs';

const GENERATED_IMAGE_MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.webp', 'image/webp'],
]);

function normalizeTimestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function isTimestampInWindow(timestampMs, options = {}) {
  if (!Number.isFinite(timestampMs)) return false;
  const startMs = normalizeTimestampMs(options.startedAt);
  const endMs = normalizeTimestampMs(
    options.completedAt
    || options.finalizedAt
    || options.endAt,
  );
  if (Number.isFinite(startMs) && timestampMs < startMs) return false;
  if (Number.isFinite(endMs) && timestampMs > endMs) return false;
  return true;
}

async function readGeneratedImageCallIds(sessionLogPath, options = {}) {
  const callIds = [];
  const seenCallIds = new Set();
  const stream = createReadStream(sessionLogPath, { encoding: 'utf8' });
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const rawLine of input) {
      const line = rawLine.trim();
      if (!line) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const timestampMs = normalizeTimestampMs(record?.timestamp);
      if (!isTimestampInWindow(timestampMs, options)) continue;
      if (record?.type !== 'event_msg' || record?.payload?.type !== 'image_generation_end') {
        continue;
      }

      const callId = typeof record.payload.call_id === 'string'
        ? record.payload.call_id.trim()
        : '';
      if (!callId || !/^[a-zA-Z0-9_-]+$/.test(callId) || seenCallIds.has(callId)) {
        continue;
      }
      seenCallIds.add(callId);
      callIds.push(callId);
    }
  } finally {
    input.close();
    stream.close();
  }

  return callIds;
}

export async function readCodexSessionGeneratedArtifacts(threadId, options = {}) {
  if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(threadId)) return [];
  const sessionLogPath = await findCodexSessionLog(threadId);
  if (!sessionLogPath) return [];
  const callIds = await readGeneratedImageCallIds(sessionLogPath, options);
  if (callIds.length === 0) return [];

  const generatedImagesDir = join(resolveCodexHomeDir(), 'generated_images', threadId);
  let generatedEntries;
  try {
    generatedEntries = await readdir(generatedImagesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const artifacts = [];
  for (const callId of callIds) {
    const matchingEntry = generatedEntries.find((entry) => {
      if (!entry.isFile() || !entry.name.startsWith(`${callId}.`)) return false;
      return GENERATED_IMAGE_MIME_TYPES.has(extname(entry.name).toLowerCase());
    });
    if (!matchingEntry) continue;

    const localPath = join(generatedImagesDir, matchingEntry.name);
    const stats = await statOrNull(localPath);
    if (!stats?.isFile() || !Number.isFinite(stats.size) || stats.size <= 0) continue;
    const extension = extname(matchingEntry.name).toLowerCase();
    const sequence = artifacts.length + 1;
    artifacts.push({
      localPath,
      originalName: `generated-image${sequence > 1 ? `-${sequence}` : ''}${extension}`,
      mimeType: GENERATED_IMAGE_MIME_TYPES.get(extension),
      disposition: 'inline',
      allowInternalPath: true,
      source: 'provider_session',
    });
  }

  return artifacts;
}
