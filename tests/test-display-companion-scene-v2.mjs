import test from 'node:test';
import assert from 'node:assert/strict';
import { companionScene, validateCompanion, wrapSentence, describeWeather, LAYOUT } from '../display/companion-scene-v2.mjs';
const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const now = Date.parse('2026-10-20T05:00:00Z');
const payload = { version: 22, timeZone: 'Asia/Shanghai', weatherCity: '北京', credit: '角色：github.com/PC2005-cloud/dsh-pet',
  subject: '微调权重评测', sentence: '离线动作对比已完成；能力是否提升，还要看独立评测。',
  observedAt: '2026-10-19T13:06:49.895Z', actions: ['wave', 'stretch', 'think'].map(name => ({ name, gifBase64 })) };
const observation = { subject: '测试 <script>', sentence: '已经保留限制；尚不能判断能力提升。', observedAt: payload.observedAt, kind: 'result', label: '对话更新' };

test('original v22 three-action input works with Beijing clock and stable record timestamp', () => {
  const a = companionScene(payload, null, now), b = companionScene(payload, null, now + 60_000);
  assert.equal(a.meta.clock, '13:00');
  assert.equal(b.meta.clock, '13:01');
  assert.equal(a.meta.observed, b.meta.observed);
  assert.match(a.meta.observed, /10\/19 21:06/);
  assert.notEqual(a.meta.action, b.meta.action);
  assert.equal(a.animations[0].gifBase64, gifBase64);
  assert.equal(a.animations[0].completeLoop, true);
});
test('single selected library action and observation override legacy text without modifying GIF', () => {
  const scene = companionScene({ ...payload, actions: [payload.actions[0]], observation,
    libraryInfo: { total: 106, category: '日常', actionName: '元气挥手' } }, null, now);
  assert.equal(scene.meta.action, 'wave');
  assert.equal(scene.animations[0].gifBase64, gifBase64);
  assert.match(scene.svg, /动作库 106/);
  assert.match(scene.svg, /对话更新/);
  assert.doesNotMatch(scene.svg, /结论生成|结论记录|离线动作对比/);
  assert.match(scene.svg, /测试 &lt;script&gt;/);
  assert.doesNotMatch(scene.svg, /<script>/);
});
test('1920×480 layout right-aligns complete character without mirroring it', () => {
  const scene = companionScene(payload, null, now);
  assert.match(scene.svg, /width="1920" height="480"/);
  assert.match(scene.svg, /<rect width="1920" height="480" fill="#f4f1ed"/);
  assert.deepEqual(scene.animations[0].box, { x: 1486, y: 20, width: 422, height: 422 });
  assert.equal(scene.animations[0].gifBase64, gifBase64);
  assert.match(scene.svg, /translate\(-1440 0\)/);
  assert.match(scene.svg, /translate\(1920 0\) scale\(-1 1\)/);
  assert.equal(scene.animations[0].fit, 'contain');
  assert.ok(LAYOUT.pet.x > 1450, 'pet starts after the mirrored speech tail');
});
test('wrapping preserves all wording and qualifications', () => {
  for (const sentence of [payload.sentence, '一'.repeat(19) + '；' + '二'.repeat(19) + '。' + '三'.repeat(19) + '！', 'W'.repeat(60)]) {
    const lines = wrapSentence(sentence);
    assert.equal(lines.join(''), sentence);
    assert.ok(lines.every(line => [...line].length <= 20));
    assert.ok(lines.length <= 4);
    assert.ok(lines.every(line => !/^[，。；！？、：）】]/.test(line)));
  }
  assert.throws(() => validateCompanion({ ...payload, sentence: '长'.repeat(61) }), /sentence/);
});
test('weather handles Beijing-local or UTC source time, stale/missing and zero temperature', () => {
  const local = { temperature: 0, code: 0, observedAt: '2026-10-20T13:00' };
  assert.equal(describeWeather(local, now).text, '北京  0°  晴');
  assert.equal(describeWeather({ ...local, observedAt: '2026-10-20T05:00:00Z' }, now).detail, 'Open-Meteo · 13:00');
  for (const value of [null, { ...local, observedAt: 'bad' }, { ...local, observedAt: '2026-10-20T14:00' },
    { ...local, observedAt: '2026-10-20T11:29' }, { ...local, temperature: NaN }]) {
    assert.equal(describeWeather(value, now).text, '北京天气暂不可用');
  }
});
test('quiet and rest do not pretend to be findings or have conversation timestamps', () => {
  for (const kind of ['quiet', 'rest']) {
    const scene = companionScene({ ...payload, observation: { kind, subject: '陪伴', sentence: '看看远处，喝口水吧。', observedAt: null, label: '' } }, null, now);
    assert.equal(scene.meta.observed, '');
    assert.doesNotMatch(scene.svg, /对话更新|最近结论|完成/);
  }
});
test('invalid transport inputs fail without returning a partially changed scene', () => {
  assert.throws(() => validateCompanion({ ...payload, actions: [] }), /actions/);
  assert.throws(() => validateCompanion({ ...payload, actions: [{ name: 'bad', gifBase64: 'AAAA' }] }), /GIF/);
  assert.throws(() => validateCompanion({ ...payload, timeZone: 'UTC' }), /Beijing/);
  assert.throws(() => validateCompanion({ ...payload, observation: { ...observation, observedAt: '2026-10-20T13:00' } }), /time zone/);
});

test('mixed-language lines keep ordinary Latin words together', () => {
  const sentence = '上下文由原生信息、RemoteLab 启动目录和会话历史共同构成。';
  const lines = wrapSentence(sentence);
  assert.equal(lines.join(''), sentence);
  assert(lines.some(line => line.includes('RemoteLab')));
});

test('word-aware wrapping stays within the four-line display budget', () => {
  const sentence = ('abcdefghijk ').repeat(5);
  const lines = wrapSentence(sentence);
  assert.equal(lines.join(''), sentence);
  assert(lines.length <= 4);
});
