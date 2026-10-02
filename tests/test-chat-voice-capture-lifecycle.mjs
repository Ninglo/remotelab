import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../static/chat/voice-input.js', import.meta.url), 'utf8');
const permissions = [], sockets = [], events = [];
let session = 'a', stoppedTracks = 0;
const input = { value: '', disabled: false, dispatchEvent() {} };
const button = { dataset: {}, classList: { toggle() {} }, style: { setProperty() {} }, querySelector() {},
  addEventListener() {}, setAttribute() {} };
class Socket {
  static OPEN = 1;
  constructor() { this.readyState = 0; this.listeners = new Map(); this.sent = []; sockets.push(this); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  emit(type, payload = {}) { return this.listeners.get(type)?.({ ...payload, data: JSON.stringify(payload) }); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; void this.emit('close', { code: 1000 }); }
}
class Audio {
  constructor() { this.sampleRate = 16000; this.destination = {}; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {} }; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
const browser = {
  document: { getElementById(id) { return id === 'voiceBtn' ? button : null; } },
  location: { protocol: 'https:', host: 'test.example' }, WebSocket: Socket, AudioContext: Audio,
  navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => permissions.push({ resolve, reject })) } },
  remotelabGetVoiceInputInstanceSettings: () => ({ provider: 'doubao', appId: 'fixture', accessToken: 'fixture', resourceId: 'fixture' }),
  remotelabT: key => key, addEventListener() {}, dispatchEvent(event) { events.push(event); },
  setTimeout, clearTimeout,
};
const context = vm.createContext({ window: browser, msgInput: input, get currentSessionId() { return session; },
  getCurrentSession: () => ({ id: session }), WebSocket: Socket,
  Event: class { constructor(type) { this.type = type; } },
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  console: { info() {}, warn() {}, error() {} }, Float32Array, Uint8Array, Int16Array, DataView, ArrayBuffer,
});
vm.runInContext(source, context);
const capture = browser.remotelabVoiceCapture;
const stream = () => ({ getTracks: () => [{ stop() { stoppedTracks++; } }] });
const flush = () => new Promise(resolve => setImmediate(resolve));

let starting = capture.start(); assert.equal(capture.getState().phase, 'requesting');
await capture.cancel(); permissions.shift().resolve(stream()); await starting;
assert.equal(stoppedTracks, 1); assert.equal(sockets.length, 0, 'a late permission grant must not start recording after release');

starting = capture.start(); session = 'b'; input.value = '另一会话草稿';
permissions.shift().resolve(stream()); await starting;
assert.equal(stoppedTracks, 2); assert.equal(sockets.length, 0); assert.equal(input.value, '另一会话草稿');

input.value = ''; starting = capture.start(); permissions.shift().reject(new Error('denied'));
await assert.rejects(starting, /denied/); assert.equal(capture.getState().phase, 'idle');

starting = capture.start(); permissions.shift().resolve(stream()); await starting; await flush();
const old = sockets[0]; old.readyState = 1; await old.emit('open');
await old.emit('message', { type: 'status', phase: 'ready' }); assert.equal(capture.getState().phase, 'recording');
await capture.cancel();
starting = capture.start(); permissions.shift().resolve(stream()); await starting; await flush();
const active = sockets[1]; active.readyState = 1; await active.emit('open');
await active.emit('message', { type: 'status', phase: 'ready' });
await old.emit('message', { type: 'transcript', transcript: '旧录音迟到结果' });
await old.emit('close', { code: 1006 });
assert.equal(input.value, ''); assert.equal(capture.getState().phase, 'recording', 'old socket callbacks must not clean up a newer recording');
const id = capture.getState().captureId;
await capture.stop(); assert.equal(capture.getState().phase, 'stopping');
await active.emit('message', { type: 'done', transcript: '最终文字' });
assert.equal(input.value, '最终文字'); assert.equal(capture.getState().phase, 'idle');
const completed = events.filter(event => event.type === 'remotelab:voice-transcript-complete');
assert.equal(completed.length, 1); assert.equal(completed[0].detail.captureId, id);
await active.emit('message', { type: 'done', transcript: '重复结果' });
assert.equal(input.value, '最终文字');
console.log('test-chat-voice-capture-lifecycle: late permission, session changes, denial, old sockets and duplicate finals passed');
