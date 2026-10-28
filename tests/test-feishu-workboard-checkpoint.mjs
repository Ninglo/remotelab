import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkboardEventReader } from '../connectors/feishu/workboard-event-reader.mjs';
import { collectFeishuWorkboardCycles } from '../connectors/feishu/workboard-pilot.mjs';

const root = await mkdtemp(join(tmpdir(), 'workboard-checkpoint-'));
const histories = new Map(['a', 'b', 'c'].map(id => [id, Array.from({ length: 2001 }, (_, i) => ({
  seq: i + 1, type: 'tool_result', runId: id, timestamp: i, output: 'large unneeded tool body',
}))]));
for (const [id, events] of histories) {
  events[0] = { seq: 1, type: 'message', role: 'user', runId: id, sourceContext: { sender: { openId: 'person' } } };
  events[1] = { seq: 2, type: 'message', role: 'assistant', runId: id, source: 'workboard_checklist', content: '目标：结果\n[ ] 核对 — 可读' };
  events[2000] = { seq: 2001, type: 'message', role: 'assistant', runId: id, phase: 'commentary', content: '<progress>跨页结果</progress>' };
}
const calls = [];
let failBody = false;
const request = async path => {
  const url = new URL(path, 'http://fixture');
  const [, , , id, , bodySeq] = url.pathname.split('/');
  const events = histories.get(id);
  assert.equal(url.searchParams.get('cacheRead'), 'false');
  if (bodySeq) {
    if (failBody) { failBody = false; throw new Error('read failed'); }
    return { body: { field: 'content', value: events[Number(bodySeq) - 1].content } };
  }
  const after = Number(url.searchParams.get('afterSeq'));
  calls.push({ id, after });
  return { events: events.slice(after, after + 2000).map(event => event.type === 'message' && event.role === 'assistant'
    ? { ...event, content: '', bodyAvailable: true, bodyLoaded: false } : event),
  headSeq: events.length, nextAfterSeq: Math.max(after, Math.min(after + 2000, events.length)), hasMore: events.length > after + 2000 };
};
const make = () => createWorkboardEventReader(request, { checkpointDir: root, maxSessions: 1, maxPages: 1 });
try {
  let reader = make();
  for (const id of histories.keys()) assert.equal((await reader.read(id, { skipAcknowledged: true })).hasMore, true);
  reader = make(); // Restart with three incomplete Sessions and just one payload slot.
  for (const [id, history] of histories) {
    const result = await reader.read(id, { skipAcknowledged: true, renderKey: 'v1' });
    assert.equal(result.hasMore, false);
    assert.equal(result.events.length, 2001);
    const pilot = { sessionId: id, senderOpenId: 'person', cards: [], startedAfterSeq: 0 };
    assert.deepEqual(collectFeishuWorkboardCycles(result.events, pilot), collectFeishuWorkboardCycles(history, pilot));
  }
  assert.deepEqual(calls.map(c => c.after), [0, 0, 0, 2000, 2000, 2000], 'eviction/restart never rewinds a committed page');
  reader = make();
  assert.equal((await reader.read('a', { skipAcknowledged: true, renderKey: 'v1' })).events.length, 2001,
    'unacknowledged publication must replay even without new input');
  await reader.acknowledge('a', 2001, 'v1');
  reader = make();
  assert.equal((await reader.read('a', { skipAcknowledged: true, renderKey: 'v1' })).events, null,
    'successful unchanged restart requires only the tail query');
  assert.equal((await reader.read('a', { skipAcknowledged: true, renderKey: 'v2' })).events.length, 2001,
    'renderer/policy change reloads the saved projection');
  const next = { seq: 2002, type: 'message', role: 'assistant', runId: 'a', phase: 'final_answer', content: '完成' };
  histories.get('a').push(next); failBody = true;
  await assert.rejects(reader.read('a'), /read failed/);
  reader = make();
  const recovered = await reader.read('a');
  assert.equal(recovered.events.length, 2002);
  assert.equal(recovered.events.at(-1).content, '完成');
  assert.deepEqual(calls.filter(c => c.id === 'a').slice(-2).map(c => c.after), [2001, 2001], 'failed hydration never advances persisted position');
  assert(recovered.events.filter(e => e.type === 'tool_result').every(e => !('output' in e)));
  histories.set('a', histories.get('a').slice(0, 2));
  const reset = await reader.read('a');
  assert.equal(reset.hasMore, true, 'head reset yields before rebuilding within the page budget');
  assert.equal((await reader.read('a')).events.length, 2, 'head reset discards only the derived old projection');
  console.log('PASS: checkpoint restart, eviction, unchanged skip, pending publication, policy invalidation, failed body retry and identical projection');
} finally { await rm(root, { recursive: true, force: true }); }
