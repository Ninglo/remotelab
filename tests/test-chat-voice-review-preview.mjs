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
  'voiceReviewEnabled', 'voiceReviewModelEnabled', 'voiceReviewModelFields', 'voiceReviewTerms', 'voiceReviewProvider', 'voiceReviewProviderEndpoint',
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
const reviewSignals = [];
const deadlines = new Map();
let nextDeadline = 0;
let respectAbort = false;
const browser = {
  setTimeout(fn, ms) { const id = ++nextDeadline; deadlines.set(id, { fn, ms }); return id; },
  clearTimeout(id) { deadlines.delete(id); },
  addEventListener(type, listener) { listeners.set(type, listener); },
  remotelabT(key) { return key; },
};
const context = {
  window: browser,
  document: { getElementById(id) { return elements.get(id); } },
  currentPerson: { id: 'person-a' },
  currentSessionId: 'session-a',
  Event: class Event { constructor(type) { this.type = type; } },
  AbortController,
  fetchJsonOrRedirect: async (path, options = {}) => {
    requests.push({ path, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (path === '/api/voice-review/settings' && options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      return { settings: { enabled: true, reviewMode: body.reviewMode, terms: body.terms, provider: {
        id: body.providerId,
        apiKeyConfigured: !!body.providerId && !!body.apiKey,
      } }, backend: body.apiKey ? 'api' : 'unconfigured' };
    }
    if (path === '/api/voice-review/settings') return { settings: {
      enabled: true, reviewMode: 'model', terms: ['RoboDojo'], provider: { id: 'doubao', apiKeyConfigured: true },
    }, backend: 'api' };
    if (path === '/api/voice-review') {
      reviewSignals.push(options.signal);
      return new Promise((resolve, reject) => {
        reviews.push(resolve);
        if (respectAbort) options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
    }
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
assert.ok(pending, 'automatic cleanup remains observable independently of Send');
await flush();
assert.equal(requests.filter((request) => request.path === '/api/voice-review').length, 1,
  'finished dictation starts cleanup without another click');
assert.equal(composer.value, '已有草稿 请检查肉波道场的结果');
reviews.shift()({ revised: '请检查 RoboDojo 的结果。' });
assert.equal((await pending).after, '已有草稿 请检查 RoboDojo 的结果。');
assert.equal(composer.value, '已有草稿 请检查 RoboDojo 的结果。');
assert.equal(elements.get('voiceReviewUndo').hidden, false);
assert.equal(browser.remotelabWaitForVoiceReview(), null);
assert.equal(elements.get('voiceReviewModelFields').hidden, false);

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
assert.equal(reviewSignals.at(-1).aborted, true, 'editing cancels the obsolete request');
reviews.shift()({ revised: '模型迟到的结果' });
assert.equal((await stale).after, null);
assert.equal(composer.value, '用户自己改过的文字', 'late cleanup must preserve manual edits');
assert.equal(elements.get('voiceReviewPanel').hidden, true);

composer.value = '我要立即发送的识别原文';
finishDictation(composer.value);
const cancelled = browser.remotelabWaitForVoiceReview();
browser.remotelabCancelVoiceReview();
assert.equal(reviewSignals.at(-1).aborted, true, 'Send cancels cleanup immediately');
assert.equal(browser.remotelabWaitForVoiceReview(), null);
reviews.shift()({ revised: '迟到的整理结果' });
assert.equal((await cancelled).after, null);
assert.equal(composer.value, '我要立即发送的识别原文', 'late cleanup cannot change the sent text');

composer.value = '旧的一段';
finishDictation(composer.value);
const oldTake = browser.remotelabWaitForVoiceReview();
const oldSignal = reviewSignals.at(-1);
composer.value = '新的一段';
finishDictation(composer.value);
const newTake = browser.remotelabWaitForVoiceReview();
assert.equal(oldSignal.aborted, true);
assert.equal(reviews.length, 2, 'new dictation must start without waiting for the old request');
reviews.shift()({ revised: '旧结果' });
assert.equal((await oldTake).after, null);
reviews.shift()({ revised: '新的一段。' });
assert.equal((await newTake).after, '新的一段。');

respectAbort = true;
composer.value = '等超时的原始识别';
finishDictation(composer.value);
const timedOut = browser.remotelabWaitForVoiceReview();
assert.equal(deadlines.size, 1);
const deadline = [...deadlines.values()][0];
assert.equal(deadline.ms, 5000);
deadline.fn();
assert.equal((await timedOut).after, '等超时的原始识别');
assert.equal(composer.value, '等超时的原始识别');
assert.equal(elements.get('voiceReviewBody').textContent, 'voiceReview.failed');
assert.equal(deadlines.size, 0, 'terminal requests clear their deadline');
reviews.shift();
respectAbort = false;

elements.get('voiceReviewProvider').value = '';
await elements.get('voiceReviewSave').listeners.get('click')();
composer.value = '没有模型时的识别原文';
finishDictation('没有模型时的识别原文');
assert.equal(browser.remotelabWaitForVoiceReview(), null);
assert.equal(elements.get('voiceReviewBody').textContent, 'voiceReview.unconfigured');
assert.equal(requests.filter((request) => request.path === '/api/voice-review').length, 10,
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

elements.get('voiceReviewModelEnabled').checked = false;
elements.get('voiceReviewModelEnabled').listeners.get('change')();
assert.equal(elements.get('voiceReviewModelFields').hidden, true);
await elements.get('voiceReviewSave').listeners.get('click')();
assert.equal(requests.at(-1).body.reviewMode, 'asr');
assert.equal(elements.get('voiceReviewBackendNote').textContent, 'settings.voiceReview.backend.asr');
composer.value = '只做顺滑的转写';
finishDictation('只做顺滑的转写');
assert.equal(browser.remotelabWaitForVoiceReview(), null);
assert.equal(elements.get('voiceReviewPanel').hidden, true);
assert.equal(requests.filter((request) => request.path === '/api/voice-review').length, 10,
  'ASR-only mode must not call the model even when an API key is saved');

console.log('test-chat-voice-review-preview: ok');
