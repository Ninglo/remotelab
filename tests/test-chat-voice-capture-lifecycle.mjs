import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../static/chat/voice-input.js', import.meta.url), 'utf8');
const permissions = [], sockets = [], events = [], processors = [], idleTimers = new Map(), listeners = new Map();
const audioContexts = [], startupTimers = new Map();
let stallAudio = false, resumeCalls = 0;
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
  constructor() { this.sampleRate = 16000; this.destination = {}; this.state = 'suspended'; audioContexts.push(this); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
  createScriptProcessor() { const node = { connect() {}, disconnect() {} }; processors.push(node); return node; }
  resume() { resumeCalls++; if (stallAudio) return new Promise(() => {}); this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
const doc = { hidden: false, getElementById(id) { return id === 'voiceBtn' ? button : null; },
  addEventListener(type, fn) { listeners.set(type, fn); } };
const browser = {
  document: doc,
  location: { protocol: 'https:', host: 'test.example' }, WebSocket: Socket, AudioContext: Audio,
  navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => permissions.push({ resolve, reject })) } },
  remotelabGetVoiceInputInstanceSettings: () => ({ provider: 'doubao', appId: 'fixture', accessToken: 'fixture', resourceId: 'fixture' }),
  remotelabT: key => key, addEventListener() {}, dispatchEvent(event) { events.push(event); },
  setTimeout(fn, ms) {
    const timers = ms === 60000 ? idleTimers : ms === 5000 ? startupTimers : null;
    if (timers) { const id = {}; timers.set(id, fn); return id; }
    return setTimeout(fn, ms);
  },
  clearTimeout(id) { idleTimers.delete(id); startupTimers.delete(id); clearTimeout(id); },
};
const context = vm.createContext({ window: browser, msgInput: input, get currentSessionId() { return session; },
  getCurrentSession: () => ({ id: session }), WebSocket: Socket,
  Event: class { constructor(type) { this.type = type; } },
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  console: { info() {}, warn() {}, error() {} }, Float32Array, Uint8Array, Int16Array, DataView, ArrayBuffer,
});
vm.runInContext(source, context);
const capture = browser.remotelabVoiceCapture;
let lastTrack;
const stream = () => { const track = { enabled: true, readyState: 'live', stop() { stoppedTracks++; this.readyState = 'ended'; } };
  lastTrack = track; return { getTracks: () => [track] }; };
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
const old = sockets[0];
assert.equal(capture.getState().phase, 'recording', 'local recording starts while the recognizer is connecting');
processors.at(-1).onaudioprocess({ inputBuffer: { sampleRate: 16000, getChannelData: () => new Float32Array([0.1, 0.2, 0.3]) } });
await capture.stop(); assert.equal(capture.getState().phase, 'stopping', 'release preserves audio when the socket is still connecting');
assert.equal(processors.at(-1).onaudioprocess, null, 'the fallback processor cannot stream silence after release');
assert.equal(lastTrack.enabled, false, 'release silences the microphone immediately');
old.readyState = 1; await old.emit('open'); await old.emit('message', { type: 'status', phase: 'ready' });
assert.ok(old.sent.some(data => data instanceof ArrayBuffer), 'early PCM is buffered and delivered when recognition is ready');
assert.equal(JSON.parse(old.sent.at(-1)).type, 'stop', 'buffered audio precedes the stop signal');
await capture.cancel();
starting = capture.start(); await starting; await flush();
assert.equal(permissions.length, 0, 'a consecutive take reuses the existing microphone stream');
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
assert.equal(lastTrack.enabled, false, 'a retained stream never listens between takes');
for (const expire of idleTimers.values()) expire();
assert.equal(lastTrack.readyState, 'ended', 'idle expiry releases the device');

input.value = ''; const preparing = capture.prepare();
permissions.shift().resolve(stream()); await preparing;
assert.equal(capture.getState().phase, 'idle', 'first authorization does not start dictation');
assert.equal(lastTrack.enabled, false); assert.equal(sockets.length, 2);
doc.hidden = true; listeners.get('visibilitychange')(); await flush();
assert.equal(lastTrack.readyState, 'ended', 'backgrounding releases the retained microphone');
doc.hidden = false;
const latePreparation = capture.prepare(); capture.releaseMicrophone();
permissions.shift().resolve(stream()); await latePreparation;
assert.equal(lastTrack.readyState, 'ended', 'late authorization cannot retain a microphone after leaving');

stallAudio = true;
const beforeResumeCalls = resumeCalls;
let stalled = capture.prepare();
audioContexts.at(-1).state = 'interrupted';
assert.equal(capture.prepare(), stalled, 'the hold timer shares the gesture preparation');
assert.equal(resumeCalls - beforeResumeCalls, 1, 'one preparation resumes audio only once');
assert.equal(startupTimers.size, 0, 'the permission prompt has no audio-start deadline');
permissions.shift().resolve(stream()); await flush();
assert.equal(lastTrack.enabled, false, 'a device acquired during stalled startup stays silent');
capture.releaseMicrophone();
assert.equal(await stalled, null, 'cancellation settles without waiting for a stuck resume promise');
assert.equal(lastTrack.readyState, 'ended', 'cancellation releases the device while resume is stuck');
assert.equal(startupTimers.size, 0);

stalled = capture.prepare(); const timedOut = assert.rejects(stalled, { code: 'VOICE_AUDIO_START_TIMEOUT' });
permissions.shift().resolve(stream()); await flush();
assert.equal(startupTimers.size, 1);
for (const expire of [...startupTimers.values()]) expire();
await timedOut;
assert.equal(capture.getState().microphonePreparing, false, 'a startup timeout unlocks the button');
assert.equal(capture.getState().microphoneError, 'voice.mobile.audioPaused');
assert.equal(lastTrack.readyState, 'ended');
assert.equal(audioContexts.at(-1).state, 'closed');

stallAudio = false;
const retry = capture.prepare(); permissions.shift().resolve(stream()); await retry;
assert.equal(capture.getState().microphoneError, '', 'a fresh gesture clears the startup error');
assert.equal(audioContexts.at(-1).state, 'running', 'the next gesture can start a fresh audio context');
const interrupted = audioContexts.at(-1); interrupted.state = 'interrupted';
const recover = capture.prepare(); permissions.shift().resolve(stream()); await recover;
assert.equal(interrupted.state, 'closed', 'an interrupted context is replaced inside the next gesture');
capture.releaseMicrophone();

stallAudio = true;
stalled = capture.prepare();
capture.releaseMicrophone();
assert.equal(await stalled, null);
permissions.shift().resolve(stream()); await flush();
assert.equal(lastTrack.readyState, 'ended', 'a late grant is released even if its audio resume never resolves');
assert.equal(startupTimers.size, 0);
console.log('test-chat-voice-capture-lifecycle: startup timeout/retry, interrupted audio, cancellable preparation, quiet microphone reuse, buffered startup, late permission, session changes and stale finals passed');
