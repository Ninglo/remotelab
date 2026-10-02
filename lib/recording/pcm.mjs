import { open, rename, stat } from 'node:fs/promises';

export function wavHeader(bytes, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(bytes + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}
// Preserve partial stereo frames across arbitrary pipe chunk boundaries.
export class StereoSplitter {
  carry = Buffer.alloc(0);
  split(chunk) {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const frames = Math.floor(data.length / 4);
    const left = Buffer.allocUnsafe(frames * 2), right = Buffer.allocUnsafe(frames * 2);
    for (let i = 0; i < frames; i++) {
      left.writeInt16LE(data.readInt16LE(i * 4), i * 2);
      right.writeInt16LE(data.readInt16LE(i * 4 + 2), i * 2);
    }
    this.carry = Buffer.from(data.subarray(frames * 4));
    return [left, right];
  }
}
export class WavWriter {
  constructor(path, rate = 16000) { this.path = path; this.rate = rate; this.bytes = 0; }
  async start() {
    this.file = await open(`${this.path}.partial`, 'wx', 0o600);
    await this.file.write(wavHeader(0, this.rate), 0, 44, 0);
  }
  async append(data) {
    let written = 0;
    while (written < data.length) {
      const result = await this.file.write(data, written, data.length - written, 44 + this.bytes + written);
      if (!result.bytesWritten) throw Error('Audio write made no progress');
      written += result.bytesWritten;
    }
    this.bytes += written;
  }
  async finish() {
    if (!this.file) return;
    try { await this.file.write(wavHeader(this.bytes, this.rate), 0, 44, 0); await this.file.sync(); }
    finally { await this.file.close(); this.file = null; }
    await rename(`${this.path}.partial`, this.path);
  }
}
export async function recoverPartialWav(path, rate = 16000) {
  const size = (await stat(`${path}.partial`)).size;
  if (size < 44) throw Error('Incomplete WAV header');
  const bytes = Math.floor((size - 44) / 2) * 2;
  const file = await open(`${path}.partial`, 'r+');
  try { await file.truncate(bytes + 44); await file.write(wavHeader(bytes, rate), 0, 44, 0); await file.sync(); }
  finally { await file.close(); }
  await rename(`${path}.partial`, path);
  return bytes;
}
