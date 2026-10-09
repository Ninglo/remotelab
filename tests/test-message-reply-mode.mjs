import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-reply-mode-'));
setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
const { writeJsonAtomic } = await import('../chat/fs-utils.mjs');
const { loadMessageReplySettings, changeMessageReplySettings, resolveMessageReplyPolicy, messageReplyPrompt } = await import('../chat/message-reply-settings.mjs');
const { buildReplyPreview, validateReplyDraft } = await import('../static/chat/message-reply-model.js');
const { publishLiveAssistantReplies } = await import('../chat/native-final-publication.mjs');
const { collectFeishuInstanceWorkboardCycles, expandFeishuWorkboardUpdates,
  publishFeishuWorkboardCycle, buildFeishuWorkboardCard } = await import('../connectors/feishu/workboard-pilot.mjs');
const { appendEvent } = await import('../chat/history.mjs');
const { updateProgressCardDisclosure } = await import('../chat/session-progress-policy.mjs');
const { handleMessageReplySettings } = await import('../chat/router-message-reply-settings.mjs');
const group = { sourceRouteId: 'bot-2', chatId: 'oc_testgroup' };
const source = { connector: 'feishu', sourceRouteId: group.sourceRouteId, chatId: group.chatId,
  chatType: 'group', messageId: 'human-message', sender: { openId: 'person', senderType: 'user' } };
const plan = { connector: 'feishu', sourceRouteId: group.sourceRouteId,
  target: { chatType: 'group', chatId: group.chatId, conversationKind: 'thread', threadId: 'thread', rootId: 'root' } };
const session = { id: 's', folder: home, tool: 'codex', workboardPilot: true, conversation: plan,
  sourceContext: { ...source, chatName: '测试群' } };
await writeJsonAtomic(CHAT_SESSIONS_FILE, [session]);
const actor = { personId: 'person', identityId: 'identity' };
const inboundOptions = { feishuConnectorAuthenticated: true, sourceContext: source, sourceDelivery: plan };
const draft = { opening: true, checklist: true, progress: 'card', groups: [group] };
const policy = value => ({ version: 1, policyId: 'reply_test', final: true, ...value });
const user = (seq = 1, value = draft) => ({ seq, type: 'message', role: 'user', runId: 'run',
  sourceContext: source, messageReplyPolicy: policy(value),
  workboardAdmission: { ...actor, sourceRouteId: group.sourceRouteId, senderOpenId: 'person' } });
const opener = { seq: 2, type: 'message', role: 'assistant', runId: 'run', phase: 'commentary',
  providerMessageId: 'opening', content: '我先核对原始资料。' };
const progress = seq => ({ seq, type: 'message', role: 'assistant', runId: 'run', phase: 'commentary',
  providerMessageId: `progress-${seq}`, content: `<progress>已核对 ${seq} 项。</progress>` });
const final = { seq: 8, type: 'message', role: 'assistant', runId: 'run', phase: 'final_answer',
  providerMessageId: 'final', content: '核对完成，结论如下。' };
const checklist = { seq: 3, type: 'message', role: 'assistant', runId: 'run', source: 'workboard_checklist',
  content: '目标：核对报告\n[ ] 核对来源 — 所有重要结论有来源。\n[ ] 交付结果 — 更正内容清楚。' };
const pilot = { scope: 'instance', sourceRouteId: group.sourceRouteId, sessionId: session.id,
  chatId: group.chatId, cards: [], protocolAfterSeq: 0 };

test('draft, activation and rollback are separate, scoped and revision checked', async () => {
  let settings = await loadMessageReplySettings();
  assert.equal(settings.active, null);
  assert.equal(await resolveMessageReplyPolicy(inboundOptions), null);
  settings = await changeMessageReplySettings({ action: 'draft', expectedRevision: settings.revision, draft }, actor);
  assert.equal(settings.active, null, 'saving the draft never activates it');
  assert.equal(await resolveMessageReplyPolicy(inboundOptions), null);
  await assert.rejects(changeMessageReplySettings({ action: 'activate', expectedRevision: settings.revision }, actor), /明确确认/);
  settings = await changeMessageReplySettings({ action: 'activate', expectedRevision: settings.revision, confirm: true }, actor);
  const snapshot = await resolveMessageReplyPolicy(inboundOptions);
  assert.equal(snapshot.progress, 'card');
  assert.equal(await resolveMessageReplyPolicy({ ...inboundOptions, feishuConnectorAuthenticated: false }), null);
  assert.equal(await resolveMessageReplyPolicy({ ...inboundOptions, sourceContext: { ...source, sourceRouteId: 'other' } }), null);
  assert.equal(await resolveMessageReplyPolicy({ ...inboundOptions, sourceContext: { ...source, chatId: 'oc_other' } }), null);
  assert.equal(await resolveMessageReplyPolicy({ ...inboundOptions, automationTitle: 'daily' }), null);
  assert.equal(await resolveMessageReplyPolicy({ ...inboundOptions, sourceContext: { ...source, sender: { openId: 'bot', senderType: 'app' } } }), null);
  const newerDraft = { ...draft, progress: 'messages' };
  settings = await changeMessageReplySettings({ action: 'draft', expectedRevision: settings.revision, draft: newerDraft }, actor);
  assert.equal((await resolveMessageReplyPolicy(inboundOptions)).progress, 'card', 'editing a draft does not overwrite the active version');
  await assert.rejects(changeMessageReplySettings({ action: 'activate', expectedRevision: settings.revision - 1, confirm: true }, actor), /重新载入/);
  settings = await changeMessageReplySettings({ action: 'legacy', expectedRevision: settings.revision, confirm: true }, actor);
  assert.equal(settings.active, null);
  assert.equal(await resolveMessageReplyPolicy(inboundOptions), null);
  assert.equal(snapshot.progress, 'card', 'the previously accepted snapshot is unchanged');
  assert.equal(settings.audit.at(-1).action, 'legacy');
  assert.equal(settings.draft.progress, 'messages', 'rollback keeps the draft');
  await assert.rejects(changeMessageReplySettings({ action: 'draft', expectedRevision: settings.revision, draft }, null), /登录/);
});

test('invalid choices cannot disable final replies or broaden scope silently', () => {
  assert.throws(() => validateReplyDraft({ ...draft, final: false }));
  assert.throws(() => validateReplyDraft({ ...draft, opening: 'false' }));
  assert.throws(() => validateReplyDraft({ ...draft, groups: [{ chatId: '*' }] }));
  assert.match(messageReplyPrompt(policy({ ...draft, checklist: false })), /disabled new acceptance checklists/);
});

test('all twelve combinations publish only the selected text surfaces and one final', async () => {
  for (const opening of [false, true]) for (const checklist of [false, true]) for (const mode of ['none', 'messages', 'card']) {
    const choices = { ...draft, opening, checklist, progress: mode };
    const preview = buildReplyPreview(choices);
    assert.equal(preview.some(step => step.kind === 'opening'), opening);
    assert.equal(preview.some(step => step.kind === 'checklist'), checklist);
    assert.equal(preview.some(step => step.kind === 'progress'), mode !== 'none');
    assert.equal(preview.at(-1).kind, 'final');
    let record = { key: 'record', sessionId: 's', runId: 'run', responseId: 'response',
      options: { messageReplyPolicy: policy(choices) }, deliveries: [] };
    const store = { get: async () => record, mutate: async (_key, fn) => (record = fn(record)) };
    const events = [user(1, choices), opener, progress(4), final];
    const olderHistory = [{ seq: 0, type: 'message', role: 'user', content: '较早的请求' }, ...events];
    await publishLiveAssistantReplies(record, events.slice(0, -1), { store, plan, session, fullHistory: olderHistory, running: true });
    await publishLiveAssistantReplies(record, events.slice(0, -1), { store, plan, session, fullHistory: olderHistory, running: true });
    assert.equal(record.deliveries.filter(part => part.surfaceKind === 'opening').length, Number(opening));
    assert.equal(record.deliveries.filter(part => part.surfaceKind === 'progress').length, Number(mode === 'messages'));
    await publishLiveAssistantReplies(record, events, { store, plan, session, fullHistory: olderHistory, running: false });
    await publishLiveAssistantReplies(record, events, { store, plan, session, fullHistory: olderHistory, running: false });
    assert.equal(record.deliveries.filter(part => part.surfaceKind === 'final').length, 1);
    assert(record.deliveries.every(part => part.target.threadId === 'thread'));
  }
});

test('legacy later-turn openings and progress remain suppressed; questions remain reachable', async () => {
  let record = { key: 'legacy', sessionId: 's', runId: 'run', options: {}, deliveries: [] };
  const question = { ...progress(5), messageKind: 'user_question', nativeQuestion: { questions: [] },
    questionState: 'pending', content: '需要你确认日期。' };
  const events = [user(), opener, progress(4), question];
  const fullHistory = [{ seq: 0, type: 'message', role: 'user', content: '旧对话' }, ...events];
  const store = { get: async () => record, mutate: async (_key, fn) => (record = fn(record)) };
  await publishLiveAssistantReplies(record, events, { store, plan, session, fullHistory, running: true });
  assert.deepEqual(record.deliveries.map(part => part.surfaceKind), ['question']);
  const main = { ...plan, target: { chatType: 'group', chatId: group.chatId, conversationKind: 'main', messageId: 'human-message' } };
  record = { ...record, options: { messageReplyPolicy: policy(draft) }, deliveries: [] };
  await publishLiveAssistantReplies(record, [user(), opener, progress(4)], { store, plan: main, session, running: true });
  assert.equal(record.deliveries.length, 0, 'mainline short replies do not acquire chatter');
});

test('cards are independent of checklists and follow the selected progress form', async () => {
  for (const useChecklist of [false, true]) for (const mode of ['none', 'messages', 'card']) {
    const choices = { ...draft, checklist: useChecklist, progress: mode };
    const events = [user(1, choices), opener, ...(useChecklist ? [checklist] : []), progress(4), progress(5)];
    const cycles = collectFeishuInstanceWorkboardCycles(events, pilot, session);
    assert.equal(cycles.length, Number(useChecklist || mode === 'card'));
    const calls = [];
    const localPilot = { ...pilot, cards: [] };
    const app = { im: { v1: { message: {
      reply: async input => { calls.push({ kind: 'create', input }); return { code: 0, data: { message_id: 'card' } }; },
      create: async input => { calls.push({ kind: 'create', input }); return { code: 0, data: { message_id: 'card' } }; },
      patch: async input => { calls.push({ kind: 'patch', input }); return { code: 0 }; },
    } } } };
    const options = { pilot: localPilot, app, persist: async () => {}, verifyMessage: async () => {} };
    for (const cycle of expandFeishuWorkboardUpdates(cycles)) await publishFeishuWorkboardCycle(cycle, options);
    for (const cycle of expandFeishuWorkboardUpdates(cycles)) await publishFeishuWorkboardCycle(cycle, options);
    assert.equal(calls.filter(call => call.kind === 'create').length, Number(useChecklist || mode === 'card'));
    if (cycles.length) {
      const content = JSON.stringify(buildFeishuWorkboardCard(cycles[0].content, cycles[0].board, cycles[0].progress, cycles[0]));
      assert.equal(content.includes('点击显示进展'), mode === 'card');
      assert.equal(content.includes('核对来源'), useChecklist);
    }
    const legacy = events.map(event => { const { messageReplyPolicy, ...rest } = event; return rest; });
    if (!useChecklist) assert.equal(collectFeishuInstanceWorkboardCycles(legacy, pilot, session).length, 0);
  }
});

test('standalone card disclosure keeps manual choice without creating a task', async () => {
  await appendEvent('s', user(1, { ...draft, checklist: false }));
  const anchor = await appendEvent('s', progress(4));
  const expanded = await updateProgressCardDisclosure('s', { anchorSeq: anchor.seq, mode: 'expanded', changeId: 'click', actorOpenId: 'person' });
  assert.equal(expanded.feishuProgressCards[anchor.seq].mode, 'expanded');
  await appendEvent('s', progress(5));
  const newer = await updateProgressCardDisclosure('s', { anchorSeq: anchor.seq, mode: 'collapsed', changeId: 'second', actorOpenId: 'person' });
  assert.equal(newer.feishuProgressCards[anchor.seq].mode, 'collapsed');
  await assert.rejects(updateProgressCardDisclosure('s', { anchorSeq: anchor.seq + 100, mode: 'expanded', changeId: 'bad', actorOpenId: 'person' }), /无法确认/);
});

test('service identity cannot activate the human setting', async () => {
  let status;
  await handleMessageReplySettings({ pathname: '/api/message-reply-settings', req: { method: 'POST' },
    authSession: null, res: {}, writeJson: (_res, code) => { status = code; } });
  assert.equal(status, 403);
});

test('confirmed choices take precedence over the historical group baseline', async () => {
  process.env.REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE = '2026-10-07';
  try {
    for (const opening of [false, true]) for (const useChecklist of [false, true]) for (const mode of ['none', 'messages', 'card']) {
      const choices = { ...draft, opening, checklist: useChecklist, progress: mode };
      const events = [user(1, choices), opener, ...(useChecklist ? [checklist] : []), progress(4)];
      let record = { key: 'baseline', runId: 'run', options: { messageReplyPolicy: policy(choices) }, deliveries: [] };
      const store = { get: async () => record, mutate: async (_key, fn) => (record = fn(record)) };
      await publishLiveAssistantReplies(record, events, { store, plan, session, running: true });
      assert.equal(record.deliveries.filter(part => part.surfaceKind === 'opening').length, Number(opening));
      assert.equal(record.deliveries.filter(part => part.surfaceKind === 'progress').length, Number(mode === 'messages'));
      const cycles = collectFeishuInstanceWorkboardCycles(events, { ...pilot, progressStartedAt: 0 }, session);
      assert.equal(cycles.length, Number(useChecklist || mode === 'card'), 'legacy cards cannot override a confirmed choice');
      if (cycles.length) {
        const content = JSON.stringify(buildFeishuWorkboardCard(cycles[0].content, cycles[0].board, cycles[0].progress, cycles[0]));
        assert.equal(content.includes('点击显示进展'), mode === 'card');
        assert.equal(content.includes('卡片＋新消息'), false, 'legacy controls never replace modular card disclosure');
      }
    }
    const { buildPrompt } = await import('../chat/session-manager.mjs');
    const prompt = await buildPrompt(session.id, { ...session, systemPrompt: '' }, '核对资料', 'codex', 'codex', null,
      { workboardEnabled: true, messageReplyPolicy: policy({ ...draft, opening: false, progress: 'none' }) });
    assert.match(prompt, /disabled the opening text/);
    assert.doesNotMatch(prompt, /Feishu also sends each useful progress update as a new message/);
    assert.equal(process.env.REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE, '2026-10-07', 'the legacy instance setting is retained');
  } finally { delete process.env.REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE; }
});

test('a late checklist upgrades the modular progress card and survives replay', async () => {
  const state = { ...pilot, cards: [] }, calls = [];
  const options = { pilot: state, persist: async () => {}, verifyMessage: async () => {}, app: { im: { v1: { message: {
    reply: async input => { calls.push(['create', input]); return { code: 0, data: { message_id: 'original-card' } }; },
    patch: async input => { assert.equal(input.path.message_id, 'original-card'); calls.push(['patch', input]); return { code: 0 }; },
  } } } } };
  const collect = events => expandFeishuWorkboardUpdates(collectFeishuInstanceWorkboardCycles(events, state, session));
  const initial = [user(), opener, progress(4)];
  for (const cycle of collect(initial)) await publishFeishuWorkboardCycle(cycle, options);
  const listed = [...initial, { ...checklist, seq: 5 }, progress(6)];
  for (const cycle of collect(listed)) await publishFeishuWorkboardCycle(cycle, options);
  assert.equal(calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].messageId, 'original-card');
  const count = calls.length;
  for (const cycle of collect(listed)) await publishFeishuWorkboardCycle(cycle, options);
  assert.equal(calls.length, count);
});
