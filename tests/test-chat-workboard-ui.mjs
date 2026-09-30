import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.textContent = '';
    this.className = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute() {}
}

const container = new Element('div');
const context = {
  document: { createElement: tag => new Element(tag), querySelectorAll: () => [] },
  currentSessionId: 'pilot',
  getSessionActivity: session => session.activity,
  setTimeout: () => 1,
  clearTimeout() {},
};
vm.createContext(context);
vm.runInContext(await readFile(new URL('../static/chat/workboard-ui.js', import.meta.url), 'utf8'), context);

const now = Date.now();
context.updateSessionWorkboardSession({
  id: 'pilot', workboardPilot: true, lastEventAt: now,
  activity: { run: { state: 'running', startedAt: new Date(now).toISOString() } },
});
const checklist = '任务：交付两项结果\n说明：完成后逐项核对。结果应可在本会话查看。\n[ ] 第一项 — 核对第一份结果。\n[ ] 第二项 — 核对第二份结果。';
const user = { seq: 1, type: 'message', role: 'user' };
const first = { seq: 3, type: 'message', role: 'assistant', source: 'workboard_checklist', content: checklist };
const updated = { ...first, seq: 5, content: checklist.replace('[ ] 第一项', '[x] 第一项') };
const result = { seq: 7, type: 'message', role: 'assistant', content: '最终结果' };
const raw = [
  user,
  { seq: 2, type: 'thinking_block', blockStartSeq: 2, blockEndSeq: 2 },
  first,
  { seq: 4, type: 'thinking_block', blockStartSeq: 4, blockEndSeq: 4 },
  updated,
  { seq: 6, type: 'thinking_block', blockStartSeq: 6, blockEndSeq: 6 },
  result,
];
assert.equal(context.updateSessionWorkboardEvents('pilot', raw), raw);
const projected = context.projectSessionWorkboardTranscriptEvents('pilot', raw);
assert.deepEqual(Array.from(projected, event => event.type), ['message', 'message', 'message'],
  'a pilot turn shows the user, one inline checklist, and one result');
assert.equal(projected[1].seq, first.seq, 'the inline checklist keeps its original position');
assert.equal(projected[1].workboardUpdateSeq, updated.seq, 'later updates replace the same checklist');
assert.equal(projected[1].content, updated.content);
assert.equal(projected[2].displayBoundarySeq, result.seq);
assert.equal(projected[1].workboardCurrentTurn, true);
assert.equal(raw.length, 7, 'raw Session history remains unchanged');

const card = context.renderSessionWorkboardMessage(container, projected[1]);
assert.equal(container.children.length, 1);
assert.equal(card.className, 'session-workboard-inline');
assert.equal(card.children[0].children[0].textContent, '任务：交付两项结果');
assert.equal(card.children[0].children[1].textContent, '1/2');
assert.match(card.children[1].textContent, /完成后逐项核对/);
const list = card.children.find(child => child.tagName === 'ul');
assert.equal(list.children.length, 2, 'each deliverable starts a separate row');
assert.equal(list.children[0].children[1].children[0].textContent, '第一项');
assert.equal(list.children[0].children[1].children[1].textContent, ' — 核对第一份结果。');
assert.equal(card.children.at(-1).textContent, '运行中');

const stale = context.updateSessionWorkboardEvents('pilot', raw.slice(0, 3));
assert.equal(stale, raw, 'a late older response cannot roll progress back');
const completed = { ...updated, seq: 8, content: updated.content.replace('[ ] 第二项', '[x] 第二项') };
const completedProjection = context.projectSessionWorkboardTranscriptEvents('pilot', [...raw, completed]);
assert.equal(completedProjection.filter(event => event.source === 'workboard_checklist').length, 1);
assert.equal(completedProjection.find(event => event.source === 'workboard_checklist').seq, first.seq);
const completedCard = context.renderSessionWorkboardMessage(new Element('div'),
  completedProjection.find(event => event.source === 'workboard_checklist'));
assert.equal(completedCard.children[0].children[1].textContent, '2/2');

const anotherTurn = [...raw, { seq: 8, type: 'message', role: 'user' },
  { seq: 9, type: 'thinking_block', blockStartSeq: 9, blockEndSeq: 9 }];
const history = context.projectSessionWorkboardTranscriptEvents('pilot', anotherTurn);
assert.equal(history.filter(event => event.source === 'workboard_checklist').length, 1);
assert.equal(history.find(event => event.source === 'workboard_checklist').workboardCurrentTurn, false);
assert.equal(history.at(-1).type, 'thinking_block', 'short turns without a checklist retain native display');

context.fetchJsonOrRedirect = async () => ({ run: { id: 'run-1', state: 'failed' } });
context.updateSessionWorkboardSession({ id: 'pilot', workboardPilot: true, activity: { run: { state: 'idle' } } });
context.updateSessionWorkboardEvents('pilot', [
  { seq: 10, type: 'message', role: 'user', runId: 'run-1' },
  { ...first, seq: 11 },
]);
await new Promise(setImmediate);
assert.equal(context.sessionWorkboardRunLabel(), '运行失败',
  'the inline card reads terminal failure from the native Run');
context.updateSessionWorkboardSession({
  id: 'pilot', workboardPilot: true,
  workState: { workflow: { state: 'waiting_user' } },
  activity: { run: { state: 'idle' } },
});
assert.equal(context.sessionWorkboardRunLabel(), '需要你处理');

context.updateSessionWorkboardSession({ id: 'other', workboardPilot: false, activity: { run: { state: 'idle' } } });
assert.equal(context.projectSessionWorkboardTranscriptEvents('other', raw), raw,
  'other Sessions retain their original transcript');
assert.equal(context.isSessionWorkboardMessage(first), false);

const css = await readFile(new URL('../static/chat/chat-messages.css', import.meta.url), 'utf8');
assert.doesNotMatch(css.match(/\.session-workboard-inline\s*\{([^}]*)\}/)?.[1] || '', /position:\s*sticky/);
const html = await readFile(new URL('../templates/chat.html', import.meta.url), 'utf8');
assert.doesNotMatch(html, /sessionWorkboardPanel/, 'no floating panel remains in the page');
console.log('test-chat-workboard-ui: ok');
