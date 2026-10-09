import assert from 'node:assert/strict';
import { createWorkboardEventReader } from '../connectors/feishu/workboard-event-reader.mjs';
import { collectFeishuWorkboardCycles } from '../connectors/feishu/workboard-pilot.mjs';

const history = Array.from({ length: 6000 }, (_, i) => ({ seq: i + 1, type: 'tool_result',
  runId: 'run', timestamp: i, output: 'unneeded tool output'.repeat(100) }));
history[0] = { seq: 1, type: 'message', role: 'user', runId: 'run', content: 'private input',
  sourceContext: { sender: { openId: 'person' } } };
history[1] = { seq: 2, type: 'message', role: 'assistant', runId: 'run',
  source: 'workboard_checklist', content: '目标：交付\n[ ] 核验 — 可以核对' };
history[1999] = { seq: 2000, type: 'message', role: 'assistant', runId: 'run',
  phase: 'commentary', content: '<progress>跨页保留进展</progress>' };
history[5999] = { seq: 6000, type: 'message', role: 'assistant', runId: 'run', phase: 'final_answer', content: '结果' };
const calls = [];
let failBody = false;
const request = async path => {
  calls.push(path);
  const url = new URL(path, 'http://fixture');
  const bodySeq = url.pathname.match(/\/events\/(\d+)\/body$/)?.[1];
  if (bodySeq) {
    if (failBody) { failBody = false; throw new Error('body unavailable'); }
    return { body: { field: 'content', value: history[Number(bodySeq) - 1].content } };
  }
  const after = Number(url.searchParams.get('afterSeq'));
  const end = Math.min(history.length, after + Number(url.searchParams.get('limit')));
  assert.equal(url.searchParams.get('includeBodies'), 'false');
  return { events: history.slice(after, end).map(event => event.type === 'message'
    ? { ...event, content: '', bodyAvailable: true, bodyLoaded: false } : event),
  nextAfterSeq: end, hasMore: end < history.length };
};
const reader = createWorkboardEventReader(request, { maxPages: 2 });
let projected = await reader.read('s');
assert.equal(projected.hasMore, true, 'cold bootstrap yields after bounded pages');
assert.equal(projected.events.length, 4000);
projected = await reader.read('s');
assert.equal(projected.hasMore, false);
const pilot = { sessionId: 's', senderOpenId: 'person', cards: [], startedAfterSeq: 0 };
assert.deepEqual(collectFeishuWorkboardCycles(projected.events, pilot), collectFeishuWorkboardCycles(history, pilot),
  'authorization, original anchor, cross-page progress and final closure stay unchanged');
assert.ok(projected.events.filter(e => e.type === 'tool_result').every(e => !('output' in e)));
assert.equal(calls.filter(path => path.endsWith('/body')).length, 3, 'user/tool bodies are never fetched');
const before = calls.length;
await reader.read('s');
assert.equal(calls.length, before + 1);
assert.match(calls.at(-1), /afterSeq=6000/);
history.push({ seq: 6001, type: 'message', role: 'assistant', runId: 'run', phase: 'commentary', content: '<progress>新增</progress>' });
failBody = true;
await assert.rejects(reader.read('s'), /body unavailable/);
projected = await reader.read('s');
assert.equal(projected.events.at(-1).content, '<progress>新增</progress>');
assert.equal(projected.events.filter(e => e.seq === 6001).length, 1, 'failed reads advance no cursor and duplicate no event');
const lastPageReads = calls.filter(path => path.includes('afterSeq=6000'));
assert.equal(lastPageReads.length, 3);
console.log('test-feishu-workboard-event-reader: ok (bounded pages, incremental refresh, no tool bodies, safe retry)');
