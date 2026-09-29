import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.hidden = false;
    this.textContent = '';
    this.className = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
}

const panel = new Element('section');
const context = {
  document: { getElementById: () => panel, createElement: tag => new Element(tag) },
  currentSessionId: 'pilot',
  getSessionActivity: session => session.activity,
  cancelBtn: { click() {} },
  fetchJsonOrRedirect: async () => ({ run: { id: 'run-1', state: 'completed' } }),
  setTimeout: () => 1,
  clearTimeout() {},
};
vm.createContext(context);
vm.runInContext(await readFile(new URL('../static/chat/workboard-ui.js', import.meta.url), 'utf8'), context);

const now = Date.now();
context.updateSessionWorkboardSession({
  id: 'pilot', workboardPilot: true, workboardGate: { needsChecklist: true },
  lastEventAt: now,
  activity: { run: { state: 'running', runId: 'run-1', startedAt: new Date(now - 10 * 60_000).toISOString() } },
});
const firstSnapshot = [
  { seq: 1, type: 'message', role: 'user', runId: 'run-1' },
  { seq: 2, type: 'message', role: 'assistant', source: 'workboard_checklist', workboardUpdateSeq: 2,
    content: '任务：交付两项结果\n说明：完成后逐项核对。结果应可在本会话查看。\n[ ] 第一项 — 核对第一份结果。\n[ ] 第二项 — 核对第二份结果。' },
];
context.updateSessionWorkboardEvents('pilot', firstSnapshot);
assert.equal(context.isSessionWorkboardMessage(firstSnapshot[1]), true,
  'the current checklist appears in the workboard instead of the transcript');
assert.equal(context.isSessionWorkboardMessage({ type: 'message', role: 'assistant', content: 'ordinary reply' }), false);
assert.equal(panel.hidden, false);
assert.equal(panel.children.find(item => item.className === 'session-workboard-heading')?.textContent, '交付两项结果');
assert.match(panel.children.find(item => item.className === 'session-workboard-description')?.textContent, /逐项核对/);
const progress = panel.children.find(item => item.tagName === 'progress');
assert.equal(progress.value, 0);
assert.equal(progress.max, 2);
const list = panel.children.find(item => item.tagName === 'ul');
assert.equal(list?.children.length, 2);
assert.equal(list.children[0].tagName, 'li');
assert.equal(list.children[1].tagName, 'li', 'the next deliverable starts a separate row');
assert.equal(list.children[0].children[1].children[0].textContent, '第一项');
assert.equal(list.children[0].children[1].children[1].textContent, ' — 核对第一份结果。');
context.updateSessionWorkboardEvents('pilot', [
  firstSnapshot[0],
  { ...firstSnapshot[1], workboardUpdateSeq: 3,
    content: firstSnapshot[1].content.replace('[ ] 第一项', '[x] 第一项') },
]);
assert.equal(panel.children.filter(item => item.tagName === 'ul').length, 1,
  'one checklist updates in place instead of stacking cards');
assert.equal(panel.children.find(item => item.tagName === 'progress').value, 1);
context.updateSessionWorkboardEvents('pilot', firstSnapshot);
assert.equal(panel.children.find(item => item.tagName === 'progress').value, 1,
  'an older response cannot roll back visible progress');
context.updateSessionWorkboardEvents('pilot', [
  firstSnapshot[0], firstSnapshot[1],
  { seq: 3, type: 'message', role: 'assistant', source: 'workboard_checklist', content: '[x] 第一项 — 核对第一份结果。' },
  { seq: 4, type: 'message', role: 'user', content: '下一轮' },
]);
assert.equal(context.isSessionWorkboardMessage(firstSnapshot[1]), true,
  'an older update is hidden once a later update exists in that turn');
assert.equal(context.isSessionWorkboardMessage({ seq: 3, type: 'message', role: 'assistant', source: 'workboard_checklist' }), true,
  'history remains in the workboard instead of adding transcript cards');
context.updateSessionWorkboardSession({
  id: 'pilot', workboardPilot: true, workboardGate: { needsChecklist: false },
  activity: { run: { state: 'idle' } },
});
assert.equal(panel.children.find(item => item.className === 'session-workboard-label')?.textContent, '最近一次清单 · 1/1');
context.updateSessionWorkboardSession({
  id: 'pilot', workboardPilot: true, workboardGate: { needsChecklist: true },
  lastEventAt: now,
  activity: { run: { state: 'running', runId: 'run-1', startedAt: new Date(now - 10 * 60_000).toISOString() } },
});
assert.match(panel.children.find(item => item.className === 'session-workboard-monitor')?.children[0]?.textContent, /运行中/,
  'a fresh numeric event timestamp must keep a long Run from looking stalled');

context.updateSessionWorkboardSession({
  id: 'pilot', workboardPilot: true, workboardGate: { needsChecklist: true },
  lastEventAt: now - 10 * 60_000,
  activity: { run: { state: 'running', runId: 'run-1', startedAt: new Date(now - 10 * 60_000).toISOString() } },
});
assert.match(panel.children.find(item => item.className === 'session-workboard-monitor')?.children[0]?.textContent, /疑似停滞/);

context.updateSessionWorkboardSession({
  id: 'pilot', workboardPilot: true, workboardGate: { needsChecklist: true },
  workState: { workflow: { state: 'waiting_user' } },
  activity: { run: { state: 'idle' } },
});
assert.match(panel.children.find(item => item.className === 'session-workboard-monitor')?.children[0]?.textContent, /需要你处理/,
  'a user blocker remains visible after the Run becomes idle');

context.updateSessionWorkboardSession({ id: 'other', workboardPilot: false, activity: { run: { state: 'idle' } } });
assert.equal(panel.hidden, true, 'the workboard must remain absent from other Sessions');
assert.equal(context.isSessionWorkboardMessage({ type: 'message', role: 'assistant', source: 'workboard_checklist' }), false,
  'a non-pilot Session retains its normal transcript');
console.log('test-chat-workboard-ui: ok');
