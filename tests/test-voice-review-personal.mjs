#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = await mkdtemp(join(tmpdir(), 'remotelab-voice-review-'));
process.env.REMOTELAB_CONFIG_DIR = configDir;

try {
  const {
    getVoiceReviewSettings,
    reviewVoiceText,
    runVoiceReviewModel,
    updateVoiceReviewSettings,
  } = await import('../chat/voice-review.mjs');

  assert.deepEqual(await getVoiceReviewSettings('person-a'), { enabled: false, terms: [] });
  await assert.rejects(reviewVoiceText('person-a', '你好。', { runModel: async () => '你好。' }), /off/);

  await updateVoiceReviewSettings('person-a', { enabled: true, terms: ['RemoteLab', 'RoboDojo'] });
  assert.deepEqual(await getVoiceReviewSettings('person-b'), { enabled: false, terms: [] },
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
    backend: 'codex',
  });
  await assert.rejects(updateVoiceReviewSettings('person-a', {
    terms: Array.from({ length: 51 }, (_, index) => `term-${index}`),
  }), /at most 50/);
  assert.deepEqual((await getVoiceReviewSettings('person-a')).terms, ['RemoteLab', 'RoboDojo']);

  await updateVoiceReviewSettings('person-a', { enabled: false });
  await assert.rejects(reviewVoiceText('person-a', '下一段', { runModel: async () => '下一段' }), /off/);

  process.env.REMOTELAB_VOICE_REVIEW_API_KEY = 'test-key';
  process.env.REMOTELAB_VOICE_REVIEW_ENDPOINT = 'https://example.test/v1/chat/completions';
  process.env.REMOTELAB_VOICE_REVIEW_API_MODEL = 'small-model';
  const originalFetch = globalThis.fetch;
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
