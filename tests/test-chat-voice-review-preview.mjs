#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../static/chat/voice-review.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('../templates/chat.html', import.meta.url), 'utf8');
assert.match(template, /<script src="chat\/voice-review\.js\?v=\{\{ASSET_VERSION\}\}"/, 'the chat page must load cleanup behavior');
assert.match(template, /class="input-actions-row"[\s\S]*?id="voiceReviewPanel"[\s\S]*?id="voiceBtn"/,
  'cleanup status belongs beside composer controls instead of below the input');
const ids = [
  'voiceReviewEnabled', 'voiceReviewTerms', 'voiceReviewProvider', 'voiceReviewProviderEndpoint',
  'voiceReviewDoubaoKeyNote', 'voiceReviewApiKey', 'voiceReviewApiKeyStatus', 'voiceReviewSave',
  'voiceReviewSettingsStatus', 'voiceReviewBackendNote', 'voiceReviewPanel', 'voiceReviewBody',
  'voiceReviewUndo', 'voiceReviewStatus', 'msgInput',
];
const elements = new Map(ids.map((id) => [id, {
  value: '', checked: false, disabled: false, hidden: true, textContent: '',
  listeners: new Map(),
  addEventListener(type, listener) { this.listeners.set(type, listener); },
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); },
  focus() {},
}]));
const listeners = new Map();
const requests = [];
const reviews = [];
const browser = {
  addEventListener(type, listener) { listeners.set(type, listener); },
  remotelabT(key) { return key; },
};
const context = {
  window: browser,
  document: { getElementById(id) { return elements.get(id); } },
  currentPerson: { id: 'person-a' },
  currentSessionId: 'session-a',
  Event: class Event { constructor(type) { this.type = type; } },
  fetchJsonOrRedirect: async (path, options = {}) => {
    requests.push({ path, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (path === '/api/voice-review/settings' && options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      return { settings: { enabled: true, terms: body.terms, provider: {
        id: body.providerId,
        apiKeyConfigured: !!body.providerId && !!body.apiKey,
      } }, backend: body.apiKey ? 'api' : 'unconfigured' };
    }
    if (path === '/api/voice-review/settings') return { settings: {
      enabled: true, terms: ['RoboDojo'], provider: { id: 'doubao', apiKeyConfigured: true },
    }, backend: 'api' };
    if (path === '/api/voice-review') return new Promise((resolve) => reviews.push(resolve));
    throw new Error('Unexpected request');
  },
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const finishDictation = (transcript, details = {}) => {
  const composer = elements.get('msgInput');
  listeners.get('remotelab:voice-transcript-complete')({ detail: {
    transcript, composerText: composer.value, sessionId: 'session-a', ...details,
  } });
};

runInNewContext(source, context, { filename: 'voice-review.js' });
await flush();

const composer = elements.get('msgInput');
composer.value = '已有草稿 请检查肉波道场的结果';
finishDictation('请检查肉波道场的结果');
assert.equal(elements.get('voiceReviewPanel').hidden, false);
assert.equal(elements.get('voiceReviewBody').textContent, 'voiceReview.working');
const pending = browser.remotelabWaitForVoiceReview();
assert.ok(pending, 'Send can wait for automatic cleanup');
await flush();
assert.equal(requests.filter((request) => request.path === '/api/voice-review').length, 1,
  'finished dictation starts cleanup without another click');
assert.equal(composer.value, '已有草稿 请检查肉波道场的结果');
reviews.shift()({ revised: '请检查 RoboDojo 的结果。' });
assert.equal((await pending).after, '已有草稿 请检查 RoboDojo 的结果。');
assert.equal(composer.value, '已有草稿 请检查 RoboDojo 的结果。');
assert.equal(elements.get('voiceReviewUndo').hidden, false);
assert.equal(browser.remotelabWaitForVoiceReview(), null);

elements.get('voiceReviewUndo').listeners.get('click')();
assert.equal(composer.value, '已有草稿 请检查肉波道场的结果');
assert.equal(elements.get('voiceReviewPanel').hidden, true);

const rawList = '第一点是机器还没有测完。然后第二点是先别开始打印。';
const liveList = browser.remotelabFormatVoiceTranscriptLive(rawList);
assert.equal(liveList, '1. 机器还没有测完。\n2. 先别开始打印。',
  'the composer should organize explicit points while recognition is streaming');
composer.value = `已有草稿 ${liveList}`;
finishDictation(rawList, { displayedTranscript: liveList, rawComposerText: `已有草稿 ${rawList}` });
const listReview = browser.remotelabWaitForVoiceReview();
await flush();
reviews.shift()({ revised: '1. 机器还没有测完。\n2. 打印暂缓。' });
assert.equal((await listReview).after, '已有草稿 1. 机器还没有测完。\n2. 打印暂缓。');
elements.get('voiceReviewUndo').listeners.get('click')();
assert.equal(composer.value, `已有草稿 ${rawList}`, 'Undo must restore the original ASR text');

composer.value = `已有草稿 ${liveList}`;
finishDictation(rawList, { displayedTranscript: liveList, rawComposerText: `已有草稿 ${rawList}` });
const unchangedReview = browser.remotelabWaitForVoiceReview();
await flush();
reviews.shift()({ revised: rawList });
assert.equal((await unchangedReview).after, `已有草稿 ${liveList}`);
assert.equal(elements.get('voiceReviewUndo').hidden, false,
  'Undo must remain available when live formatting is the only change');
elements.get('voiceReviewUndo').listeners.get('click')();
assert.equal(composer.value, `已有草稿 ${rawList}`);

const aliasedList = '第一点是我们测试 Cloud Talk。然后第二点是保留这句说明。';
composer.value = `已有草稿 ${aliasedList}`;
finishDictation(aliasedList);
const overeditedReview = browser.remotelabWaitForVoiceReview();
await flush();
reviews.shift()({ revised: aliasedList.replace('Cloud Talk', 'Claude Tag'), overedited: true });
assert.equal((await overeditedReview).after,
  '已有草稿 1. 我们测试 Claude Tag。\n2. 保留这句说明。');
assert.equal(elements.get('voiceReviewBody').textContent, 'voiceReview.preserved');
elements.get('voiceReviewUndo').listeners.get('click')();
assert.equal(composer.value, `已有草稿 ${aliasedList}`);

composer.value = `已有草稿 ${liveList}`;
finishDictation(rawList, { displayedTranscript: liveList, rawComposerText: `已有草稿 ${rawList}` });
const failedReview = browser.remotelabWaitForVoiceReview();
await flush();
reviews.shift()(Promise.reject(new Error('model unavailable')));
assert.equal((await failedReview).after, `已有草稿 ${rawList}`);
assert.equal(composer.value, `已有草稿 ${rawList}`,
  'a failed model request should restore the original ASR text');
assert.equal(elements.get('voiceReviewBody').textContent, 'voiceReview.failed');

composer.value = '另一段原文';
finishDictation('另一段原文');
const stale = browser.remotelabWaitForVoiceReview();
await flush();
composer.value = '用户自己改过的文字';
composer.dispatchEvent(new context.Event('input'));
reviews.shift()({ revised: '模型迟到的结果' });
assert.equal((await stale).after, null);
assert.equal(composer.value, '用户自己改过的文字', 'late cleanup must preserve manual edits');
assert.equal(elements.get('voiceReviewPanel').hidden, true);

elements.get('voiceReviewProvider').value = '';
await elements.get('voiceReviewSave').listeners.get('click')();
composer.value = '没有模型时的识别原文';
finishDictation('没有模型时的识别原文');
assert.equal(browser.remotelabWaitForVoiceReview(), null);
assert.equal(elements.get('voiceReviewBody').textContent, 'voiceReview.unconfigured');
assert.equal(requests.filter((request) => request.path === '/api/voice-review').length, 6,
  'hotwords alone cannot trigger model cleanup');

elements.get('voiceReviewProvider').value = 'doubao';
elements.get('voiceReviewProvider').listeners.get('change')();
assert.equal(elements.get('voiceReviewDoubaoKeyNote').hidden, false);
assert.match(elements.get('voiceReviewProviderEndpoint').textContent, /doubao-seed-2-1-lite-260915/);
await elements.get('voiceReviewSave').listeners.get('click')();
assert.equal(requests.at(-1).body.providerId, 'doubao');
assert.equal(requests.at(-1).body.apiKey, undefined, 'Doubao can be selected before its key is available');
assert.equal(elements.get('voiceReviewBackendNote').textContent, 'settings.voiceReview.backend.unconfigured');
elements.get('voiceReviewApiKey').value = 'private-key';
await elements.get('voiceReviewSave').listeners.get('click')();
assert.equal(requests.at(-1).body.apiKey, 'private-key');
assert.equal(elements.get('voiceReviewApiKey').value, '', 'the input must clear after the secret is saved');

console.log('test-chat-voice-review-preview: ok');
