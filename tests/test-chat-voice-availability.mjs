#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'chat', 'voice-input.js'), 'utf8');
const listeners = new Map();
const status = { hidden: true, textContent: '' };
let micRequests = 0;
let sessionId = null;
let session = null;
let sharedSnapshot = false;
let configured = true;
const input = { disabled: false, value: '' };
const button = {
  dataset: {}, disabled: true, title: '', classList: { toggle() {} },
  style: { setProperty() {} },
  querySelector() { return null; },
  setAttribute() {},
  addEventListener(type, handler) { listeners.set(type, handler); },
};
const window = {
  document: { getElementById(id) { return id === 'voiceBtn' ? button : id === 'voiceAvailabilityStatus' ? status : null; } },
  WebSocket: class {}, AudioContext: class {}, isSecureContext: true,
  navigator: { mediaDevices: { getUserMedia() { micRequests += 1; return new Promise(() => {}); } } },
  remotelabGetVoiceInputInstanceSettings: () => ({
    provider: 'doubao', appId: configured ? 'configured-app' : '',
    accessToken: configured ? 'configured-token' : '', resourceId: 'volc.seedasr.sauc.duration',
  }),
  remotelabT: (key) => key,
  addEventListener() {},
};
const context = vm.createContext({
  window,
  msgInput: input,
  getCurrentSession: () => session,
  get currentSessionId() { return sessionId; },
  get shareSnapshotMode() { return sharedSnapshot; },
});
vm.runInContext(source, context);
assert.equal(button.disabled, false, 'configured voice should work in an enabled new-Session composer');
listeners.get('click')();
assert.equal(micRequests, 1, 'new-Session voice input should request the microphone');

sessionId = 'session-1';
session = { id: sessionId };
window.remotelabRefreshVoiceInputUi();
assert.equal(button.disabled, false, 'an existing Session should also allow voice input');
configured = false;
window.remotelabRefreshVoiceInputUi();
assert.equal(button.disabled, true);
assert.equal(status.textContent, 'voice.unavailable.setup');
configured = true;
sharedSnapshot = true;
window.remotelabRefreshVoiceInputUi();
assert.equal(button.disabled, true);
assert.equal(status.textContent, 'voice.unavailable.snapshot');
sharedSnapshot = false;
window.navigator.mediaDevices = undefined;
window.remotelabRefreshVoiceInputUi();
assert.equal(button.disabled, true);
assert.equal(status.textContent, 'voice.unavailable.browser');
window.navigator.mediaDevices = { getUserMedia() {} };
input.disabled = true;
window.remotelabRefreshVoiceInputUi();
assert.equal(button.disabled, true);
assert.equal(status.textContent, 'voice.unavailable.composer');
input.disabled = false;
window.remotelabRefreshVoiceInputUi();
assert.equal(button.disabled, false);
assert.equal(status.hidden, true, 'availability warning should disappear once voice is usable');
console.log('test-chat-voice-availability: ok');
