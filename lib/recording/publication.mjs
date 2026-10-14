import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, stat, statfs, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { wavHeader } from './pcm.mjs';
import { recordDir } from './store.mjs';
import { recordingFileName } from './file-name.mjs';

const exec = promisify(execFile);
// Match the Connector's attachment ceiling; reserve room for MP3 headers.
export const PUBLICATION_MAX_BYTES = 30 * 1024 ** 2;
export function publicationBitrate(seconds) {
  const bitrate = [48, 40, 32, 24, 16, 8].find(k => (seconds + 1) * k * 1000 / 8 < 29 * 1024 ** 2);
  if (!bitrate) throw Error('Recording is too long for one Feishu audio attachment; originals remain saved');
  return bitrate;
}

// Only finalized recorder WAVs are accepted. FFmpeg concatenates their PCM
// before encoding once, avoiding padding/gaps at the original segment joins.
export async function preparePublicationAudio(root, record, { config, signal } = {}) {
  const dir = recordDir(root, record.id);
  let pcmBytes = 0;
  const inputs = [];
  for (const segment of record.segments) {
    if (!/^\d{5}\.wav$/.test(segment.filename)) throw Error('Invalid recording segment filename');
    const path = join(dir, segment.filename);
    const file = await open(path, 'r');
    try {
      const bytes = (await file.stat()).size - 44;
      const header = Buffer.alloc(44);
      const { bytesRead } = await file.read(header, 0, 44, 0);
      if (bytes < 0 || bytes % 2 || bytesRead !== 44 || !header.equals(wavHeader(bytes))) {
        throw Error(`Invalid finalized recording WAV: ${segment.filename}`);
      }
      if (bytes) { inputs.push(segment.filename); pcmBytes += bytes; }
    } finally { await file.close(); }
  }
  if (!pcmBytes) throw Error('Recording contains no saved audio');
  const durationSeconds = pcmBytes / 32000, bitrateKbps = publicationBitrate(durationSeconds);
  const space = await statfs(dir);
  if (space.bavail * space.bsize < (config.limits.minFreeBytes || 0) + PUBLICATION_MAX_BYTES) {
    throw Error('Insufficient free space for complete recording audio; originals remain saved');
  }
  const filename = 'publication.mp3', path = join(dir, filename);
  const list = join(dir, 'publication-input.txt'), partial = `${path}.partial`;
  try {
    await writeFile(list, inputs.map(name => `file '${name}'\n`).join(''), { mode: 0o600 });
    await exec(config.publicationFfmpeg || config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'concat', '-safe', '1', '-i', list, '-map', '0:a:0', '-map_metadata', '-1',
      '-c:a', 'libmp3lame', '-b:a', `${bitrateKbps}k`, '-ar', '16000', '-ac', '1', '-threads', '1', '-f', 'mp3', partial],
    { signal, timeout: Math.max(30000, Math.min(600000, Math.ceil(durationSeconds * 100) + 30000)), maxBuffer: 1024 * 1024 });
    const sizeBytes = (await stat(partial)).size;
    if (!sizeBytes || sizeBytes > PUBLICATION_MAX_BYTES) throw Error('Complete recording exceeds the Feishu attachment limit; originals remain saved');
    await rename(partial, path);
    return { filename, displayName: recordingFileName({ ...record, segments: [] }).replace(/\.wav$/, '.mp3'),
      mimeType: 'audio/mpeg', durationSeconds, bitrateKbps, sizeBytes };
  } finally {
    await rm(list, { force: true });
    await rm(partial, { force: true });
  }
}
