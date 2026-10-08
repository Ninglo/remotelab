import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-run-progress-'));
setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { CHAT_SESSIONS_FILE, AUTH_FILE } = await import('../lib/config.mjs');
const { writeJsonAtomic } = await import('../chat/fs-utils.mjs');
const { findSessionMeta } = await import('../chat/session-meta-store.mjs');
const { appendEvent, loadHistory } = await import('../chat/history.mjs');
const { createRun } = await import('../chat/runs.mjs');
const { chooseRunProgressPolicy, updateSessionProgressPolicy } = await import('../chat/session-progress-policy.mjs');
const { appendAssistantMessage, updateSessionWorkboardPilot } = await import('../chat/session-manager.mjs');
const { publishLiveAssistantReplies } = await import('../chat/native-final-publication.mjs');
const { progressPolicyForRun, sessionProgressMode } = await import('../lib/session-progress-policy.mjs');
const { progressCardPanel } = await import('../connectors/feishu/progress-card-controls.mjs');

await writeJsonAtomic(CHAT_SESSIONS_FILE, ['s1', 's2'].map(id => ({ id, folder: home, tool: 'codex', workboardPilot: true,
  feishuProgressDefault: { mode: 'messages', personId: 'earlier-person' },
  conversation: { connector: 'feishu', sourceRouteId: 'bot', target: { chatType: 'group', chatId: 'group' } } })));
await writeJsonAtomic(AUTH_FILE, { token: 'isolated-person-token' });
const authBefore = await readFile(AUTH_FILE, 'utf8');
for (const id of ['run-a', 'run-b', 'run-c']) await createRun({ status: { id, sessionId: 's1', state: 'running' }, manifest: { sessionId: 's1' } });
const progress = (runId, text) => ({ type: 'message', role: 'assistant', phase: 'commentary', runId,
  providerMessageId: `${runId}-${text}`, content: `<progress>${text}</progress>` });

test('both expansion states update the same card; manual overrides and other Runs stay independent', async () => {
  let record = { key: 'request-a', sessionId: 's1', runId: 'run-a',
    options: { feishuProgressDefault: { mode: 'messages', personId: 'earlier-person' } }, deliveries: [] };
  const store = { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } };
  const stale = await findSessionMeta('s1');
  assert.equal(sessionProgressMode(stale, 'run-a'), 'collapsed', 'superseded personal defaults do not choose expansion');
  const publish = (events, running = true) => publishLiveAssistantReplies(record, events, { store, session: stale, running,
    plan: { connector: 'feishu', target: { chatId: 'group' } } });
  await chooseRunProgressPolicy('s1', 'run-a', 'expanded');
  const first = await appendEvent('s1', progress('run-a', 'first'));
  await publish([first]);
  assert.equal(record.deliveries.length, 0);
  await chooseRunProgressPolicy('s1', 'run-a', 'collapsed');
  const quiet = await appendEvent('s1', progress('run-a', 'quiet'));
  await publish([quiet]);
  assert.equal(record.deliveries.length, 0);
  const revision = (await findSessionMeta('s1')).feishuProgressRevision;
  await updateSessionProgressPolicy('s1', { mode: 'expanded', runId: 'run-a', expectedRevision: revision, changeId: 'human-expand' });
  assert.equal((await chooseRunProgressPolicy('s1', 'run-a', 'collapsed')).feishuProgressMode, 'expanded');
  await chooseRunProgressPolicy('s1', 'run-b', 'collapsed');
  const later = await appendEvent('s1', progress('run-a', 'later'));
  await publish([first, quiet, later]);
  assert.equal(record.deliveries.length, 0, 'ordinary progress never becomes an extra message');
  await publish([{ ...later, seq: later.seq + 1, providerMessageId: 'question', messageKind: 'user_question', content: '请确认输入' }]);
  await publish([{ ...later, seq: later.seq + 2, providerMessageId: 'final', phase: 'final_answer', content: '最终结果' }], false);
  assert(record.deliveries.some(item => item.text.includes('请确认输入')));
  assert(record.deliveries.some(item => item.text.includes('最终结果')));
  const session = await findSessionMeta('s1');
  assert.equal(sessionProgressMode(session, 'run-a'), 'expanded');
  assert.equal(sessionProgressMode(session, 'run-b'), 'collapsed');
  assert.equal(sessionProgressMode(session, 'run-c'), 'collapsed', 'a fresh Run does not inherit another task choice');
  assert.equal((await chooseRunProgressPolicy('s1', 'run-c', 'expanded')).feishuProgressAutomatic, true,
    'a new Run makes a fresh decision without the previous manual lock');
  await assert.rejects(chooseRunProgressPolicy('s2', 'run-a', 'collapsed'), { status: 400 });
  await assert.rejects(chooseRunProgressPolicy('s1', '../run-a', 'collapsed'), { status: 400 });
  await assert.rejects(chooseRunProgressPolicy('s1', 'run-a', 'auto'), { status: 400 });
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    "const {findSessionMeta}=await import('./chat/session-meta-store.mjs');console.log(JSON.stringify(await findSessionMeta('s1')))"]);
  assert.equal(JSON.parse(child.stdout).feishuProgressRuns['run-a'].manual, true);
});

test('one native foldable panel contains latest and previous work with the chosen initial expansion', async () => {
  const session = await findSessionMeta('s1');
  for (const runId of ['run-a', 'run-b']) {
    const panels = progressCardPanel({ sessionId: 's1', latestSeq: 3,
      progress: { seq: 3, content: '当前路径' }, progressHistory: [{ seq: 1, content: '先前路径' }, { seq: 3, content: '当前路径' }],
      progressPolicy: progressPolicyForRun(session, runId) });
    assert.equal(panels.length, 1);
    assert.equal(panels[0].tag, 'collapsible_panel');
    assert.equal(panels[0].expanded, runId === 'run-a');
    assert.match(JSON.stringify(panels), /先前路径/);
    assert.equal((JSON.stringify(panels).match(/当前路径/g) || []).length, 1);
    assert.doesNotMatch(JSON.stringify(panels), /恢复默认|卡片＋新消息|button|个人|习惯/);
  }
});

test('metadata-only selection adds no chat message or user habit, and disabled cards send only new progress', async () => {
  const before = (await loadHistory('s1')).length;
  const selection = await appendAssistantMessage('s1', '', [], { runId: 'run-c', progressMode: 'collapsed' });
  assert.equal(selection.event, null);
  assert.equal(selection.progressPolicy.feishuProgressMode, 'collapsed');
  assert.equal((await loadHistory('s1')).length, before);
  const normalizedAuth = await readFile(AUTH_FILE, 'utf8');
  await appendAssistantMessage('s1', '', [], { runId: 'run-c', progressMode: 'expanded' });
  assert.equal(await readFile(AUTH_FILE, 'utf8'), normalizedAuth);
  assert(!normalizedAuth.includes('feishuProgressMode'));
  assert(authBefore.includes('isolated-person-token'));
  await updateSessionWorkboardPilot('s1', false);
  await assert.rejects(chooseRunProgressPolicy('s1', 'run-b', 'collapsed'), { status: 400 });
  const older = (await loadHistory('s1')).filter(event => event.role === 'assistant');
  const current = await appendEvent('s1', progress('run-a', 'no-card'));
  let record = { key: 'without-card', sessionId: 's1', runId: 'run-a', options: {}, deliveries: [] };
  await publishLiveAssistantReplies(record, [...older, current], {
    store: { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } },
    session: await findSessionMeta('s1'), plan: { connector: 'feishu', target: { chatId: 'group' } } });
  assert.deepEqual(record.deliveries.map(item => item.providerMessageId), ['run-a-no-card']);
});
