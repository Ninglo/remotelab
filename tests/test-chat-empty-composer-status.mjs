#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8');

function extractFunctionSource(functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function element() {
  return {
    className: '',
    textContent: '',
    disabled: true,
    readOnly: false,
    placeholder: '',
    title: '',
    style: {},
    setAttribute(name, value) {
      this[name] = String(value);
    },
  };
}

const msgInput = element();
const sendBtn = element();
const context = {
  console,
  shareSnapshotMode: false,
  currentSessionId: null,
  visitorMode: false,
  sessionStatus: 'idle',
  statusDot: element(),
  statusText: element(),
  msgInput,
  sendBtn,
  cancelBtn: element(),
  inlineToolSelect: element(),
  inlineProviderSelect: element(),
  inlineModelSelect: element(),
  thinkingToggle: element(),
  effortSelect: element(),
  syncSessionTemplateControls() {},
  syncComposerVoiceCleanupToggle() {},
  syncForkButton() {},
  syncShareButton() {},
  setAttachmentPickerDisabled() {},
  setChatSessionStatus() {},
  getCurrentSession() {
    return null;
  },
  getSessionVisualStatus() {
    return { key: 'idle', label: '', dotClass: '' };
  },
  getSessionActivity() {
    return {
      run: { state: 'idle' },
      compact: { state: 'idle' },
    };
  },
  isSessionBusy() {
    return false;
  },
  hasAuthCapability(name) {
    return name === 'createSession';
  },
  t(key) {
    return {
      'status.connected': 'connected',
      'input.placeholder.newSession': 'Type to start a new session...',
      'input.placeholder.message': 'Message...',
      'action.startNewSession': 'Start a new session',
      'action.send': 'Send',
    }[key] || key;
  },
  window: {},
};
context.globalThis = context;
vm.runInNewContext(
  `${extractFunctionSource('canStartSessionFromDetachedComposer')}\n${extractFunctionSource('updateStatus')}`,
  context,
  { filename: 'static/chat/realtime.js' },
);

context.updateStatus('connected', null);
assert.equal(msgInput.disabled, false, 'an owner with no sessions should still be able to type');
assert.equal(msgInput.placeholder, 'Type to start a new session...');
assert.equal(sendBtn.disabled, false, 'Send should remain actionable because it can create a session');
assert.equal(sendBtn.title, 'Start a new session');
assert.equal(sendBtn['aria-label'], 'Start a new session');

context.updateStatus('disconnected', null);
assert.equal(msgInput.disabled, false, 'the detached draft should remain editable while reconnecting');
assert.equal(sendBtn.disabled, false, 'a failed offline send should preserve the draft for retry');

console.log('test-chat-empty-composer-status: ok');
