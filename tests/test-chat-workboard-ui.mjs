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
assert.deepEqual(Array.from(projected, event => event.type), ['message', 'thinking_block', 'message', 'message'],
  'a pilot turn keeps one expandable thinking block, one checklist, and one result');
assert.equal(projected[1].blockStartSeq, 2);
assert.equal(projected[1].blockEndSeq, 6, 'the disclosure spans thinking before and after checklist updates');
assert.equal(projected[2].seq, first.seq, 'the inline checklist keeps its original position');
assert.equal(projected[2].workboardUpdateSeq, updated.seq, 'later updates replace the same checklist');
assert.equal(projected[2].content, updated.content);
assert.equal(projected[3].displayBoundarySeq, result.seq);
assert.equal(projected[2].workboardCurrentTurn, false, 'the final result closes the live run badge');
assert.equal(raw.length, 7, 'raw Session history remains unchanged');
const serverCoalesced = context.projectSessionWorkboardTranscriptEvents('pilot', [
  user, { ...updated, seq: first.seq, workboardUpdateSeq: updated.seq },
]);
assert.equal(serverCoalesced[1].displayBoundarySeq, updated.seq,
  'a server-coalesced update still advances the native event boundary');

const card = context.renderSessionWorkboardMessage(container, projected[2]);
assert.equal(container.children.length, 1);
assert.equal(card.className, 'session-workboard-inline');
assert.equal(card.children[0].children[0].textContent, '目标：交付两项结果');
assert.equal(card.children[0].children[1].textContent, '1/2');
assert.match(card.children[1].textContent, /完成后逐项核对/);
const list = card.children.find(child => child.tagName === 'ul');
assert.equal(list.children.length, 2, 'each deliverable starts a separate row');
assert.equal(list.children[0].children[1].children[0].textContent, '第一项');
assert.equal(list.children[0].children[1].children[1].textContent, ' — 核对第一份结果。');
assert.equal(card.children.at(-1).className, 'session-workboard-progress', 'the progress area follows the list without a live run badge');
const goalCard = context.renderSessionWorkboardMessage(new Element('div'), {
  ...projected[2],
  content: '目标：一条可更新的清单\n[ ] 核验 — 进度可见。',
});
assert.equal(goalCard.children[0].children[0].textContent, '目标：一条可更新的清单');
const structured = { ...first, workboard: { taskId: 'task-fixed', goal: '保留验收条件', status: 'blocked', reason: '等待权限',
  items: [{ id: 'a', title: '交付', condition: '同一原卡读回', status: 'done' },
    { id: 'b', title: '送达', condition: '有发送回执', status: 'pending' }] }, workboardStatusLabel: '等待条件：等待权限' };
const structuredProjection = context.projectSessionWorkboardTranscriptEvents('pilot', [user, structured,
  { ...updated, source: '', messageKind: 'todo_list', content: '[x] 读代码' }]);
assert.equal(structuredProjection.filter(event => event.source === 'workboard_checklist').length, 1);
assert.equal(structuredProjection.length, 2, 'native steps never replace a structured public card');
const blockedCard = context.renderSessionWorkboardMessage(new Element('div'), structuredProjection[1]);
assert.equal(blockedCard.children[0].children[1].textContent, '1/2');
assert.equal(blockedCard.children.at(-1).textContent, '等待条件：等待权限');
const progressCard = context.renderSessionWorkboardMessage(new Element('div'), {
  ...structured, workboardProgress: { seq: 8, content: '验证已通过，正在推送' },
  workboardProgressHistory: [{ seq: 6, content: '已定位重复任务 ID' }, { seq: 8, content: '验证已通过，正在推送' }],
});
const progressArea = progressCard.children.find(child => child.className === 'session-workboard-progress');
const standaloneProgress = { seq: 9, type: 'message', role: 'assistant', messageKind: 'progress_panel',
  workboardProgress: { seq: 11, content: '最新核验结果' },
  workboardProgressHistory: [{ seq: 9, content: '之前的发现' }, { seq: 11, content: '最新核验结果' }],
  workboardStatusLabel: '执行已结束，结果见最终答复' };
assert.equal(context.isSessionWorkboardMessage(standaloneProgress), true);
const standaloneCard = context.renderSessionWorkboardMessage(new Element('div'), standaloneProgress);
assert.equal(standaloneCard.children[0].children[0].textContent, '本轮进展');
assert.equal(standaloneCard.children[0].children.length, 1, 'no fabricated acceptance count');
assert.equal(standaloneCard.children.some(child => child.tagName === 'ul'), false, 'no fabricated checklist');
assert.equal(standaloneCard.children.at(-1).textContent, standaloneProgress.workboardStatusLabel);
assert.equal(progressArea.children[1].textContent, '验证已通过，正在推送');
assert.equal(progressArea.children[2].tagName, 'details');
assert.equal(progressArea.children[2].children[1].textContent, '已定位重复任务 ID');
assert.equal(progressCard.dataset.taskId, 'task-fixed');
assert.equal(progressCard.dataset.anchorSeq, String(first.seq));

const earlyCardUpdate = { ...structured, workboardUpdateSeq: 25 };
const newerTaskAnchor = { ...structured, seq: 10, workboardUpdateSeq: 20, workboard: { ...structured.workboard, taskId: 'later-task' } };
const currentSnapshot = [user, earlyCardUpdate, newerTaskAnchor];
context.updateSessionWorkboardEvents('pilot', currentSnapshot);
assert.equal(context.updateSessionWorkboardEvents('pilot', [user, { ...earlyCardUpdate, workboardUpdateSeq: 24 }, newerTaskAnchor]), currentSnapshot,
  'a stale response cannot undo progress on an earlier card when another task follows it');
// Restore the earlier fixture for the legacy snapshot checks below.
context.updateSessionWorkboardSession({ id: 'other', workboardPilot: false, activity: { run: { state: 'idle' } } });
context.updateSessionWorkboardSession({ id: 'pilot', workboardPilot: true, activity: { run: { state: 'running', startedAt: new Date(now).toISOString() } } });
context.updateSessionWorkboardEvents('pilot', raw);

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

const steered = context.projectSessionWorkboardTranscriptEvents('pilot', [
  user,
  { seq: 2, type: 'thinking_block', blockStartSeq: 2, blockEndSeq: 2 },
  first,
  { seq: 4, type: 'message', role: 'user', content: '也要能展开思考' },
  { seq: 5, type: 'thinking_block', blockStartSeq: 5, blockEndSeq: 5 },
  { ...updated, seq: 6 },
]);
assert.equal(steered.filter(event => event.source === 'workboard_checklist').length, 1,
  'steering an unfinished task updates its original checklist');
assert.equal(steered.find(event => event.source === 'workboard_checklist').seq, first.seq);
assert.equal(steered.find(event => event.source === 'workboard_checklist').workboardUpdateSeq, 6);
assert.equal(steered.find(event => event.source === 'workboard_checklist').workboardCurrentTurn, true);
assert.equal(steered.filter(event => event.type === 'thinking_block').length, 2,
  'each user turn retains an expandable thinking disclosure');
const activeCard = context.renderSessionWorkboardMessage(new Element('div'),
  steered.find(event => event.source === 'workboard_checklist'));
assert.equal(activeCard.children.at(-1).textContent, '运行中');

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
