#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = await mkdtemp(join(tmpdir(), 'remotelab-voice-review-'));
process.env.REMOTELAB_CONFIG_DIR = configDir;

try {
  const {
    getVoiceReviewBackend,
    normalizeVoiceReviewSettings,
    getVoiceRecognitionHotwords,
    applyVoiceTermCorrections,
    getVoiceReviewSettings,
    reviewVoiceText,
    runVoiceReviewModel,
    updateVoiceReviewSettings,
  } = await import('../chat/voice-review.mjs');

  const emptySettings = { enabled: false, reviewMode: 'asr', terms: [], provider: { id: '', apiKeyConfigured: false } };
  assert.deepEqual(await getVoiceReviewSettings('person-a'), emptySettings);
  assert.equal(normalizeVoiceReviewSettings({ enabled: true, providerId: 'doubao', apiKey: 'existing-key' }).reviewMode,
    'model', 'an existing configured Person keeps their current behavior until they choose ASR-only');
  assert.equal(getVoiceReviewBackend(), 'unconfigured');
  await assert.rejects(runVoiceReviewModel('测试'), /configured model API/,
    'an unset provider must never spend Codex tokens');
  await assert.rejects(reviewVoiceText('person-a', '你好。', { runModel: async () => '你好。' }), /off/);

  await updateVoiceReviewSettings('person-a', { enabled: true, terms: ['RemoteLab', 'RoboDojo'] });
  let modelCalled = false;
  await assert.rejects(reviewVoiceText('person-a', '请检查结果', {
    runModel: async () => { modelCalled = true; return '不应调用'; },
  }), /Model review is off/);
  assert.equal(modelCalled, false, 'ASR-only mode must not call the model');
  await updateVoiceReviewSettings('person-a', { reviewMode: 'model' });
  assert.deepEqual(getVoiceRecognitionHotwords(['Cloud Talk => Claude Tag', 'Claude Tag']), ['Claude Tag']);
  assert.equal(applyVoiceTermCorrections('Cloud Talk 和 cloud talk', ['Cloud Talk => Claude Tag']),
    'Claude Tag 和 Claude Tag');
  assert.deepEqual(await getVoiceReviewSettings('person-b'), emptySettings,
    'another Person must not receive the personal vocabulary or opt-in');
  const result = await reviewVoiceText('person-a', '我想试试肉波道场。', {
    runModel: async (prompt) => {
      assert.match(prompt, /RoboDojo/);
      assert.match(prompt, /只删除独立的“嗯、呃”/);
      assert.match(prompt, /完整原句分行并编号/);
      assert.match(prompt, /不要把原句缩写成任务摘要/);
      assert.match(prompt, /保持原文语言/);
      assert.match(prompt, /"draft":"我想试试肉波道场。"/);
      return '我想试试 RoboDojo。';
    },
  });
  assert.deepEqual(result, {
    original: '我想试试肉波道场。',
    revised: '我想试试 RoboDojo。',
    backend: 'unconfigured',
    overedited: false,
  });
  const longOriginal = '我们还是测试一下这个自动总结哈。首先就是第一点，我们看我们今天完成了整个飞书接入，然后第二点是我们补了一些这个 Cloud Talk 当中的一些实际体验感受，尤其是关于进度显示清单 To Do 那个拉取的。然后第三个是有关 RemoteLab 的一些优化。';
  await updateVoiceReviewSettings('person-a', { terms: ['Cloud Talk => Claude Tag'] });
  const guarded = await reviewVoiceText('person-a', longOriginal, {
    runModel: async () => '1. 完成飞书接入。\n2. 补充 Claude Tag 体验。\n3. 优化 RemoteLab。',
  });
  assert.equal(guarded.overedited, true);
  assert.equal(guarded.revised, longOriginal.replace('Cloud Talk', 'Claude Tag'));
  await updateVoiceReviewSettings('person-a', { terms: ['RemoteLab', 'RoboDojo'] });
  await assert.rejects(updateVoiceReviewSettings('person-a', {
    terms: Array.from({ length: 51 }, (_, index) => `term-${index}`),
  }), /at most 50/);
  await assert.rejects(updateVoiceReviewSettings('person-a', { reviewMode: 'unknown' }), /reviewMode/);
  assert.deepEqual((await getVoiceReviewSettings('person-a')).terms, ['RemoteLab', 'RoboDojo']);

  await updateVoiceReviewSettings('person-a', { enabled: false });
  await assert.rejects(reviewVoiceText('person-a', '下一段', { runModel: async () => '下一段' }), /off/);

  const personal = await updateVoiceReviewSettings('person-a', {
    providerId: 'zhipu', apiKey: 'private-zhipu-key',
  });
  assert.deepEqual(personal.provider, { id: 'zhipu', apiKeyConfigured: true });
  assert.equal(getVoiceReviewBackend(personal), 'api');
  assert.equal(JSON.stringify(personal).includes('private-zhipu-key'), false,
    'the settings API must never return a secret');
  assert.deepEqual((await getVoiceReviewSettings('person-b')).provider, emptySettings.provider,
    'another Person must not inherit this provider');
  const settingsFile = join(configDir, 'voice-review-personal.json');
  assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);
  assert.match(await readFile(settingsFile, 'utf8'), /private-zhipu-key/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer private-zhipu-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'glm-4.7-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '整理稿' } }] }) };
  };
  try {
    assert.equal(await runVoiceReviewModel('测试', { personId: 'person-a' }), '整理稿');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const switched = await updateVoiceReviewSettings('person-a', { providerId: 'openrouter' });
  assert.deepEqual(switched.provider, { id: 'openrouter', apiKeyConfigured: false },
    'switching providers must discard the previous provider key');
  await assert.rejects(runVoiceReviewModel('测试', { personId: 'person-a' }), /configured model API/);
  await updateVoiceReviewSettings('person-a', { providerId: 'openrouter', apiKey: 'private-or-key' });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer private-or-key');
    assert.equal(JSON.parse(options.body).model, 'qwen/qwen3-4b:free');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '整理稿' } }] }) };
  };
  try {
    assert.equal(await runVoiceReviewModel('测试', { personId: 'person-a' }), '整理稿');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual((await updateVoiceReviewSettings('person-a', { providerId: '' })).provider,
    emptySettings.provider, 'selecting no provider removes the key');
  const doubao = await updateVoiceReviewSettings('person-a', {
    providerId: 'doubao', apiKey: 'private-ark-key',
  });
  assert.deepEqual(doubao.provider, { id: 'doubao', apiKeyConfigured: true });
  await updateVoiceReviewSettings('person-a', { enabled: true, reviewMode: 'asr' });
  modelCalled = false;
  await assert.rejects(reviewVoiceText('person-a', '已配置密钥但只用豆包顺滑', {
    runModel: async () => { modelCalled = true; return '不应调用'; },
  }), /Model review is off/);
  assert.equal(modelCalled, false, 'a saved model key must not trigger a request in ASR-only mode');
  await updateVoiceReviewSettings('person-a', { reviewMode: 'model' });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer private-ark-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'doubao-seed-2-1-lite-260915');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '整理稿' } }] }) };
  };
  try {
    assert.equal(await runVoiceReviewModel('测试', { personId: 'person-a' }), '整理稿');
  } finally {
    globalThis.fetch = originalFetch;
  }
  await updateVoiceReviewSettings('person-a', { providerId: '' });
  await assert.rejects(updateVoiceReviewSettings('person-a', { providerId: 'unknown', apiKey: 'x' }),
    /supported voice review provider/);
  await assert.rejects(updateVoiceReviewSettings('person-a', { providerId: 'toString', apiKey: 'x' }),
    /supported voice review provider/);

  process.env.REMOTELAB_VOICE_REVIEW_API_KEY = 'test-key';
  process.env.REMOTELAB_VOICE_REVIEW_ENDPOINT = 'https://example.test/v1/chat/completions';
  process.env.REMOTELAB_VOICE_REVIEW_API_MODEL = 'small-model';
  assert.equal(getVoiceReviewBackend(), 'api');
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://example.test/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(options.body).model, 'small-model');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '整理稿' } }] }) };
  };
  try {
    assert.equal(await runVoiceReviewModel('测试'), '整理稿');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.REMOTELAB_VOICE_REVIEW_API_KEY;
    delete process.env.REMOTELAB_VOICE_REVIEW_ENDPOINT;
    delete process.env.REMOTELAB_VOICE_REVIEW_API_MODEL;
  }
} finally {
  await rm(configDir, { recursive: true, force: true });
}

console.log('test-voice-review-personal: ok');
