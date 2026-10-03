import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-progress-policy-'));
setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
const { writeJsonAtomic } = await import('../chat/fs-utils.mjs');
const { findSessionMeta } = await import('../chat/session-meta-store.mjs');
const { appendEvent } = await import('../chat/history.mjs');
const { updateSessionProgressPolicy } = await import('../chat/session-progress-policy.mjs');
const { publishLiveAssistantReplies } = await import('../chat/native-final-publication.mjs');
const { prepareFeishuRuntimeCommandPlan, applyFeishuRuntimeCommandPlan } = await import('../connectors/feishu/runtime-commands.mjs');
const { handleFeishuProgressPolicyAction } = await import('../connectors/feishu/progress-policy-actions.mjs');
const { buildFeishuProgressCard, publishFeishuWorkboardCycle } = await import('../connectors/feishu/workboard-pilot.mjs');
const { parseFeishuCommandBlock } = await import('../connectors/feishu/command-parser.mjs');
const conversation = { connector: 'feishu', sourceRouteId: 'bot',
  target: { chatType: 'group', chatId: 'group', conversationKind: 'thread', threadId: 'thread' } };
await writeJsonAtomic(CHAT_SESSIONS_FILE, ['s1', 's2'].map(id => ({ id, folder: home, tool: 'codex', workboardPilot: true, conversation })));
const progress = (seq, content = `发现 ${seq}`) => ({ type: 'message', role: 'assistant', phase: 'commentary',
  runId: 'run', providerMessageId: `m-${seq}`, seq, content: `<progress>${content}</progress>` });

test('switching during a Run is Session-scoped, durable, and never replays quiet progress', async () => {
  let record = { key: 'request', sessionId: 's1', runId: 'run', options: {}, deliveries: [] };
  const store = { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } };
  const staleSession = await findSessionMeta('s1');
  const publish = events => publishLiveAssistantReplies(record, events, { store, session: staleSession,
    plan: { connector: 'feishu', target: { chatId: 'group' } } });
  const events = [];
  events.push(await appendEvent('s1', progress(1)));
  await publish(events);
  assert.equal(record.deliveries.length, 1);
  await updateSessionProgressPolicy('s1', { mode: 'card', expectedRevision: 0, changeId: 'quiet' });
  events.push(await appendEvent('s1', progress(2)));
  await publishLiveAssistantReplies(record, [events.at(-1)], { store, session: staleSession,
    plan: { connector: 'feishu', target: { chatId: 'group' } },
    prepareFinal: () => { throw new Error('quiet progress must not publish assets'); } });
  assert.equal(record.deliveries.length, 1, 'already running publishers must re-read the policy');
  assert.equal((await findSessionMeta('s2')).feishuProgressMode, undefined);
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    "const {findSessionMeta}=await import('./chat/session-meta-store.mjs');console.log(JSON.stringify(await findSessionMeta('s1')))"]);
  assert.equal(JSON.parse(child.stdout).feishuProgressMode, 'card', 'a fresh process loads the saved policy');
  await updateSessionProgressPolicy('s1', { mode: 'messages', expectedRevision: 1, changeId: 'loud' });
  assert.equal((await findSessionMeta('s1')).feishuProgressAfterSeq, events.at(-1).seq);
  // Late retries of the earlier action cannot undo a newer setting.
  await updateSessionProgressPolicy('s1', { mode: 'card', expectedRevision: 0, changeId: 'quiet' });
  assert.equal((await findSessionMeta('s1')).feishuProgressMode, 'messages');
  events.push(await appendEvent('s1', progress(3)));
  await publish(events);
  await publish(events);
  assert.deepEqual(record.deliveries.map(item => item.providerMessageId), ['m-1', 'm-3']);
  const headBeforeReset = (await findSessionMeta('s1')).feishuProgressAfterSeq;
  await updateSessionProgressPolicy('s1', { mode: 'default', expectedRevision: 2, changeId: 'reset' });
  assert.equal((await findSessionMeta('s1')).feishuProgressAfterSeq, headBeforeReset, 'equivalent defaults cannot drop pending progress');
  await assert.rejects(updateSessionProgressPolicy('s1', { mode: 'card', expectedRevision: 1, changeId: 'stale' }), { status: 409 });
  await updateSessionProgressPolicy('s1', { mode: 'card', expectedRevision: 3, changeId: 'quiet-again' });
  const question = { ...progress(4), content: '请补充输入', messageKind: 'user_question' };
  await publish([question, { ...progress(5), phase: 'final_answer', content: '交付结果' }]);
  assert(record.deliveries.some(item => item.text.includes('请补充输入')), 'questions still notify');
  await publishLiveAssistantReplies(record, [{ ...progress(5), phase: 'final_answer', content: '交付结果' }], {
    store, session: staleSession, running: false, plan: { connector: 'feishu', target: { chatId: 'group' } } });
  assert(record.deliveries.some(item => item.text.includes('交付结果')), 'finals still notify');
  await assert.rejects(updateSessionProgressPolicy('s1', { mode: 'auto', expectedRevision: 4, changeId: 'bad' }), { status: 400 });
});

test('slash controls query and switch without a model call; combinations are rejected before changes', async () => {
  const calls = [];
  const runtime = { config: { sourceRouteId: 'bot' } };
  const request = async (path, options = {}) => {
    calls.push(path);
    if (path === '/api/session-conversations/resolve') return { response: { ok: true }, json: { sessionId: 's2' } };
    if (path === '/api/sessions/s2') return { response: { ok: true }, json: { session: await findSessionMeta('s2') } };
    if (path === '/api/sessions/s2/progress-policy') return { response: { ok: true }, json: { session: await updateSessionProgressPolicy('s2', options.body) } };
    throw new Error(`Unexpected model or runtime call: ${path}`);
  };
  const options = { request, resolveDefault: () => { throw new Error('must not resolve models'); } };
  const summary = { chatType: 'p2p', chatId: 'group', messageId: 'command-1' };
  const query = await prepareFeishuRuntimeCommandPlan(runtime, summary, parseFeishuCommandBlock('/progress').commands, options);
  assert.match(query.text, /全局默认/);
  const change = await prepareFeishuRuntimeCommandPlan(runtime, summary, parseFeishuCommandBlock('/progress card').commands, options);
  assert.match(await applyFeishuRuntimeCommandPlan(change, options), /只更新卡片/);
  assert.match(await applyFeishuRuntimeCommandPlan(change, options), /只更新卡片/, 'durable plan replay is idempotent');
  assert((await prepareFeishuRuntimeCommandPlan(runtime, summary,
    [{ name: 'progress', value: 'card' }, { name: 'model', value: 'x' }], options)).error);
  assert((await prepareFeishuRuntimeCommandPlan(runtime, summary,
    [{ name: 'progress', value: 'card' }], { ...options, taskMode: true })).error);
  assert(calls.every(path => !path.includes('models')));
});

test('card buttons validate their origin, reject stale or unauthorized actions, and update the same card', async () => {
  const dir = join(home, 'workboards');
  await mkdir(dir);
  await writeFile(join(dir, 'bot.json'), JSON.stringify({ sourceRouteId: 'bot', sessions: {
    s1: { chatId: 'group', cards: [{ messageId: 'original' }] } } }));
  let mutations = 0;
  const request = async (path, options = {}) => {
    if (options.method === 'POST') {
      mutations++;
      try { return { response: { ok: true }, json: { session: await updateSessionProgressPolicy('s1', options.body) } }; }
      catch (error) { return { response: { ok: false }, json: { error: error.message } }; }
    }
    return { response: { ok: true }, json: { session: await findSessionMeta('s1') } };
  };
  const raw = { header: { event_id: 'button-1' }, event: { context: { open_chat_id: 'group', open_message_id: 'original' },
    operator: { open_id: 'person' }, action: { value: { namespace: 'session-progress', sessionId: 's1', mode: 'messages', revision: 4 } } } };
  const options = { request, authorize: async () => true, stateDir: dir };
  const runtime = { config: { sourceRouteId: 'bot' } };
  assert.equal((await handleFeishuProgressPolicyAction(runtime, raw, options)).toast.type, 'success');
  assert.equal((await handleFeishuProgressPolicyAction(runtime, raw, options)).toast.type, 'success');
  assert.equal((await findSessionMeta('s1')).feishuProgressRevision, 5);
  const stale = structuredClone(raw); stale.header.event_id = 'button-stale'; stale.event.action.value.mode = 'card';
  assert.equal((await handleFeishuProgressPolicyAction(runtime, stale, options)).toast.type, 'error');
  const before = mutations;
  const forged = structuredClone(raw); forged.event.context.open_message_id = 'forwarded';
  assert.equal((await handleFeishuProgressPolicyAction(runtime, forged, options)).toast.type, 'error');
  assert.equal((await handleFeishuProgressPolicyAction(runtime, raw, { ...options, authorize: async () => false })).toast.type, 'error');
  assert.equal(mutations, before);
  const cycle = { sessionId: 's1', latestSeq: 3, anchorSeq: 1, progressOnly: true, progress: { seq: 3, content: '当前' },
    progressHistory: [{ seq: 1, content: '先前' }, { seq: 3, content: '当前' }, { seq: 9, content: '未来' }],
    progressPolicy: { feishuProgressMode: 'messages', feishuProgressRevision: 5 } };
  const card = buildFeishuProgressCard(cycle);
  const panel = card.body.elements.find(element => element.tag === 'collapsible_panel');
  assert.equal(panel.expanded, false);
  assert.match(JSON.stringify(panel), /先前/); assert.doesNotMatch(JSON.stringify(panel), /当前|未来/);
  const calls = [];
  const pilot = { sessionId: 's1', cards: [{ messageId: 'original', anchorSeq: 1, latestSeq: 3, contentHash: 'old' }] };
  const publishOptions = { pilot, persist: async () => {}, verifyMessage: async () => {},
    app: { im: { v1: { message: { patch: async input => { calls.push(input); return { code: 0 }; } } } } } };
  await publishFeishuWorkboardCycle(cycle, publishOptions);
  await publishFeishuWorkboardCycle(cycle, publishOptions);
  assert.equal(calls.length, 1, 'policy-only changes patch the existing card once');
  assert.equal(calls[0].path.message_id, 'original');
  const many = buildFeishuProgressCard({ ...cycle, latestSeq: 25, progressHistory: Array.from({ length: 24 }, (_, i) => ({ seq: i + 1, content: '长'.repeat(3000) })) });
  assert(many.body.elements.find(e => e.tag === 'collapsible_panel').elements.length <= 11, 'history is bounded without deleting source history');
  assert(JSON.stringify(many).length < 14000);
});
