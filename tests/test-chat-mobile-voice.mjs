import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../static/chat/mobile-voice.js', import.meta.url), 'utf8');
function fixture({ mobile = true, mode = 'text', base = '', attachments = false, permission = true, authorized = true } = {}) {
  let now = 1000, nextId = 0, starts = 0, stops = 0, cancels = 0, sends = 0, owner = 'alpha', session = 'session-a';
  let pendingReview = null, failSave = false, grantPreparation;
  const timers = new Map(), frames = new Map(), globalListeners = new Map(), requests = [];
  const people = [{ id: 'alpha', preferences: { mobileInputMode: mode } }, { id: 'beta', preferences: { mobileInputMode: 'text' } }];
  function element(id) {
    const listeners = new Map();
    return { id, hidden: false, disabled: false, value: '', textContent: '', title: '', focused: false,
      style: { setProperty(key, value) { this[key] = value; } },
      classList: { toggle() {} }, closest() { return { classList: { toggle() {} } }; },
      setAttribute() {}, blur() { this.focused = false; }, focus() { this.focused = true; }, setPointerCapture() {},
      getBoundingClientRect() { return id === 'mobileVoiceCancel'
        ? { left: 0, right: 100, top: 0, bottom: 50 } : { left: 200, right: 300, top: 0, bottom: 50 }; },
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      dispatchEvent(event) { event.currentTarget = this; for (const fn of listeners.get(event.type) || []) {
        fn(event); if (event.stopped) break;
      } },
      emit(type, extra = {}) { this.dispatchEvent({ type, pointerId: 1, button: 0, isPrimary: true,
        clientX: 150, clientY: 150, detail: 1, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...extra }); },
    };
  }
  const elements = Object.fromEntries(['msgInput', 'voiceBtn', 'mobileVoiceHold', 'mobileVoiceMode', 'mobileVoiceModeIcon', 'mobileVoiceDraft', 'mobileVoicePanel',
    'mobileVoiceStatus', 'mobileVoiceDuration', 'mobileVoiceTranscript', 'mobileVoiceCancel',
    'mobileVoiceRelease', 'mobileVoicePreferenceStatus', 'sendBtn'].map(id => [id, element(id)]));
  const bars = Array.from({ length: 13 }, (_, index) => element(`bar-${index}`));
  elements.mobileVoicePanel.querySelectorAll = () => bars;
  const input = elements.msgInput; input.value = base;
  const doc = element('document'); doc.hidden = false; doc.getElementById = id => elements[id];
  const media = { matches: mobile, addEventListener(type, fn) { this.change = fn; } };
  const emit = (type, detail) => { for (const fn of globalListeners.get(type) || []) fn({ detail }); };
  let state = { captureId: 0, phase: 'idle', microphoneAuthorized: authorized };
  const change = phase => { state.phase = phase; emit('remotelab:voice-state-change', { ...state }); };
  const controller = {
    getState: () => ({ ...state }),
    prepare() {
      if (state.microphoneAuthorized) return Promise.resolve({});
      state.microphonePreparing = true;
      return new Promise(resolve => { grantPreparation = resolve; }).then(stream => {
        state.microphonePreparing = false; state.microphoneAuthorized = true; change('idle'); return stream;
      });
    },
    releaseMicrophone() {},
    start() { starts++; state = { captureId: starts, phase: permission ? 'recording' : 'requesting', microphoneAuthorized: true }; change(state.phase); return Promise.resolve(); },
    stop() { stops++; change('stopping'); return Promise.resolve(); },
    cancel() { cancels++; change('idle'); return Promise.resolve(); },
    whenIdle: () => Promise.resolve(),
  };
  const browser = {
    document: doc, navigator: { vibrate() {} }, remotelabVoiceCapture: controller, matchMedia: () => media,
    remotelabT: key => key, remotelabWaitForVoiceReview: () => pendingReview,
    addEventListener(type, fn) { if (!globalListeners.has(type)) globalListeners.set(type, []); globalListeners.get(type).push(fn); },
    setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++nextId; }, clearInterval() {},
    requestAnimationFrame(fn) { const id = ++nextId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const context = vm.createContext({ window: browser, msgInput: input, Date: { now: () => now },
    get currentPerson() { return { id: owner }; }, get currentSessionId() { return session; }, shareSnapshotMode: false,
    getPeopleDirectory: () => people, replacePeopleDirectory(next) { people.splice(0, people.length, ...next); },
    getComposerAttachmentsSnapshot: () => attachments ? [{}] : [], sendMessage() { sends++; input.value = ''; },
    Event: class { constructor(type) { this.type = type; } },
    async fetchJsonOrRedirect(path, options) {
      const body = JSON.parse(options.body); requests.push({ path, ...body });
      if (failSave) throw new Error('offline');
      people.find(person => path.endsWith(person.id)).preferences.mobileInputMode = body.mobileInputMode;
      return { people: structuredClone(people) };
    },
  });
  vm.runInContext(source, context);
  elements.sendBtn.addEventListener('click', () => context.sendMessage());
  const tick = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  return { elements, browser, doc, input, media, people, requests, tick, change,
    frame(level) { state.voiceLevel = level; now += 16; for (const [id, fn] of [...frames]) { frames.delete(id); fn(now); } },
    get heights() { return bars.map(bar => parseFloat(bar.style['--voice-bar-height'])); },
    get frameCount() { return frames.size; },
    get counts() { return { starts, stops, cancels, sends }; },
    hold() { elements.voiceBtn.emit('pointerdown'); tick(300); },
    release() { elements.voiceBtn.emit('pointerup'); },
    finish(text) { input.value = base ? `${base} ${text}` : text; input.emit('input', { isTrusted: false });
      emit('remotelab:voice-transcript-complete', { captureId: state.captureId, transcript: text }); change('idle'); },
    review(value) { pendingReview = value; }, switchSession(value) { session = value; browser.remotelabRefreshMobileVoiceUi(); },
    switchOwner(value) { owner = value; browser.remotelabRefreshMobileVoiceUi({ preferences: true }); },
    failSave() { failSave = true; }, attachments(value) { attachments = value; },
    grant() { grantPreparation({}); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

let first = fixture({ mode: 'voice', authorized: false });
assert.equal(first.elements.mobileVoiceHold.textContent, 'voice.mobile.enable');
first.hold(); first.release();
assert.equal(first.counts.starts, 0, 'the first permission gesture does not pretend to record');
first.grant(); await flush();
assert.equal(first.elements.mobileVoiceHold.textContent, 'voice.mobile.hold');
first.hold(); first.release(); first.finish('授权后再说话'); await flush();
assert.equal(first.counts.starts, 1); assert.equal(first.counts.sends, 0);

let f = fixture();
f.elements.voiceBtn.emit('pointerdown'); f.tick(100); f.release(); f.tick(300);
assert.equal(f.counts.starts, 0, 'short taps must not open the microphone');
f.elements.voiceBtn.emit('click'); await flush();
assert.equal(f.requests[0].mobileInputMode, 'voice');
assert.equal(f.elements.mobileVoiceHold.hidden, false);
assert.equal(f.input.hidden, true);
f.elements.mobileVoiceMode.emit('click'); await flush();
assert.equal(f.people[0].preferences.mobileInputMode, 'text');
assert.equal(f.elements.mobileVoiceMode.hidden, false, 'typing keeps the left switch available');
f.input.value = '已经打好的文字'; f.input.emit('input', { isTrusted: true });
f.elements.mobileVoiceMode.emit('click'); await flush();
assert.equal(f.elements.mobileVoiceHold.hidden, false, 'the same switch restores hold-to-talk with an existing draft');
assert.equal(f.input.value, '已经打好的文字', 'switching preserves the draft');
assert.equal(f.elements.mobileVoiceDraft.textContent, f.input.value);
f.elements.mobileVoiceMode.emit('click'); await flush();
assert.equal(f.input.hidden, false); assert.equal(f.elements.mobileVoiceDraft.hidden, true);

f = fixture(); f.hold(); f.release();
assert.equal(f.counts.stops, 1); assert.equal(f.counts.sends, 0);
f.elements.sendBtn.emit('click'); assert.equal(f.counts.sends, 0, 'partial recognition cannot be sent');
f.finish('请检查运行状态'); await flush();
assert.equal(f.counts.sends, 0, 'release leaves the final transcript unsent for review');
assert.equal(f.input.value, '请检查运行状态'); assert.equal(f.input.hidden, false);
assert.equal(f.input.focused, false, 'default review does not open the phone keyboard');
f.input.value = '请检查服务状态'; f.input.emit('input', { isTrusted: true });
f.elements.sendBtn.emit('click'); assert.equal(f.counts.sends, 1, 'edited text sends only after an explicit click');
assert.equal(f.requests.length, 0, 'temporary holds must not change the saved mode');
f.elements.voiceBtn.emit('click'); assert.equal(f.requests.length, 0, 'the synthetic click after a hold must be consumed');

f = fixture(); f.hold(); f.finish('尚未松手'); await flush(); assert.equal(f.counts.sends, 0);
f.release(); await flush(); assert.equal(f.counts.sends, 0); assert.equal(f.input.value, '尚未松手');

f = fixture({ base: '未写完的草稿' }); f.hold(); f.release(); f.finish('补充内容'); await flush();
assert.equal(f.counts.sends, 0); assert.equal(f.input.value, '未写完的草稿 补充内容');
f = fixture({ attachments: true }); f.hold(); f.release(); f.finish('附件说明'); await flush();
assert.equal(f.counts.sends, 0, 'attachments require an explicit Send');
f = fixture(); f.hold(); f.attachments(true); f.release(); f.finish('新附件'); await flush(); assert.equal(f.counts.sends, 0);

f = fixture({ base: '保留草稿' }); f.hold(); f.input.value = '保留草稿 临时语音';
f.elements.voiceBtn.emit('pointermove', { clientX: 150, clientY: 70 }); f.release();
assert.equal(f.input.value, '保留草稿'); assert.equal(f.counts.cancels, 1);
f = fixture(); f.hold(); f.elements.voiceBtn.emit('pointermove', { clientX: 250, clientY: 150 });
f.release(); f.finish('左右滑动不改变结果'); await flush(); assert.equal(f.input.value, '左右滑动不改变结果');
assert.equal(f.counts.sends, 0); assert.equal(f.input.focused, false);
f = fixture(); f.hold(); f.elements.voiceBtn.emit('pointermove', { clientY: 70 });
f.elements.voiceBtn.emit('pointermove', { clientY: 105 }); f.release(); f.finish('滑回来继续保留'); await flush();
assert.equal(f.input.value, '滑回来继续保留'); assert.equal(f.counts.cancels, 0, 'dragging back down restores review');

f = fixture({ permission: false }); f.hold(); f.release();
assert.equal(f.counts.cancels, 1); assert.equal(f.counts.stops, 0, 'release while permission is pending cancels the attempt');
f = fixture({ permission: false }); f.hold();
assert.equal(f.elements.mobileVoiceTranscript.textContent, 'voice.mobile.preparing', 'preparation never tells the user to speak');
f.release();
f = fixture(); f.hold(); f.elements.voiceBtn.emit('pointercancel'); assert.equal(f.counts.cancels, 1);
f = fixture(); f.hold(); f.release(); f.doc.hidden = true; f.doc.emit('visibilitychange');
f.finish('后台迟到结果'); await flush(); assert.equal(f.counts.sends, 0);
f = fixture(); f.hold(); f.release(); f.switchSession('session-b'); f.finish('旧会话结果');
await flush(); assert.equal(f.counts.sends, 0);

f = fixture(); f.hold(); f.release(); f.tick(30000); f.finish('超时结果'); await flush(); assert.equal(f.counts.sends, 0);
f = fixture(); let resolveReview;
f.review(new Promise(resolve => { resolveReview = resolve; })); f.hold(); f.release(); f.finish('识别原文');
await flush(); f.elements.sendBtn.emit('click');
assert.equal(f.counts.sends, 0, 'review waits for the existing optional cleanup');
f.input.value = '整理后的文字'; resolveReview({ after: f.input.value }); await flush(); assert.equal(f.counts.sends, 0);
assert.equal(f.input.value, '整理后的文字');
f.elements.sendBtn.emit('click'); assert.equal(f.counts.sends, 1);
f = fixture(); f.review(new Promise(resolve => { resolveReview = resolve; })); f.hold(); f.release(); f.finish('识别原文');
f.elements.mobileVoiceCancel.emit('click'); resolveReview({ after: '识别原文' }); await flush(); assert.equal(f.counts.sends, 0);
f = fixture(); f.hold(); f.release(); f.input.value = '用户修改'; f.input.emit('input', { isTrusted: true });
f.finish('迟到结果'); await flush(); assert.equal(f.counts.sends, 0, 'manual edits prevent automatic submission');

f = fixture(); f.hold();
for (let i = 0; i < 50; i++) f.frame(0);
assert.ok(f.heights.every(height => height === 4), 'silence stays flat without decorative animation');
for (let i = 0; i < 12; i++) f.frame(0.8);
assert.ok(Math.max(...f.heights) > 15 && Math.min(...f.heights) === 4, 'a real volume rise flows through distinct bars');
const burst = f.heights; f.frame(0.8);
assert.ok(f.heights.some((height, index) => height !== burst[index]), 'history moves smoothly between audio samples');
for (let i = 0; i < 110; i++) f.frame(0);
assert.ok(Math.max(...f.heights) < 4.1, 'silence settles the entire history');
f.release(); assert.equal(f.frameCount, 0, 'release stops audio animation');
f = fixture(); f.hold(); f.doc.hidden = true; f.doc.emit('visibilitychange');
assert.equal(f.frameCount, 0, 'backgrounding clears the animation handle');

f = fixture({ mode: 'voice' }); assert.equal(f.elements.mobileVoiceHold.hidden, false);
f.elements.voiceBtn.disabled = true; f.browser.remotelabRefreshMobileVoiceUi();
assert.equal(f.elements.mobileVoiceMode.disabled, false, 'unavailable voice input still allows switching back to typing');
f.switchOwner('beta'); assert.equal(f.elements.mobileVoiceHold.hidden, true, 'another Person starts in their own mode');
f = fixture({ mobile: false, mode: 'voice' }); assert.equal(f.input.hidden, false); f.elements.voiceBtn.emit('click');
assert.equal(f.requests.length, 0, 'the mobile preference does not change desktop click behavior');
f = fixture(); f.failSave(); f.elements.voiceBtn.emit('click'); await flush();
assert.equal(f.elements.mobileVoiceHold.hidden, true, 'a failed save must not pretend the preference was persisted');
console.log('test-chat-mobile-voice: review before manual send, natural volume history, cancellation, stale results, cleanup, drafts and mode isolation passed');
