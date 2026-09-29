#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../static/chat/voice-review.js', import.meta.url), 'utf8');
const ids = [
  'voiceReviewEnabled', 'voiceReviewTerms', 'voiceReviewProvider', 'voiceReviewProviderEndpoint',
  'voiceReviewDoubaoKeyNote',
  'voiceReviewApiKey', 'voiceReviewApiKeyStatus', 'voiceReviewSave', 'voiceReviewSettingsStatus',
  'voiceReviewBackendNote', 'voiceReviewPanel', 'voiceReviewBody', 'voiceReviewRun',
  'voiceReviewApply', 'voiceReviewDismiss', 'voiceReviewStatus', 'msgInput',
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
const browser = {
  addEventListener(type, listener) { listeners.set(type, listener); },
  remotelabT(key, vars) { return vars?.revised ? `${key}: ${vars.revised}` : key; },
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
      return { settings: { enabled: true, terms: ['RoboDojo'], provider: {
        id: body.providerId,
        apiKeyConfigured: !!body.providerId && !!body.apiKey,
      } }, backend: body.apiKey ? 'api' : 'unconfigured' };
    }
    if (path === '/api/voice-review/settings') return { settings: {
      enabled: true, terms: ['RoboDojo'], provider: { id: 'zhipu', apiKeyConfigured: true },
    }, backend: 'api' };
    if (path === '/api/voice-review') return { revised: '请检查 RoboDojo 的结果。' };
    throw new Error('Unexpected request');
  },
};
runInNewContext(source, context, { filename: 'voice-review.js' });
await new Promise((resolve) => setImmediate(resolve));

const composer = elements.get('msgInput');
composer.value = '已有草稿 请检查肉波道场的结果';
listeners.get('remotelab:voice-transcript-complete')({ detail: {
  transcript: '请检查肉波道场的结果',
  composerText: composer.value,
  sessionId: 'session-a',
} });
assert.equal(elements.get('voiceReviewPanel').hidden, false);
assert.deepEqual(requests.map((request) => request.path), ['/api/voice-review/settings'],
  'finishing dictation must not call a model automatically');
assert.equal(composer.value, '已有草稿 请检查肉波道场的结果');

await elements.get('voiceReviewRun').listeners.get('click')();
assert.equal(composer.value, '已有草稿 请检查肉波道场的结果',
  'reviewing must leave the original draft in the composer');
assert.equal(elements.get('voiceReviewApply').hidden, false);
elements.get('voiceReviewApply').listeners.get('click')();
assert.equal(composer.value, '已有草稿 请检查 RoboDojo 的结果。');
assert.equal(elements.get('voiceReviewPanel').hidden, true);

elements.get('voiceReviewEnabled').checked = true;
elements.get('voiceReviewProvider').value = 'doubao';
elements.get('voiceReviewProvider').listeners.get('change')();
assert.equal(elements.get('voiceReviewDoubaoKeyNote').hidden, false);
assert.match(elements.get('voiceReviewProviderEndpoint').textContent, /doubao-seed-2-1-lite-260915/);
elements.get('voiceReviewApiKey').value = 'private-key';
await elements.get('voiceReviewSave').listeners.get('click')();
assert.equal(requests.at(-1).body.apiKey, 'private-key');
assert.equal(elements.get('voiceReviewApiKey').value, '', 'the input must clear after the secret is saved');
elements.get('voiceReviewProvider').value = '';
await elements.get('voiceReviewSave').listeners.get('click')();
composer.value = '另一段原文';
listeners.get('remotelab:voice-transcript-complete')({ detail: {
  transcript: '另一段原文', composerText: composer.value, sessionId: 'session-a',
} });
assert.equal(elements.get('voiceReviewPanel').hidden, true,
  'without a configured API, recording should not offer an unusable model action');
assert.equal(elements.get('voiceReviewRun').disabled, true);
assert.equal(requests.filter((request) => request.path === '/api/voice-review').length, 1);

console.log('test-chat-voice-review-preview: ok');
