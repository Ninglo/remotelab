import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import { completeLoopTimeline, previewBundleId, renderAnimatedPreviewBundle } from '../display/preview-animation.mjs';

const png = color => Buffer.from(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="${color}"/></svg>`).render().asPng());
const frames = Array.from({ length: 32 }, (_, i) => ({ delayMs: 310, png: png(`rgb(${i * 8},80,100)`) }));
const layer = { frames, completeLoop: true, box: { x: 0, y: 0, width: 1920, height: 480 }, fit: 'fill' };
const prepared = { backgroundPng: png('white'), layers: [layer] };
for (const stage of ['starter', 'full']) {
  const timeline = completeLoopTimeline([layer], 100, stage);
  assert.equal(timeline.times[0], 0);
  assert.equal(timeline.times.at(-1), 31 * 310, 'include the finishing pose, not just the opening');
  assert.equal(timeline.intervalMs * timeline.times.length, 9920, 'retain complete source duration');
  assert.ok(timeline.times.length <= 32 && timeline.intervalMs <= 500, 'installed client can play it');
  const bundle = JSON.parse(renderAnimatedPreviewBundle(prepared, '123456789abc', 100, 2, stage).body);
  assert.equal(bundle.frames.length, stage === 'starter' ? 20 : 32);
  assert.equal(bundle.intervalMs * bundle.frames.length, 9920);
  assert.equal(bundle.bundleId, previewBundleId(bundle.frameId, 2, 100, stage), '304 cache identity stays compatible');
  const first = jpeg.decode(Buffer.from(bundle.frames[0], 'base64')).data;
  const last = jpeg.decode(Buffer.from(bundle.frames.at(-1), 'base64')).data;
  assert.ok(first[0] < 5 && last[0] > 240, 'actual rendered bundle includes both opening and ending');
}
assert.throws(() => completeLoopTimeline([{ frames: [{ delayMs: 17000 }] }], 100), /16-second/);
const legacy = JSON.parse(renderAnimatedPreviewBundle({ ...prepared, layers: [{ ...layer, completeLoop: false }] }, '123456789abc', 100, 2, 'starter').body);
assert.equal(legacy.frames.length, 8);
assert.equal(legacy.intervalMs, 100, 'existing non-opt-in layouts retain their timing');
console.log('PASS complete action start/end, source duration, starter coverage, installed-client limits and cache identity');
