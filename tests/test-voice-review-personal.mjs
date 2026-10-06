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
  const runaway = await reviewVoiceText('person-a', longOriginal, {
    runModel: async () => (`我现在整理一下。等下，有没有改原意？再调整一下：${longOriginal}`).repeat(5),
  });
  assert.equal(runaway.overedited, true, 'repeated revisions must not replace dictation');
  assert.equal(runaway.revised, longOriginal.replace('Cloud Talk', 'Claude Tag'));
  const tagged = await reviewVoiceText('person-a', '请检查结果。', {
    runModel: async () => '<think>先检查要求。</think>请检查结果。',
  });
  assert.equal(tagged.overedited, true);
  assert.equal(tagged.revised, '请检查结果。');

  // A personal trial must select its own instructions without changing other People.
  await updateVoiceReviewSettings('person-a', { reviewStyle: 'clarify' });
  await updateVoiceReviewSettings('person-a', { terms: ['Cloud Talk => Claude Tag'] });
  assert.equal((await getVoiceReviewSettings('person-a')).reviewStyle, 'clarify',
    'ordinary settings saves preserve the personal trial style');
  assert.equal((await getVoiceReviewSettings('person-b')).reviewStyle, undefined);
  const clarified = await reviewVoiceText('person-a', '嗯我觉得 Cloud Talk 可能有点问题，先帮我想想，不要改代码。', {
    runModel: async (prompt) => {
      assert.match(prompt, /优先级：原意和要求范围/);
      assert.match(prompt, /“帮我想想”不能改成“帮我实现”/);
      assert.match(prompt, /多个候选都合理时保留原文/);
      assert.match(prompt, /不提供对话历史/);
      assert.match(prompt, /Cloud Talk → Claude Tag/);
      return '我觉得 Claude Tag 可能有点问题，先帮我想想，不要改代码。';
    },
  });
  assert.equal(clarified.revised, '我觉得 Claude Tag 可能有点问题，先帮我想想，不要改代码。');
  await updateVoiceReviewSettings('person-b', { enabled: true, reviewMode: 'model' });
  await reviewVoiceText('person-b', '只帮我检查一下。', {
    runModel: async (prompt) => {
      assert.match(prompt, /你只校对语音转写/);
      assert.doesNotMatch(prompt, /用户发送消息前的文字编辑|Claude Tag/);
      return '只帮我检查一下。';
    },
  });
  await assert.rejects(updateVoiceReviewSettings('person-a', { reviewStyle: 'unknown' }), /reviewStyle/);
  await updateVoiceReviewSettings('person-a', { reviewStyle: 'proofread' });
  assert.equal((await getVoiceReviewSettings('person-a')).reviewStyle, undefined,
    'the trial can return to the existing proofreading behavior');
  await updateVoiceReviewSettings('person-b', { enabled: false, reviewMode: 'asr' });
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
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"text":"整理稿"}' } }] }) };
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
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"text":"整理稿"}' } }] }) };
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
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /JSON/);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"text":"整理稿"}', reasoning_content: '不得进入正文' } }] }) };
  };
  try {
    assert.equal(await runVoiceReviewModel('测试', { personId: 'person-a' }), '整理稿');
  } finally {
    globalThis.fetch = originalFetch;
  }
  try {
    for (const [content, finish_reason] of [
      ['我现在整理一下。等下，检查有没有改原意。最终正文：原文。', 'stop'],
      ['{"text":"原文", "analysis":"自检过程"}', 'stop'],
      ['{"text":"未完成', 'length'],
      ['{"text":"看似完整但被截断。"}', 'length'],
    ]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason, message: { content } }] }) });
      await assert.rejects(runVoiceReviewModel('测试', { personId: 'person-a' }), /invalid draft|did not finish/);
    }
    const controller = new AbortController();
    let requestStarted;
    const started = new Promise(resolve => { requestStarted = resolve; });
    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      requestStarted();
    });
    const cancelled = reviewVoiceText('person-a', '原始发言', { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    const next = await reviewVoiceText('person-a', '新的一段', { runModel: async () => '新的一段。' });
    assert.equal(next.revised, '新的一段。', 'cancellation releases the per-Person request slot');
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
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"text":"整理稿"}' } }] }) };
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
