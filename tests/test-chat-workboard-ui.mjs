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
context.updateSessionWorkboardEvents('pilot', [
  { seq: 1, type: 'message', role: 'user', runId: 'run-1' },
  { seq: 2, type: 'message', role: 'assistant', source: 'workboard_checklist', content: '[x] 第一项\n[ ] 第二项' },
]);
assert.equal(panel.hidden, false);
const progress = panel.children.find(item => item.tagName === 'progress');
assert.equal(progress.value, 1);
assert.equal(progress.max, 2);
assert.equal(panel.children.find(item => item.tagName === 'ul')?.children.length, 2);
assert.match(panel.children.find(item => item.className === 'session-workboard-monitor')?.children[0]?.textContent, /运行中/,
  'a fresh numeric event timestamp must keep a long Run from looking stalled');

context.updateSessionWorkboardSession({
  id: 'pilot', workboardPilot: true, workboardGate: { needsChecklist: true },
  lastEventAt: now - 10 * 60_000,
  activity: { run: { state: 'running', runId: 'run-1', startedAt: new Date(now - 10 * 60_000).toISOString() } },
});
assert.match(panel.children.find(item => item.className === 'session-workboard-monitor')?.children[0]?.textContent, /疑似停滞/);

context.updateSessionWorkboardSession({ id: 'other', workboardPilot: false, activity: { run: { state: 'idle' } } });
assert.equal(panel.hidden, true, 'the workboard must remain absent from other Sessions');
console.log('test-chat-workboard-ui: ok');
