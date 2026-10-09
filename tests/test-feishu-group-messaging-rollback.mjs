import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'group-message-rollback-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE = '2026-10-07';
after(() => rm(home, { recursive: true, force: true }));
const { CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
const { writeJsonAtomic } = await import('../chat/fs-utils.mjs');
const { appendEvent } = await import('../chat/history.mjs');
const { findSessionMeta } = await import('../chat/session-meta-store.mjs');
const { buildPrompt } = await import('../chat/session-manager.mjs');
const { updateSessionProgressPolicy } = await import('../chat/session-progress-policy.mjs');
const { progressPolicyForRun, shouldPublishSessionProgress } = await import('../lib/session-progress-policy.mjs');
const { publishLiveAssistantReplies } = await import('../chat/native-final-publication.mjs');
const { collectFeishuInstanceWorkboardCycles, expandFeishuWorkboardUpdates,
  publishFeishuWorkboardCycle, buildFeishuWorkboardCard } = await import('../connectors/feishu/workboard-pilot.mjs');
const { prepareFeishuRuntimeCommandPlan, applyFeishuRuntimeCommandPlan } = await import('../connectors/feishu/runtime-commands.mjs');

const session = { id: 'group-session', workboardPilot: true, conversation: { connector: 'feishu', sourceRouteId: 'bot',
  target: { chatId: 'group', chatType: 'group', conversationKind: 'thread', messageId: 'root', replyInThread: true } },
  feishuProgressRuns: { run: { mode: 'collapsed', manual: true } },
  feishuProgressCards: { 2: { mode: 'collapsed', revision: 3 } } };
const privateSession = { ...session, conversation: { ...session.conversation,
  target: { chatId: 'private', chatType: 'p2p', conversationKind: 'main' } } };
const inbound = (seq, runId = 'run') => ({ seq, timestamp: 1000 + seq, type: 'message', role: 'user', runId,
  sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatId: 'group', chatType: 'group',
    messageId: `in-${seq}`, sender: { openId: 'person' } },
  workboardAdmission: { personId: 'person', identityId: 'identity', sourceRouteId: 'bot', senderOpenId: 'person' } });
const message = (seq, content, extra = {}) => ({ seq, timestamp: 1000 + seq, type: 'message', role: 'assistant',
  runId: 'run', providerMessageId: `msg-${seq}`, phase: 'commentary', content, ...extra });
const progress = seq => message(seq, `<progress>已核实 ${seq}</progress>`);
const pilot = () => ({ scope: 'instance', sourceRouteId: 'bot', sessionId: session.id, chatId: 'group',
  cards: [], progressStartedAt: 1000, groupProgressRestoredAt: 1004, protocolAfterSeq: 0 });
await writeJsonAtomic(CHAT_SESSIONS_FILE, [session]);

test('group default restores messages despite newer disclosure metadata; other surfaces keep current behavior', () => {
  assert.equal(shouldPublishSessionProgress(session, 2), true);
  assert.equal(shouldPublishSessionProgress({ ...session, feishuProgressMode: 'card' }, 2), false);
  assert.equal(shouldPublishSessionProgress({ ...session, feishuProgressAfterSeq: 2 }, 2), false);
  assert.equal(shouldPublishSessionProgress(privateSession, 2), false);
  delete process.env.REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE;
  assert.equal(shouldPublishSessionProgress(session, 2), false, 'other instances retain their current default');
  process.env.REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE = '2026-10-07';
});

test('the executing Harness receives the historical group contract and the current private contract', async () => {
  const prompt = await buildPrompt(session.id, { ...session, folder: home, systemPrompt: '' },
    '核查群消息', 'codex', 'codex', null, { workboardEnabled: true });
  assert.match(prompt, /Feishu also sends each useful progress update as a new message/);
  assert.doesNotMatch(prompt, /Feishu sends the opening only when a new conversation starts/);
  assert.doesNotMatch(prompt, /--progress-mode expanded\|collapsed/);
  const privatePrompt = await buildPrompt('private-session', { ...privateSession, id: 'private-session', folder: home, systemPrompt: '' },
    '核查私聊', 'codex', 'codex', null, {});
  assert.match(privatePrompt, /Feishu sends the opening only when a new conversation starts/);
});

test('later group turns publish openings and meaningful progress once, keep reply anchors, and send one terminal result', async () => {
  let record = { key: 'request', runId: 'run', options: {}, deliveries: [] };
  const store = { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } };
  const events = [inbound(1, 'prior'), message(2, '先核对来源'), progress(3), progress(4),
    message(5, '需要你选择范围', { messageKind: 'user_question' }),
    message(6, '最终结果', { phase: 'final_answer' })];
  const plan = { connector: 'feishu', sourceRouteId: 'bot', target: session.conversation.target };
  const publish = running => publishLiveAssistantReplies(record, events, { store, session, fullHistory: events, plan, running });
  await publish(true);
  assert.deepEqual(record.deliveries.map(part => part.surfaceKind), ['opening', 'progress', 'progress', 'question']);
  assert(record.deliveries.some(part => part.text.includes('先核对来源')));
  assert(record.deliveries.every(part => part.target.messageId === 'root'));
  await publish(true);
  assert.equal(record.deliveries.length, 4, 'live replay cannot duplicate opening or progress');
  await publish(false);
  await publish(false);
  assert.equal(record.deliveries.filter(part => part.surfaceKind === 'final').length, 1);
  assert.equal(record.deliveries.filter(part => part.surfaceKind === 'progress').length, 2);
  record = { key: 'request', runId: 'run', options: {}, deliveries: [], progressMessageAfterSeq: 3 };
  await publish(true);
  assert.deepEqual(record.deliveries.map(part => part.surfaceKind), ['progress', 'question']);
  assert(!record.streamedSurfaceMessageIds.includes('msg-2') && !record.streamedSurfaceMessageIds.includes('msg-3'),
    'the rollout skips old openings/progress without inventing delivery receipts');
});

test('session switches fence quiet history, persist and reject stale changes without touching Run disclosures', async () => {
  await appendEvent(session.id, progress(1));
  const quiet = await updateSessionProgressPolicy(session.id, { mode: 'card', expectedRevision: 0, changeId: 'quiet' });
  assert.equal(quiet.feishuProgressAfterSeq, 1);
  await appendEvent(session.id, progress(2));
  const loud = await updateSessionProgressPolicy(session.id, { mode: 'messages', expectedRevision: 1, changeId: 'loud' });
  assert.equal(loud.feishuProgressAfterSeq, 2);
  assert.equal(shouldPublishSessionProgress(loud, 2), false);
  assert.equal(shouldPublishSessionProgress(loud, 3), true);
  await updateSessionProgressPolicy(session.id, { mode: 'card', expectedRevision: 0, changeId: 'quiet' });
  assert.equal((await findSessionMeta(session.id)).feishuProgressMode, 'messages');
  await assert.rejects(updateSessionProgressPolicy(session.id, { mode: 'card', expectedRevision: 0, changeId: 'stale' }), { status: 409 });
  assert.deepEqual(loud.feishuProgressRuns, session.feishuProgressRuns);
  assert.deepEqual(loud.feishuProgressCards, session.feishuProgressCards);
});

test('new progress makes one lightweight card, late checklist upgrades it, and restart preserves the message ID', async () => {
  const state = pilot(), calls = [];
  const options = { pilot: state, persist: async () => {}, verifyMessage: async () => {}, app: { im: { v1: { message: {
    reply: async input => { calls.push(['create', input]); return { code: 0, data: { message_id: 'original-card' } }; },
    patch: async input => { assert.equal(input.path.message_id, 'original-card'); calls.push(['patch', input]); return { code: 0 }; },
  } } } } };
  const history = [inbound(1), progress(2), progress(5)];
  const collect = (events, state) => expandFeishuWorkboardUpdates(collectFeishuInstanceWorkboardCycles(events, state, session));
  assert.deepEqual(collect(history.slice(0, 2), state), [], 'old suppressed progress cannot create historical cards');
  for (const cycle of collect(history, state)) await publishFeishuWorkboardCycle(cycle, options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].path.message_id, 'in-1');
  assert.equal(state.cards[0].anchorSeq, 2, 'retain original anchor for a later checklist');
  const board = { taskId: 'task', revision: 1, goal: '可验证交付', status: 'running', reason: '',
    items: ['a', 'b'].map(id => ({ id, title: id, condition: '有证据', status: 'pending', evidenceRefs: [] })) };
  const listed = [...history, message(6, '目标：可验证交付', { source: 'workboard_checklist', workboard: board })];
  for (const cycle of collect(listed, state)) await publishFeishuWorkboardCycle(cycle, options);
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].messageId, 'original-card');
  assert.equal(state.cards[0].taskId, 'task');
  const content = JSON.stringify(buildFeishuWorkboardCard('', board, null,
    { sessionId: session.id, progressPolicy: progressPolicyForRun(session, 'run') }));
  assert.match(content, /卡片＋新消息/);
  assert.match(content, /只更新卡片/);
  assert.doesNotMatch(content, /点击显示进展/);
  const restarted = structuredClone(state), count = calls.length;
  for (const cycle of collect(listed, restarted)) await publishFeishuWorkboardCycle(cycle, { ...options, pilot: restarted });
  assert.equal(calls.length, count);
  assert.equal(collectFeishuInstanceWorkboardCycles(history, state, privateSession).length, 0);
});

test('slash controls restore session message policy with no model call', async () => {
  const request = async (path, options = {}) => {
    if (path === '/api/session-conversations/resolve') return { response: { ok: true }, json: { sessionId: session.id } };
    if (path === `/api/sessions/${session.id}`) return { response: { ok: true }, json: { session: await findSessionMeta(session.id) } };
    if (path === `/api/sessions/${session.id}/progress-policy`) return { response: { ok: true },
      json: { session: await updateSessionProgressPolicy(session.id, options.body) } };
    throw new Error(`Unexpected model or provider call: ${path}`);
  };
  const options = { request, resolveDefault: () => { throw new Error('No model call'); } };
  const plan = await prepareFeishuRuntimeCommandPlan({ config: { sourceRouteId: 'bot' } },
    { chatType: 'group', chatId: 'group', messageId: 'command' }, [{ name: 'progress', value: 'card' }], options);
  assert.match(plan.text, /作用范围：当前会话/);
  assert.match(await applyFeishuRuntimeCommandPlan(plan, options), /只更新卡片/);
});
