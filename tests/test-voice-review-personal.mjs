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
    getVoiceReviewSettings,
    reviewVoiceText,
    runVoiceReviewModel,
    updateVoiceReviewSettings,
  } = await import('../chat/voice-review.mjs');

  const emptySettings = { enabled: false, terms: [], provider: { id: '', apiKeyConfigured: false } };
  assert.deepEqual(await getVoiceReviewSettings('person-a'), emptySettings);
  assert.equal(getVoiceReviewBackend(), 'unconfigured');
  await assert.rejects(runVoiceReviewModel('测试'), /configured model API/,
    'an unset provider must never spend Codex tokens');
  await assert.rejects(reviewVoiceText('person-a', '你好。', { runModel: async () => '你好。' }), /off/);

  await updateVoiceReviewSettings('person-a', { enabled: true, terms: ['RemoteLab', 'RoboDojo'] });
  assert.deepEqual(await getVoiceReviewSettings('person-b'), emptySettings,
    'another Person must not receive the personal vocabulary or opt-in');
  const result = await reviewVoiceText('person-a', '我想试试肉波道场。', {
    runModel: async (prompt) => {
      assert.match(prompt, /RoboDojo/);
      assert.match(prompt, /Do not summarize/);
      return '我想试试 RoboDojo。';
    },
  });
  assert.deepEqual(result, {
    original: '我想试试肉波道场。',
    revised: '我想试试 RoboDojo。',
    backend: 'unconfigured',
  });
  await assert.rejects(updateVoiceReviewSettings('person-a', {
    terms: Array.from({ length: 51 }, (_, index) => `term-${index}`),
  }), /at most 50/);
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
