#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { normalizeVoiceShortcutBinding } from '../lib/auth-config.mjs';

for (const binding of ['Shift*2', 'Alt*3', 'Alt+Shift', 'Ctrl+Shift+KeyV']) {
  assert.equal(normalizeVoiceShortcutBinding(binding), binding, `${binding} should be persisted unchanged`);
}
assert.equal(normalizeVoiceShortcutBinding('KeyV'), '', 'typing keys alone must be rejected');

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'chat', 'voice-shortcut.js'), 'utf8');
const listeners = new Map();
const windowListeners = new Map();
let clicks = 0;
let now = 1000;
let activePersonId = 'alpha';
const people = [
  { id: 'alpha', preferences: { voiceShortcut: { enabled: false, binding: '' } } },
  { id: 'beta', preferences: { voiceShortcut: { enabled: true, binding: 'Alt*3' } } },
];
const button = { disabled: false, click() { clicks += 1; } };
const document = {
  getElementById(id) { return id === 'voiceBtn' ? button : null; },
  addEventListener(type, handler) { listeners.set(type, handler); },
};
const window = {
  document,
  remotelabT: (key) => key,
  addEventListener(type, handler) { windowListeners.set(type, handler); },
};
vm.runInNewContext(source, {
  window,
  document,
  currentPerson: { get id() { return activePersonId; } },
  getPeopleDirectory: () => people,
  Date: { now: () => now },
});

function key(type, code, extra = {}) {
  let prevented = false;
  listeners.get(type)({
    code,
    key: code.startsWith('Alt') ? 'Alt' : code,
    altKey: code.startsWith('Alt'),
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault() { prevented = true; },
    ...extra,
  });
  return prevented;
}

function optionTap() {
  key('keydown', 'AltLeft');
  now += 80;
  key('keyup', 'AltLeft');
  now += 80;
}

function shiftTap() {
  key('keydown', 'ShiftLeft', { shiftKey: true });
  now += 80;
  key('keyup', 'ShiftLeft', { shiftKey: false });
  now += 80;
}

optionTap(); optionTap(); optionTap();
assert.equal(clicks, 0, 'a disabled Person should not trigger another Person’s shortcut');

people[0].preferences.voiceShortcut.enabled = true;
optionTap(); optionTap(); optionTap();
assert.equal(clicks, 0, 'enabling without recorded keys must not activate any shortcut');
people[0].preferences.voiceShortcut.binding = 'Alt*3';
optionTap(); optionTap(); optionTap();
assert.equal(clicks, 1, 'explicitly selecting three Option taps should activate voice once');
optionTap(); optionTap();
assert.equal(clicks, 1, 'two Option taps should not activate voice');
windowListeners.get('blur')();
optionTap();
assert.equal(clicks, 1, 'switching away from the page should discard partial taps');
optionTap(); optionTap();
assert.equal(clicks, 2, 'three new taps after focus returns should activate voice');
now += 700;
optionTap();
assert.equal(clicks, 2, 'a long gap should reset the Option tap count');
optionTap(); optionTap();
assert.equal(clicks, 3, 'a fresh three-tap sequence should activate voice');
optionTap(); optionTap();
document.hidden = true;
listeners.get('visibilitychange')();
document.hidden = false;
optionTap();
assert.equal(clicks, 3, 'hiding the page should discard partial taps');

people[0].preferences.voiceShortcut.binding = 'Shift*2';
shiftTap(); shiftTap();
assert.equal(clicks, 4, 'two Shift taps should activate voice once');
shiftTap();
key('keydown', 'KeyA', { shiftKey: true });
shiftTap();
assert.equal(clicks, 4, 'typing between Shift taps should cancel the sequence');
now += 700;
shiftTap(); shiftTap();
assert.equal(clicks, 5, 'Shift taps after the timeout should start a fresh sequence');
people[0].preferences.voiceShortcut.binding = 'Alt+Shift';
key('keydown', 'AltLeft');
assert.equal(clicks, 5, 'the first modifier alone should not activate voice');
assert.equal(key('keydown', 'ShiftLeft', { altKey: true, shiftKey: true }), true);
assert.equal(clicks, 6, 'Shift plus Option should activate voice without a third key');
key('keydown', 'ShiftLeft', { altKey: true, shiftKey: true, repeat: true });
assert.equal(clicks, 6, 'modifier key repeat should not activate voice again');
assert.equal(window.RemoteLabVoiceShortcut.getBindingConflict('Meta+KeyO'), 'newSession');
assert.equal(window.RemoteLabVoiceShortcut.getBindingConflict('Ctrl+Meta+KeyO'), 'newSession');
assert.equal(window.RemoteLabVoiceShortcut.getBindingConflict('Ctrl+KeyR'), 'browser');
assert.equal(window.RemoteLabVoiceShortcut.getBindingConflict('Alt+Shift'), '');

people[0].preferences.voiceShortcut.binding = 'Ctrl+Shift+KeyV';
assert.equal(key('keydown', 'KeyV', { ctrlKey: true, shiftKey: true }), true);
assert.equal(clicks, 7, 'a configured chord should activate voice');
key('keydown', 'KeyV', { ctrlKey: true });
assert.equal(clicks, 7, 'the modifier set must match exactly');
window.RemoteLabVoiceShortcut.setRecording(true);
key('keydown', 'KeyV', { ctrlKey: true, shiftKey: true });
assert.equal(clicks, 7, 'recording a new shortcut must not activate voice');
window.RemoteLabVoiceShortcut.setRecording(false);
button.disabled = true;
key('keydown', 'KeyV', { ctrlKey: true, shiftKey: true });
assert.equal(clicks, 7, 'the shortcut must honor the voice button disabled state');

assert.equal(window.RemoteLabVoiceShortcut.bindingFromEvent({ code: 'KeyV', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+KeyV');
assert.equal(window.RemoteLabVoiceShortcut.bindingFromEvent({ code: 'KeyV' }), '', 'bare typing keys should not be recorded');
assert.equal(window.RemoteLabVoiceShortcut.bindingFromEvent({ code: 'F8' }), 'F8');
assert.equal(window.RemoteLabVoiceShortcut.modifierChordFromEvent({ code: 'AltLeft', altKey: true, shiftKey: true }), 'Alt+Shift');
assert.equal(window.RemoteLabVoiceShortcut.formatBinding('Shift*2'), 'Shift ×2');

// Reproduce the real settings sequence, including the response arriving after the next click.
const settingsSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'chat', 'settings-ui.js'), 'utf8');
const settingsBlock = settingsSource.split('let voiceShortcutRecording = false;')[1]?.split('let pushNotificationPermissionPending = false;')[0];
assert.ok(settingsBlock, 'voice shortcut settings code should be available');
function control() {
  const handlers = new Map();
  return {
    dataset: {}, disabled: false, checked: false, textContent: '', hidden: false,
    addEventListener(type, handler) { handlers.set(type, handler); },
    setAttribute(name, value) { this[name] = value; },
    fire(type) { handlers.get(type)(); },
  };
}
const enabledControl = control();
const bindingLabel = control();
const recordControl = control();
const clearControl = control();
const tripleControl = control();
const statusControl = control();
const savedPeople = [{ id: 'alpha', preferences: { voiceShortcut: { enabled: false, binding: '' } } }];
const pending = [];
const settingsDocumentListeners = new Map();
const settingsContext = vm.createContext({
  window: { RemoteLabVoiceShortcut: window.RemoteLabVoiceShortcut, addEventListener() {} },
  document: {
    addEventListener(type, handler) { settingsDocumentListeners.set(type, handler); },
    removeEventListener(type, handler) {
      if (settingsDocumentListeners.get(type) === handler) settingsDocumentListeners.delete(type);
    },
  },
  currentPerson: { id: 'alpha' },
  getPeopleDirectory: () => savedPeople,
  requestPeople: (_url, options) => new Promise((resolve) => {
    const preference = JSON.parse(options.body).voiceShortcut;
    pending.push({
      preference,
      resolve() {
        savedPeople[0].preferences.voiceShortcut = preference;
        resolve({ people: savedPeople });
      },
    });
  }),
  voiceShortcutEnabled: enabledControl,
  voiceShortcutBinding: bindingLabel,
  voiceShortcutRecordBtn: recordControl,
  voiceShortcutClearBtn: clearControl,
  voiceShortcutTripleOptionBtn: tripleControl,
  voiceShortcutStatus: statusControl,
  t: (key, vars) => `${key}${vars?.binding ? ` ${vars.binding}` : ''}`,
});
vm.runInContext(`let voiceShortcutRecording = false;${settingsBlock}initVoiceShortcutSettings();`, settingsContext);
enabledControl.checked = true;
enabledControl.fire('change');
assert.equal(enabledControl.checked, true, 'saving the enable switch must not immediately undo the click');
tripleControl.fire('click');
assert.equal(enabledControl.checked, true, 'choosing three Option taps must not turn off the enable switch');
assert.equal(pending.length, 1, 'the first request should save the switch');
assert.deepEqual(pending[0].preference, { enabled: true, binding: '' });
pending[0].resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pending.length, 2, 'a rapid binding change should be saved after the switch');
assert.deepEqual(pending[1].preference, { enabled: true, binding: 'Alt*3' });
pending[1].resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(enabledControl.checked, true, 'the switch should remain on after both responses');
assert.deepEqual(savedPeople[0].preferences.voiceShortcut, { enabled: true, binding: 'Alt*3' });
clearControl.fire('click');
assert.equal(enabledControl.checked, true, 'clearing the binding should not disable keyboard support');
pending[2].resolve();
await new Promise((resolve) => setImmediate(resolve));
tripleControl.fire('click');
assert.deepEqual(pending[3].preference, { enabled: true, binding: 'Alt*3' },
  'choosing the binding after the switch has saved must also preserve enabled');
pending[3].resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(enabledControl.checked, true);

function recordKey(type, code, extra = {}) {
  settingsDocumentListeners.get(type)?.({
    code, altKey: code.startsWith('Alt'), ctrlKey: false, shiftKey: false,
    metaKey: false, repeat: false, preventDefault() {}, stopPropagation() {},
    ...extra,
  });
}
recordControl.fire('click');
assert.match(recordControl.textContent, /finishRecording/, 'the button should say that a second click finishes recording');
assert.match(statusControl.textContent, /waiting/, 'the UI should say that it is waiting for keys');
assert.equal(pending.length, 4, 'starting recording should not save anything');
recordKey('keydown', 'KeyV', { ctrlKey: true, shiftKey: true });
assert.match(statusControl.textContent, /detected.*Ctrl \+ Shift \+ V/, 'the detected shortcut should be shown before saving');
assert.equal(pending.length, 4, 'pressing a key should not save until the second click');
recordControl.fire('click');
assert.equal(pending.length, 5);
assert.deepEqual(pending[4].preference, { enabled: true, binding: 'Ctrl+Shift+KeyV' });
pending[4].resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.match(statusControl.textContent, /saved.*Ctrl \+ Shift \+ V/);

recordControl.fire('click');
recordKey('keydown', 'ShiftLeft', { shiftKey: true });
recordKey('keyup', 'ShiftLeft');
recordKey('keydown', 'ShiftLeft', { shiftKey: true });
recordKey('keyup', 'ShiftLeft');
assert.match(statusControl.textContent, /detected.*Shift ×2/, 'two Shift taps should be shown before saving');
recordControl.fire('click');
assert.deepEqual(pending[5].preference, { enabled: true, binding: 'Shift*2' });
pending[5].resolve();
await new Promise((resolve) => setImmediate(resolve));

recordControl.fire('click');
recordKey('keydown', 'ShiftLeft', { shiftKey: true });
recordKey('keydown', 'AltLeft', { shiftKey: true, altKey: true });
assert.match(statusControl.textContent, /detected.*Option \+ Shift/, 'modifier-only chord should be shown before saving');
recordControl.fire('click');
assert.deepEqual(pending[6].preference, { enabled: true, binding: 'Alt+Shift' });
pending[6].resolve();
await new Promise((resolve) => setImmediate(resolve));

recordControl.fire('click');
recordKey('keydown', 'KeyO', { metaKey: true });
assert.match(statusControl.textContent, /conflict.newSession/, 'in-page shortcut collision should be reported');
recordControl.fire('click');
assert.equal(pending.length, 7, 'an in-page collision must not be saved');
recordKey('keydown', 'KeyR', { ctrlKey: true });
assert.match(statusControl.textContent, /conflict.browser/, 'likely browser shortcut collision should be reported');
recordControl.fire('click');
assert.deepEqual(pending[7].preference, { enabled: true, binding: 'Ctrl+KeyR' });
pending[7].resolve();
await new Promise((resolve) => setImmediate(resolve));

recordControl.fire('click');
for (let i = 0; i < 3; i += 1) {
  recordKey('keydown', 'AltLeft');
  recordKey('keyup', 'AltLeft');
}
assert.match(statusControl.textContent, /detected.*Option ×3/, 'three Option taps should be detected during recording');
assert.equal(pending.length, 8);
recordControl.fire('click');
assert.deepEqual(pending[8].preference, { enabled: true, binding: 'Alt*3' });
pending[8].resolve();
await new Promise((resolve) => setImmediate(resolve));
recordControl.fire('click');
recordControl.fire('click');
assert.equal(pending.length, 9, 'finishing without keys should not change the saved shortcut');
assert.match(statusControl.textContent, /noKeys/);
recordControl.fire('click');
recordKey('keydown', 'Escape');
assert.equal(pending.length, 9, 'Escape cancels without saving');
assert.match(statusControl.textContent, /cancelled/);
console.log('test-chat-voice-shortcut: ok');
