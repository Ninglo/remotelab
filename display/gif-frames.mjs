import { deflateSync } from 'node:zlib';

const MAX_GIF_BYTES = 3 * 1024 * 1024;
const MAX_PIXELS = 640 * 480;
const MAX_FRAMES = 48;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let row = 0; row < height; row += 1) {
    rgba.copy(raw, row * (rowBytes + 1) + 1, row * rowBytes, (row + 1) * rowBytes);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function unpackLzw(data, minimumCodeSize, expected) {
  if (minimumCodeSize < 2 || minimumCodeSize > 8) invalid('Invalid GIF color depth');
  const clear = 1 << minimumCodeSize;
  const end = clear + 1;
  let dictionary;
  let next;
  let codeSize;
  const reset = () => {
    dictionary = Array.from({ length: clear }, (_, index) => Uint8Array.of(index));
    next = end + 1;
    codeSize = minimumCodeSize + 1;
  };
  reset();
  const output = new Uint8Array(expected);
  let bits = 0;
  let available = 0;
  let position = 0;
  let offset = 0;
  let previous = null;
  while (position < expected) {
    while (available < codeSize) {
      if (offset >= data.length) invalid('GIF frame ended early');
      bits |= data[offset++] << available;
      available += 8;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    available -= codeSize;
    if (code === clear) { reset(); previous = null; continue; }
    if (code === end) break;
    let entry = dictionary[code];
    if (!entry && code === next && previous) entry = Uint8Array.from([...previous, previous[0]]);
    if (!entry || position + entry.length > expected) invalid('Invalid GIF frame data');
    output.set(entry, position);
    position += entry.length;
    if (previous && next < 4096) {
      dictionary[next++] = Uint8Array.from([...previous, entry[0]]);
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }
  if (position !== expected) invalid('GIF frame is incomplete');
  return output;
}

function deinterlace(pixels, width, height) {
  const rows = new Uint8Array(pixels.length);
  let sourceRow = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let row = start; row < height; row += step) {
      rows.set(pixels.subarray(sourceRow * width, (sourceRow + 1) * width), row * width);
      sourceRow += 1;
    }
  }
  return rows;
}

export function decodeGifFrames(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_GIF_BYTES) invalid('GIF must be 3 MB or smaller');
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) invalid('Select a GIF image');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (!width || !height || width * height > MAX_PIXELS) invalid('GIF dimensions must fit within 640 × 480 pixels');
  let offset = 13;
  const take = (count) => {
    if (offset + count > bytes.length) invalid('Truncated GIF');
    const result = bytes.subarray(offset, offset + count);
    offset += count;
    return result;
  };
  const palette = (count) => take(count * 3);
  const blocks = () => {
    const parts = [];
    for (;;) {
      const count = take(1)[0];
      if (!count) break;
      parts.push(take(count));
    }
    return Buffer.concat(parts);
  };
  let globalPalette = null;
  if (bytes[10] & 0x80) globalPalette = palette(1 << ((bytes[10] & 7) + 1));
  const canvas = Buffer.alloc(width * height * 4);
  const frames = [];
  let gce = { delayMs: 100, disposal: 0, transparent: -1 };
  let previous = null;
  let durationMs = 0;
  while (offset < bytes.length) {
    const marker = take(1)[0];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = take(1)[0];
      if (label === 0xf9) {
        if (take(1)[0] !== 4) invalid('Invalid GIF control block');
        const control = take(4);
        if (take(1)[0] !== 0) invalid('Invalid GIF control block');
        gce = {
          delayMs: Math.max(100, control.readUInt16LE(1) * 10),
          disposal: (control[0] >> 2) & 7,
          transparent: control[0] & 1 ? control[3] : -1,
        };
      } else {
        if (label === 0xff || label === 0x01) take(take(1)[0]);
        blocks();
      }
      continue;
    }
    if (marker !== 0x2c) invalid('Invalid GIF block');
    if (frames.length >= MAX_FRAMES) invalid('GIF may contain at most 48 frames');
    const descriptor = take(9);
    const left = descriptor.readUInt16LE(0);
    const top = descriptor.readUInt16LE(2);
    const frameWidth = descriptor.readUInt16LE(4);
    const frameHeight = descriptor.readUInt16LE(6);
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) invalid('Invalid GIF frame bounds');
    const colors = descriptor[8] & 0x80 ? palette(1 << ((descriptor[8] & 7) + 1)) : globalPalette;
    if (!colors) invalid('GIF has no color palette');
    const minimumCodeSize = take(1)[0];
    const compressed = blocks();
    let pixels = unpackLzw(compressed, minimumCodeSize, frameWidth * frameHeight);
    if (descriptor[8] & 0x40) pixels = deinterlace(pixels, frameWidth, frameHeight);
    if (previous?.disposal === 2) {
      for (let y = previous.top; y < previous.top + previous.height; y += 1) {
        canvas.fill(0, (y * width + previous.left) * 4, (y * width + previous.left + previous.width) * 4);
      }
    } else if (previous?.disposal === 3 && previous.saved) previous.saved.copy(canvas);
    const saved = gce.disposal === 3 ? Buffer.from(canvas) : null;
    for (let y = 0; y < frameHeight; y += 1) {
      for (let x = 0; x < frameWidth; x += 1) {
        const color = pixels[y * frameWidth + x];
        if (color === gce.transparent) continue;
        const paletteOffset = color * 3;
        if (paletteOffset + 2 >= colors.length) invalid('GIF color index is invalid');
        const destination = ((top + y) * width + left + x) * 4;
        canvas[destination] = colors[paletteOffset];
        canvas[destination + 1] = colors[paletteOffset + 1];
        canvas[destination + 2] = colors[paletteOffset + 2];
        canvas[destination + 3] = 255;
      }
    }
    frames.push({ png: encodePng(width, height, canvas), startMs: durationMs, delayMs: gce.delayMs });
    durationMs += gce.delayMs;
    if (durationMs > 30_000) invalid('GIF duration must be 30 seconds or shorter');
    previous = { left, top, width: frameWidth, height: frameHeight, disposal: gce.disposal, saved };
    gce = { delayMs: 100, disposal: 0, transparent: -1 };
  }
  if (!frames.length) invalid('GIF contains no image frames');
  return { width, height, frames, durationMs };
}
