import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-card-disclosure-'));
setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
const { writeJsonAtomic } = await import('../chat/fs-utils.mjs');
const { appendEvent, loadHistory } = await import('../chat/history.mjs');
const { findSessionMeta } = await import('../chat/session-meta-store.mjs');
const { updateProgressCardDisclosure } = await import('../chat/session-progress-policy.mjs');
const { createSessionDetail } = await import('../chat/session-api-shapes.mjs');
const { progressPolicyForCard } = await import('../lib/session-progress-policy.mjs');
const { handleFeishuProgressPolicyAction } = await import('../connectors/feishu/progress-policy-actions.mjs');
const { collectFeishuInstanceWorkboardCycles, buildFeishuWorkboardCard, publishFeishuWorkboardCycle }
  = await import('../connectors/feishu/workboard-pilot.mjs');
const conversation = { connector: 'feishu', sourceRouteId: 'bot',
  target: { chatId: 'group', chatType: 'group', conversationKind: 'thread', tenantKey: 'tenant' } };
await writeJsonAtomic(CHAT_SESSIONS_FILE, [{ id: 's', folder: home, tool: 'codex', workboardPilot: true, conversation }]);
const board = taskId => ({ taskId, goal: '真实交付', revision: 1, status: 'running', reason: '',
  items: [{ id: 'item', title: '交付', condition: '核对结果', status: 'pending', evidenceRefs: [] }] });
const user = runId => ({ type: 'message', role: 'user', runId, content: '继续工作',
  sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatId: 'group', chatType: 'group',
    tenantKey: 'tenant', messageId: `in-${runId}`, sender: { openId: 'person' } },
  workboardAdmission: { personId: 'person', identityId: 'identity', sourceRouteId: 'bot', senderOpenId: 'person' } });
await appendEvent('s', user('first'));
const first = await appendEvent('s', { type: 'message', role: 'assistant', runId: 'first', source: 'workboard_checklist', workboard: board('task-a') });
const progress = await appendEvent('s', { type: 'message', role: 'assistant', runId: 'first', phase: 'commentary', content: '<progress>详细的工作过程'.padEnd(330, '文') + '</progress>' });
const stateDir = join(home, 'cards');
await mkdir(stateDir);
await writeFile(join(stateDir, 'bot.json'), JSON.stringify({ sourceRouteId: 'bot', sessions: {
  s: { chatId: 'group', cards: [{ messageId: 'original', anchorSeq: first.seq, taskId: 'task-a' }] } } }));
const pilot = { scope: 'instance', sourceRouteId: 'bot', sessionId: 's', chatId: 'group', startedAfterSeq: 0,
  cards: [{ messageId: 'original', anchorSeq: first.seq, taskId: 'task-a', latestSeq: progress.seq }] };
const cycles = async () => collectFeishuInstanceWorkboardCycles(await loadHistory('s'), pilot, await findSessionMeta('s'));
const request = async (path, options = {}) => {
  if (options.method !== 'POST') return { response: { ok: true }, json: { session: createSessionDetail(await findSessionMeta('s')) } };
  assert.equal(path, '/api/sessions/s/progress-card');
  try { return { response: { ok: true }, json: { session: createSessionDetail(await updateProgressCardDisclosure('s', options.body)) } }; }
  catch (error) { return { response: { ok: false }, json: { error: error.message } }; }
};
const callback = (eventId, mode, extra = {}) => ({ header: { event_id: eventId, tenant_key: 'tenant' }, event: {
  context: { open_chat_id: 'group', open_message_id: 'original' }, operator: { open_id: 'person' },
  action: { value: { namespace: 'progress-card', sessionId: 's', anchorSeq: first.seq, revision: 0, mode, ...extra } } } });
const act = raw => handleFeishuProgressPolicyAction({ config: { sourceRouteId: 'bot' } }, raw,
  { request, stateDir, authorize: async summary => summary.sender.openId === 'person' });

test('latest summary is outside, history defaults hidden, and real clicks keep one message through updates', async () => {
  let [cycle] = await cycles();
  const collapsed = buildFeishuWorkboardCard(cycle.content, cycle.board, cycle.progress, cycle);
  assert.equal(collapsed.body.elements.find(e => e.tag === 'button').text.content, '点击显示进展');
  assert(collapsed.body.elements.some(e => e.content?.includes('详细的工作过程')));
  assert(collapsed.body.elements.every(e => e.content?.length < 220 || !e.content));
  assert.doesNotMatch(JSON.stringify(collapsed), /collapsible_panel|查看完整工作过程/);
  assert.equal((await act(callback('expand-a', 'expanded'))).toast.type, 'success');
  [cycle] = await cycles();
  const expanded = buildFeishuWorkboardCard(cycle.content, cycle.board, cycle.progress, cycle);
  assert.equal(expanded.body.elements.find(e => e.tag === 'button').text.content, '点击折叠进展');
  assert(expanded.body.elements.some(e => e.content?.length > 300), 'details retain text beyond the outer summary');
  const calls = [];
  const options = { pilot, persist: async () => {}, verifyMessage: async () => {}, app: { im: { v1: { message: {
    patch: async input => { calls.push(input); return { code: 0 }; },
  } } } } };
  await publishFeishuWorkboardCycle(cycle, options);
  await publishFeishuWorkboardCycle(cycle, options);
  assert.equal(calls.length, 1, 'presentation changes patch once, without creating another message');
  assert.equal(calls[0].path.message_id, 'original');
  assert.equal((await act(callback('collapse-b', 'collapsed'))).toast.type, 'success');
  await act(callback('expand-a', 'expanded'));
  assert.equal(progressPolicyForCard(await findSessionMeta('s'), first.seq).mode, 'collapsed', 'old retries cannot undo the last click');
  await appendEvent('s', { type: 'message', role: 'assistant', runId: 'first', phase: 'commentary', content: '<progress>下一步的发现</progress>' });
  await appendEvent('s', { type: 'message', role: 'assistant', runId: 'first', phase: 'final_answer', content: '结果' });
  assert.equal((await cycles())[0].cardDisclosure.mode, 'collapsed');
  await act(callback('expand-c', 'expanded'));
  await appendEvent('s', user('resumed'));
  await appendEvent('s', { type: 'message', role: 'assistant', runId: 'resumed', source: 'workboard_checklist', workboard: { ...board('task-a'), revision: 2 } });
  assert.equal((await cycles())[0].cardDisclosure.mode, 'expanded', 'completion and a resumed Run preserve the card choice');
  await appendEvent('s', user('other'));
  const second = await appendEvent('s', { type: 'message', role: 'assistant', runId: 'other', source: 'workboard_checklist', workboard: board('task-b') });
  assert.equal(progressPolicyForCard(await findSessionMeta('s'), second.seq, 'other').mode, 'collapsed', 'other cards do not inherit the choice');
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    "const {findSessionMeta}=await import('./chat/session-meta-store.mjs');console.log(JSON.stringify(await findSessionMeta('s')))"]);
  assert.equal(JSON.parse(child.stdout).feishuProgressCards[first.seq].mode, 'expanded', 'a fresh process keeps the manual state');
  const projected = createSessionDetail(await findSessionMeta('s'));
  assert.deepEqual(projected.feishuProgressCards[first.seq], { mode: 'expanded', revision: 3 });
});

test('callbacks validate the real message, anchor, tenant and operator; core rejects unlisted anchors', async () => {
  for (const change of [raw => { raw.event.context.open_message_id = 'forwarded'; },
    raw => { raw.event.action.value.anchorSeq = progress.seq; },
    raw => { raw.header.tenant_key = 'other'; }, raw => { raw.event.operator.open_id = 'outsider'; }]) {
    const raw = callback('forged', 'collapsed'); change(raw);
    assert.equal((await act(raw)).toast.type, 'error');
  }
  await assert.rejects(updateProgressCardDisclosure('s', { anchorSeq: progress.seq, mode: 'collapsed', changeId: 'x', actorOpenId: 'person' }), { status: 400 });
  assert.equal(progressPolicyForCard(await findSessionMeta('s'), first.seq).mode, 'expanded');
});


test('expanded card history stays below provider payload limits and cannot include future progress', () => {
  const history = Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, content: '详细'.repeat(2000) }));
  history.push({ seq: 100, content: '未来内容' });
  const card = buildFeishuWorkboardCard('', board('task'), { seq: 25, content: '最新发现' },
    { sessionId: 's', anchorSeq: 1, latestSeq: 25, progressHistory: history, cardDisclosure: { mode: 'expanded' } });
  assert(Buffer.byteLength(JSON.stringify(card)) < 30000);
  assert.doesNotMatch(JSON.stringify(card), /未来内容/);
  assert(card.body.elements.some(e => e.content?.includes('完整内容见会话历史')));
});
