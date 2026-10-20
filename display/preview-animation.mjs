import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import { decodeGifFrames } from './gif-frames.mjs';

const MAX_LAYERS = 4;
const WIDTH = 1920;
const HEIGHT = 480;

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

export function previewFrameId(png, animations = []) {
  const digest = createHash('sha256').update(png);
  if (animations.length) digest.update(JSON.stringify(animations));
  return digest.digest('hex').slice(0, 12);
}

export function previewBundleId(frameId, version, intervalMs, stage = 'full') {
  if (version !== 2) return frameId;
  const key = `${frameId}:${version}:${intervalMs}${stage === 'starter' ? ':starter' : ''}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function prepareAnimatedPreview(png, animations = []) {
  if (!Array.isArray(animations) || animations.length > MAX_LAYERS) invalid('Preview has too many GIF images');
  const layers = animations.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.gifBase64 !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.gifBase64)
      || item.gifBase64.length > 4 * 1024 * 1024) invalid('Invalid preview GIF');
    const gif = Buffer.from(item.gifBase64, 'base64');
    if (gif.toString('base64') !== item.gifBase64) invalid('Invalid preview GIF');
    const decoded = decodeGifFrames(gif);
    const box = item.box;
    if (!box || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(box[key]))) invalid('Invalid GIF position');
    if (box.width < 1 || box.height < 1 || box.x < 0 || box.y < 0
      || box.x + box.width > WIDTH + 0.01 || box.y + box.height > HEIGHT + 0.01) invalid('GIF lies outside preview screen');
    const fit = item.fit || 'contain';
    if (!['contain', 'cover', 'fill'].includes(fit)) invalid('Unsupported GIF fit');
    if (item.completeLoop !== undefined && typeof item.completeLoop !== 'boolean') invalid('Invalid complete-loop setting');
    if (item.playOnce !== undefined && typeof item.playOnce !== 'boolean') invalid('Invalid play-once setting');
    if (item.playOnce === true && !/^[a-f0-9]{12}$/.test(item.playbackId || '')) invalid('Invalid playback ID');
    return { box, fit, frames: decoded.frames, completeLoop: item.completeLoop === true };
  });
  return { backgroundPng: png, layers };
}

function frameDelay(frame, minimumFrameMs, quantumMs = 0) {
  const delay = Math.max(minimumFrameMs, frame.delayMs);
  return quantumMs ? Math.ceil(delay / quantumMs) * quantumMs : delay;
}

function animatedSvg(prepared, nowMs, minimumFrameMs, quantumMs = 0) {
  const images = prepared.layers.map((layer) => {
    const durationMs = layer.frames.reduce((sum, frame) => sum + frameDelay(frame, minimumFrameMs, quantumMs), 0);
    let phase = ((nowMs % durationMs) + durationMs) % durationMs;
    let selected = layer.frames[0];
    for (const frame of layer.frames) {
      selected = frame;
      const delayMs = frameDelay(frame, minimumFrameMs, quantumMs);
      if (phase < delayMs) break;
      phase -= delayMs;
    }
    const { x, y, width, height } = layer.box;
    const preserve = layer.fit === 'cover' ? 'xMidYMid slice' : layer.fit === 'fill' ? 'none' : 'xMidYMid meet';
    return `<image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="${preserve}" href="data:image/png;base64,${selected.png.toString('base64')}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><image width="${WIDTH}" height="${HEIGHT}" href="data:image/png;base64,${prepared.backgroundPng.toString('base64')}"/>${images}</svg>`;
}

function encodeJpeg(svg) {
  const pixels = new Resvg(svg).render().pixels;
  for (const quality of [88, 78, 68]) {
    const encoded = jpeg.encode({ data: pixels, width: WIDTH, height: HEIGHT }, quality).data;
    if (encoded.length <= 650 * 1024) return encoded;
  }
  throw Error('Display JPEG exceeds device packet limit');
}

export function renderAnimatedPreview(prepared, nowMs = Date.now()) {
  return Buffer.from(new Resvg(animatedSvg(prepared, nowMs, 450)).render().asPng());
}

export function renderAnimatedPreviewJpeg(prepared, nowMs = Date.now()) {
  return encodeJpeg(animatedSvg(prepared, nowMs, 150));
}

function gcd(left, right) {
  while (right) [left, right] = [right, left % right];
  return left;
}

export function completeLoopTimeline(layers, intervalMs, stage = 'full') {
  if (layers.length !== 1) throw Error('Complete-loop playback currently requires one animation layer');
  const frames = layers[0].frames;
  const durationMs = frames.reduce((sum, frame) => sum + frameDelay(frame, intervalMs), 0);
  // The installed v2 agent accepts <=32 frames and <=500ms per frame. A
  // starter must also span the WHOLE action because slow links may keep it.
  if (durationMs > 32 * 500) throw Error('Complete animation exceeds the installed player’s 16-second loop capacity');
  const frameCount = Math.min(32, Math.ceil(durationMs / intervalMs),
    stage === 'starter' ? Math.max(8, Math.ceil(durationMs / 500)) : 32);
  const playbackIntervalMs = Math.max(intervalMs, Math.ceil(durationMs / frameCount));
  const lastFrameAt = durationMs - frameDelay(frames.at(-1), intervalMs);
  const times = Array.from({ length: frameCount }, (_, i) => frameCount === 1 ? 0 : i * lastFrameAt / (frameCount - 1));
  return { times, intervalMs: playbackIntervalMs, durationMs };
}

export function renderAnimatedPreviewBundle(prepared, frameId, intervalMs = 180, version = 1, stage = 'full') {
  if (![1, 2].includes(version) || !Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 500) throw Error('Unsupported display animation bundle timing');
  if (!['full', 'starter'].includes(stage) || (version === 1 && stage !== 'full')) throw Error('Unsupported display animation bundle stage');
  const maxFrames = stage === 'starter' ? 8 : 32;
  const loopLengths = prepared.layers.map((layer) => layer.frames.reduce((sum, frame) => sum + frameDelay(frame, intervalMs, intervalMs) / intervalMs, 0));
  const loopFrames = Math.min(maxFrames, loopLengths.reduce((value, count) => Math.min(maxFrames, value / gcd(value, count) * count), 1));
  const complete = version === 2 && prepared.layers.some(layer => layer.completeLoop)
    ? completeLoopTimeline(prepared.layers, intervalMs, stage) : null;
  const times = complete?.times || Array.from({ length: loopFrames }, (_, index) => index * intervalMs);
  const frames = [];
  let encodedBytes = 0;
  for (const time of times) {
    const frame = encodeJpeg(animatedSvg(prepared, time, intervalMs, complete ? 0 : intervalMs));
    encodedBytes += frame.length;
    if (encodedBytes > 6 * 1024 * 1024) throw Object.assign(Error('Animated preview bundle is too large'), { status: 413 });
    frames.push(frame.toString('base64'));
  }
  const bundleId = previewBundleId(frameId, version, intervalMs, stage);
  return { frameCount: frames.length, body: Buffer.from(JSON.stringify({ version, frameId, bundleId, intervalMs: complete?.intervalMs || intervalMs, frames })) };
}

export function renderStaticPreviewJpeg(png) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><image width="${WIDTH}" height="${HEIGHT}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
  return encodeJpeg(svg);
}
