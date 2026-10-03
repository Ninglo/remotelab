import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkboardPatch } from '../lib/workboard-state.mjs';
import { workboardContext, workboardReadback } from '../lib/workboard-context.mjs';

const board = { taskId: 'task-1', revision: 1, goal: '交付', status: 'running', reason: '',
  items: ['a', 'b'].map(id => ({ id, title: id, condition: `验收 ${id}`, status: 'pending', evidenceRefs: [] })) };
const event = (seq, value) => ({ seq, type: 'message', role: 'assistant', source: 'workboard_checklist', runId: 'run-1', workboard: value });
const proof = { seq: 3, type: 'tool_result', output: 'verification passed', exitCode: 0 };
const history = [event(2, board), proof];

test('state delta preserves criteria and assigns a revision; identical retry is idempotent', () => {
  const patch = { taskId: 'task-1', items: [{ id: 'a', status: 'done', evidenceRefs: [3] }] };
  const result = normalizeWorkboardPatch(patch, { history, runId: 'run-2' });
  assert.equal(result.board.revision, 2);
  assert.deepEqual(result.board.items[1], board.items[1]);
  assert.equal(result.board.items[0].condition, board.items[0].condition);
  assert.equal(normalizeWorkboardPatch(patch, { history: [...history, event(4, result.board)] }).duplicate, true);
});

test('delta still requires suitable verification and cannot silently change scope or withdraw done', () => {
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'task-1', items: [{ id: 'a', status: 'done' }] }, { history }), /evidenceRefs/);
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'task-1', items: [{ id: 'a', status: 'done', evidenceRefs: [99] }] }, { history }), /evidence/);
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'task-1', goal: '改目标' }, { history }), /scope/);
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'task-1', items: [{ id: 'a', title: '改标题' }] }, { history }), /criteria/);
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'task-1', items: [{ id: 'missing', status: 'done' }] }, { history }), /Unknown/);
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'task-1', expectedRevision: 9 }, { history }), /conflict/);
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'missing' }, { history }), /not found/);
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'task-1', status: 'completed' }, { history }), /every deliverable/);
  const done = normalizeWorkboardPatch({ taskId: 'task-1', items: [{ id: 'a', status: 'done', evidenceRefs: [3] }] }, { history }).board;
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'task-1', items: [{ id: 'a', status: 'running' }] },
    { history: [...history, event(4, done)] }), /reason/);
  const failed = { ...proof, exitCode: 1 };
  assert.throws(() => normalizeWorkboardPatch({ taskId: 'task-1', items: [{ id: 'a', status: 'done', evidenceRefs: [3] }] },
    { history: [event(2, board), failed] }), /Failed tool result/);
});

test('completed task context carries an index, full acceptance remains available on demand', () => {
  const done = { ...board, status: 'completed', items: board.items.map(item => ({ ...item, status: 'done', evidenceRefs: [3] })) };
  const oldActive = { ...board, taskId: 'older-active' };
  const events = [event(1, oldActive), proof, event(4, done),
    ...Array.from({ length: 4 }, (_, i) => event(5 + i, { ...done, taskId: `closed-${i}` }))];
  const context = workboardContext(events);
  assert.equal(context.activeTasks[0].taskId, 'older-active', 'completed cards must not displace unfinished work');
  assert.equal(context.recentTasks.length, 3);
  assert.equal(context.recentTasks[0].items, undefined);
  const readback = workboardReadback(events, 'task-1');
  assert.deepEqual(readback.task.items, done.items);
  assert.equal(readback.evidence[0].seq, 3);
  assert.throws(() => workboardReadback(events, 'missing'), /not found/);
  assert.ok(JSON.stringify(context.recentTasks).length < JSON.stringify(events.slice(-3).map(e => e.workboard)).length / 2);
});

test('resolving a blocker clears its stale reason without weakening withdrawal requirements', () => {
  const blocked = { ...board, status: 'blocked', reason: '等待权限',
    items: board.items.map(item => ({ ...item, status: 'done', evidenceRefs: [3] })) };
  const result = normalizeWorkboardPatch({ taskId: board.taskId, status: 'completed' }, { history: [event(2, blocked), proof] });
  assert.equal(result.board.reason, '');
  assert.equal(result.board.status, 'completed');
});
