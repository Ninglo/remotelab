import assert from 'node:assert/strict';
import { companionScene, validateCompanion } from '../display/studio-companion.mjs';

// The transport, rather than this layout, owns GIF decoding limits.
const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const payload = { version: 22, timeZone: 'Asia/Shanghai', subject: '评测 <script>',
  sentence: '离线对比已完成；不能据此断言任务能力提升。', observedAt: '2026-10-19T13:06:49.895Z', weatherCity: '北京',
  credit: 'Author & original', actions: ['wave', 'stretch', 'think'].map(name => ({ name, gifBase64 })) };
const now = Date.parse('2026-10-20T05:00:00Z');
const weather = { temperature: 11, code: 0, observedAt: '2026-10-20T13:00' };
const a = companionScene(payload, weather, now);
const b = companionScene(payload, weather, now + 60_000);
assert.equal(a.meta.clock, '13:00');
assert.equal(b.meta.clock, '13:01');
assert.match(a.meta.observed, /10\/19 21:06/);
assert.equal(a.meta.observed, b.meta.observed, 'source time must not advance with the live clock');
assert.notEqual(a.meta.action, b.meta.action);
assert.equal(a.animations[0].gifBase64, gifBase64, 'preserve source GIF bytes and timing');
assert.match(a.svg, /北京  11°  晴/);
assert.match(a.svg, /评测 &lt;script&gt;/);
assert.doesNotMatch(a.svg, /<script>/);
assert.match(companionScene(payload, null, now).svg, /北京天气暂不可用/);
assert.throws(() => validateCompanion({ ...payload, observedAt: '2026-10-19 21:00' }), /explicit time zone/);
assert.throws(() => validateCompanion({ ...payload, actions: [] }), /1–6/);
assert.throws(() => validateCompanion({ ...payload, actions: [{ name: 'bad', gifBase64: Buffer.from('not gif').toString('base64') }] }), /GIF/);
assert.throws(() => validateCompanion({ ...payload, timeZone: 'invalid-zone' }), /time zone/);
console.log('PASS companion clock, stable source time, action rotation, weather failure, escaping and validation');
