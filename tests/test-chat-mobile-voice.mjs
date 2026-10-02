import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../static/chat/mobile-voice.js', import.meta.url), 'utf8');
function fixture({ mobile = true, mode = 'text', base = '', attachments = false, permission = true } = {}) {
  let now = 1000, nextId = 0, starts = 0, stops = 0, cancels = 0, sends = 0, owner = 'alpha', session = 'session-a';
  let pendingReview = null, failSave = false;
  const timers = new Map(), globalListeners = new Map(), requests = [];
  const people = [{ id: 'alpha', preferences: { mobileInputMode: mode } }, { id: 'beta', preferences: { mobileInputMode: 'text' } }];
  function element(id) {
    const listeners = new Map();
    return { id, hidden: false, disabled: false, value: '', textContent: '', title: '', style: { setProperty() {} },
      classList: { toggle() {} }, closest() { return { classList: { toggle() {} } }; },
      setAttribute() {}, blur() {}, focus() {}, setPointerCapture() {},
      getBoundingClientRect() { return id === 'mobileVoiceCancel'
        ? { left: 0, right: 100, top: 0, bottom: 50 } : { left: 200, right: 300, top: 0, bottom: 50 }; },
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      dispatchEvent(event) { event.currentTarget = this; for (const fn of listeners.get(event.type) || []) fn(event); },
      emit(type, extra = {}) { this.dispatchEvent({ type, pointerId: 1, button: 0, isPrimary: true,
        clientX: 150, clientY: 150, detail: 1, preventDefault() {}, stopImmediatePropagation() {}, ...extra }); },
    };
  }
  const elements = Object.fromEntries(['msgInput', 'voiceBtn', 'mobileVoiceHold', 'mobileVoiceMode', 'mobileVoicePanel',
    'mobileVoiceStatus', 'mobileVoiceDuration', 'mobileVoiceTranscript', 'mobileVoiceCancel', 'mobileVoiceEdit',
    'mobileVoiceRelease', 'mobileVoicePreferenceStatus'].map(id => [id, element(id)]));
  const input = elements.msgInput; input.value = base;
  const doc = element('document'); doc.hidden = false; doc.getElementById = id => elements[id];
  const media = { matches: mobile, addEventListener(type, fn) { this.change = fn; } };
  const emit = (type, detail) => { for (const fn of globalListeners.get(type) || []) fn({ detail }); };
  let state = { captureId: 0, phase: 'idle' };
  const change = phase => { state.phase = phase; emit('remotelab:voice-state-change', { ...state }); };
  const controller = {
    getState: () => ({ ...state }),
    start() { starts++; state = { captureId: starts, phase: permission ? 'recording' : 'requesting' }; change(state.phase); return Promise.resolve(); },
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
  const tick = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  return { elements, browser, doc, input, media, people, requests, tick, change,
    get counts() { return { starts, stops, cancels, sends }; },
    hold() { elements.voiceBtn.emit('pointerdown'); tick(300); },
    release() { elements.voiceBtn.emit('pointerup'); },
    finish(text) { input.value = base ? `${base} ${text}` : text; input.emit('input', { isTrusted: false });
      emit('remotelab:voice-transcript-complete', { captureId: state.captureId, transcript: text }); change('idle'); },
    review(value) { pendingReview = value; }, switchSession(value) { session = value; browser.remotelabRefreshMobileVoiceUi(); },
    switchOwner(value) { owner = value; browser.remotelabRefreshMobileVoiceUi({ preferences: true }); },
    failSave() { failSave = true; }, attachments(value) { attachments = value; },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

let f = fixture();
f.elements.voiceBtn.emit('pointerdown'); f.tick(100); f.release(); f.tick(300);
assert.equal(f.counts.starts, 0, 'short taps must not open the microphone');
f.elements.voiceBtn.emit('click'); await flush();
assert.equal(f.requests[0].mobileInputMode, 'voice');
assert.equal(f.elements.mobileVoiceHold.hidden, false);
assert.equal(f.input.hidden, true);
f.elements.mobileVoiceMode.emit('click'); await flush();
assert.equal(f.people[0].preferences.mobileInputMode, 'text');

f = fixture(); f.hold(); f.release();
assert.equal(f.counts.stops, 1); assert.equal(f.counts.sends, 0);
f.finish('请检查运行状态'); await flush();
assert.equal(f.counts.sends, 1, 'only a final transcript after release is automatically sent');
f.finish('迟到的重复结果'); await flush(); assert.equal(f.counts.sends, 1);
assert.equal(f.requests.length, 0, 'temporary holds must not change the saved mode');
f.elements.voiceBtn.emit('click'); assert.equal(f.requests.length, 0, 'the synthetic click after a hold must be consumed');

f = fixture(); f.hold(); f.finish('尚未松手'); await flush(); assert.equal(f.counts.sends, 0);
f.release(); await flush(); assert.equal(f.counts.sends, 1);

f = fixture({ base: '未写完的草稿' }); f.hold(); f.release(); f.finish('补充内容'); await flush();
assert.equal(f.counts.sends, 0); assert.equal(f.input.value, '未写完的草稿 补充内容');
f = fixture({ attachments: true }); f.hold(); f.release(); f.finish('附件说明'); await flush();
assert.equal(f.counts.sends, 0, 'attachments require an explicit Send');
f = fixture(); f.hold(); f.attachments(true); f.release(); f.finish('新附件'); await flush(); assert.equal(f.counts.sends, 0);

f = fixture({ base: '保留草稿' }); f.hold(); f.input.value = '保留草稿 临时语音';
f.elements.voiceBtn.emit('pointermove', { clientX: 50, clientY: 25 }); f.release();
assert.equal(f.input.value, '保留草稿'); assert.equal(f.counts.cancels, 1);
f = fixture(); f.hold(); f.elements.voiceBtn.emit('pointermove', { clientX: 250, clientY: 25 });
f.release(); f.finish('改字再发'); await flush(); assert.equal(f.counts.sends, 0); assert.equal(f.input.value, '改字再发');

f = fixture({ permission: false }); f.hold(); f.release();
assert.equal(f.counts.cancels, 1); assert.equal(f.counts.stops, 0, 'release while permission is pending cancels the attempt');
f = fixture(); f.hold(); f.elements.voiceBtn.emit('pointercancel'); assert.equal(f.counts.cancels, 1);
f = fixture(); f.hold(); f.release(); f.doc.hidden = true; f.doc.emit('visibilitychange');
f.finish('后台迟到结果'); await flush(); assert.equal(f.counts.sends, 0);
f = fixture(); f.hold(); f.release(); f.switchSession('session-b'); f.finish('旧会话结果');
await flush(); assert.equal(f.counts.sends, 0);

f = fixture(); f.hold(); f.release(); f.tick(30000); f.finish('超时结果'); await flush(); assert.equal(f.counts.sends, 0);
f = fixture(); let resolveReview;
f.review(new Promise(resolve => { resolveReview = resolve; })); f.hold(); f.release(); f.finish('识别原文');
await flush(); assert.equal(f.counts.sends, 0, 'automatic sending waits for the existing optional cleanup');
f.input.value = '整理后的文字'; resolveReview({ after: f.input.value }); await flush(); assert.equal(f.counts.sends, 1);
f = fixture(); f.review(new Promise(resolve => { resolveReview = resolve; })); f.hold(); f.release(); f.finish('识别原文');
f.elements.mobileVoiceCancel.emit('click'); resolveReview({ after: '识别原文' }); await flush(); assert.equal(f.counts.sends, 0);
f = fixture(); f.hold(); f.release(); f.input.value = '用户修改'; f.input.emit('input', { isTrusted: true });
f.finish('迟到结果'); await flush(); assert.equal(f.counts.sends, 0, 'manual edits prevent automatic submission');

f = fixture({ mode: 'voice' }); assert.equal(f.elements.mobileVoiceHold.hidden, false);
f.switchOwner('beta'); assert.equal(f.elements.mobileVoiceHold.hidden, true, 'another Person starts in their own mode');
f = fixture({ mobile: false, mode: 'voice' }); assert.equal(f.input.hidden, false); f.elements.voiceBtn.emit('click');
assert.equal(f.requests.length, 0, 'the mobile preference does not change desktop click behavior');
f = fixture(); f.failSave(); f.elements.voiceBtn.emit('click'); await flush();
assert.equal(f.elements.mobileVoiceHold.hidden, true, 'a failed save must not pretend the preference was persisted');
console.log('test-chat-mobile-voice: touch, cancellation, stale results, cleanup, drafts and mode isolation passed');
