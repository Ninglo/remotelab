#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-reply-publication-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');
mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(fakeCodexPath, `#!/usr/bin/env node
(async () => {
const visibility = process.argv.join(' ').includes('hold-progress');
if (visibility) {
  const fs = require('node:fs');
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'opening', type: 'agent_message', phase: 'commentary', text: '先检查消息链路。' } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'check', aggregated_output: 'ok', exit_code: 0 } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'noise', type: 'agent_message', phase: 'commentary', text: '内部琐碎信息。' } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'progress', type: 'agent_message', phase: 'commentary', text: '隐藏前缀 <progress>原因已经找到。</progress> 隐藏后缀' } }));
  const gate = ${JSON.stringify(join(tempHome, 'release-progress-test'))};
  if (!fs.existsSync(gate)) await new Promise(resolve => {
    const watcher = fs.watch(${JSON.stringify(tempHome)}, () => {
      if (fs.existsSync(gate)) { watcher.close(); resolve(); }
    });
    if (fs.existsSync(gate)) { watcher.close(); resolve(); }
  });
}
if (process.argv.join(' ').includes('hold-entry-notice')) {
  const fs = require('node:fs');
  while (!fs.existsSync(${JSON.stringify(join(tempHome, 'release-entry-test'))})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'reply-publication-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', ...(visibility ? { id: 'final', phase: 'final_answer' } : {}), text: '主 Harness 已经直接完成并交付结果。' },
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`, 'utf8');
chmodSync(fakeCodexPath, 0o755);

writeFileSync(join(configDir, 'tools.json'), JSON.stringify([{
  id: 'fake-codex',
  name: 'Fake Codex',
  command: 'fake-codex',
  runtimeFamily: 'codex-json',
  models: [{ id: 'fake-model', label: 'Fake model' }],
  reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
}], null, 2), 'utf8');

process.env.HOME = tempHome;
process.env.REMOTELAB_CONFIG_DIR = configDir;
process.env.REMOTELAB_WORK_ROOT_DIR = join(tempHome, 'workspace');
process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://remote.example.test';
delete process.env.REMOTELAB_INSTANCE_ROOT;
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const {
  createSession,
  getRunState,
  getSession,
  updateSessionRuntimePreferences,
  updateSessionWorkboardPilot,
  getSessionReplyPublication,
  buildPrompt,
  killAll,
  sendMessage,
  submitHttpMessage,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const { getRun, getRunManifest } = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);
const { requests } = await import('../chat/requests.mjs');
const { claimSourceDelivery, completeSourceDelivery, enqueueSourceDelivery } = await import('../chat/source-deliveries.mjs');
const { appendEvent, loadHistory } = await import('../chat/history.mjs');
const { projectWorkboards } = await import('../lib/workboard-state.mjs');
const { buildSessionEntryDeliveries } = await import('../chat/session-entry-notification.mjs');
const { publishNativeFinalReplies } = await import('../chat/native-final-publication.mjs');
const { buildReplyPublicationPayload } = await import('../chat/reply-publication.mjs');
const { appendSessionEntryFooter, buildSessionEntry } = await import('../lib/session-navigation.mjs');
const { buildReplyDeliveries } = await import('../lib/reply-deliveries.mjs');
const { buildSessionDisplayEvents } = await import('../chat/session-display-events.mjs');

async function waitFor(predicate, description, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  const firstHistory = [
    { seq: 1, type: 'message', role: 'user', responseId: 'first-response', content: '核查消息接入逻辑' },
    { seq: 2, type: 'message', role: 'assistant', phase: 'commentary', providerMessageId: 'opening',
      content: '我先对照群内收到的消息，检查进度是否更新了原卡。' },
    { seq: 3, type: 'message', role: 'assistant', phase: 'final_answer', providerMessageId: 'result', content: '核查结果。' },
  ];
  const runtimeSelection = { tool: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' };
  const runtimeDescription = '模型：gpt-6.1-sol · 思考强度：xhigh · 执行工具：codex';
  let openingRecord = { key: 'first-opening', runId: 'opening-run', responseId: 'first-response', runtimeSelection, options: {}, deliveries: [] };
  const openingOptions = { session: { id: 'first-feishu-session', sourceId: 'feishu',
      tool: 'claude', model: 'changed-before-publication', effort: 'high' },
    plan: { connector: 'feishu', target: { chatId: 'original-chat', threadId: 'original-thread' } },
    store: { get: async () => openingRecord, mutate: async (_key, fn) => { openingRecord = fn(openingRecord); } } };
  await publishNativeFinalReplies(openingRecord, firstHistory.slice(0, 2), openingOptions);
  assert.equal(openingRecord.deliveries.length, 1);
  assert.match(openingRecord.deliveries[0].text, /^【开始处理】\n\n我先对照群内收到的消息/);
  assert.match(openingRecord.deliveries[0].text, /\?session=first-feishu-session&tab=sessions/);
  assert.ok(openingRecord.deliveries[0].text.includes(runtimeDescription));
  assert.doesNotMatch(openingRecord.deliveries[0].text, /会话已创建|changed-before-publication/,
    'the useful opening keeps its accepted runtime instead of changed Session preferences');
  openingRecord = JSON.parse(JSON.stringify(openingRecord));
  await publishNativeFinalReplies(openingRecord, firstHistory, { ...openingOptions, running: false });
  await publishNativeFinalReplies(openingRecord, firstHistory, { ...openingOptions, running: false });
  assert.deepEqual(openingRecord.deliveries.map(item => item.text.split('\n')[0]), ['【开始处理】', '【最终答复】']);
  assert.equal(openingRecord.deliveries[1].text, '【最终答复】\n\n核查结果。');
  assert.ok(openingRecord.deliveries.every(item => item.target.threadId === 'original-thread'));

  let shortRecord = { ...openingRecord, key: 'short-reply', deliveries: [],
    streamedSurfaceMessageIds: [], streamedFinalReplyIds: [] };
  const shortPlan = { connector: 'feishu', target: { chatId: 'short-chat',
    chatType: 'group', conversationKind: 'main', messageId: 'short-source' } };
  const shortOptions = { ...openingOptions, plan: shortPlan,
    store: { get: async () => shortRecord, mutate: async (_key, fn) => { shortRecord = fn(shortRecord); } } };
  const shortHistory = [firstHistory[0], firstHistory[1],
    { ...firstHistory[1], seq: 3, providerMessageId: 'short-progress', content: '<progress>检查完了。</progress>' },
    { ...firstHistory[2], seq: 4 }];
  await publishNativeFinalReplies(shortRecord, shortHistory, shortOptions);
  assert.deepEqual(shortRecord.deliveries, [], 'short replies send neither opening nor progress while running');
  await publishNativeFinalReplies(shortRecord, shortHistory, { ...shortOptions, running: false });
  await publishNativeFinalReplies(shortRecord, shortHistory, { ...shortOptions, running: false });
  assert.equal(shortRecord.deliveries.length, 1, 'short reply replay publishes one final answer');
  assert.equal(shortRecord.deliveries[0].text, '核查结果。', 'a final-only mainline reply has no phase heading');
  assert.equal(shortRecord.deliveries[0].target.messageId, 'short-source');
  assert.equal(shortRecord.deliveries[0].sessionEntryIncluded, undefined);
  assert.deepEqual(buildReplyDeliveries(shortPlan, { text: '准备回复', attachments: [{ assetId: 'early-file' }] },
    { running: true, surfaceKind: 'opening' }), [], 'early files do not bypass short reply suppression');
  assert.equal(buildReplyDeliveries(shortPlan, { text: '缺少哪项信息？' },
    { running: true, surfaceKind: 'question' }).length, 1, 'required user input stays reachable');
  for (const target of [
    { ...shortPlan.target, chatType: 'p2p' },
    { ...shortPlan.target, conversationKind: 'thread', threadId: 'thread' },
    { ...shortPlan.target, chatMode: 'topic' },
    { chatId: 'announcement-chat', chatType: 'group', conversationKind: 'main' },
  ]) assert.equal(buildReplyDeliveries({ ...shortPlan, target }, { text: '开始处理。' },
    { running: true, surfaceKind: 'opening' }).length, 1, 'other reply surfaces retain their lifecycle');

  const earlyInputs = [firstHistory[0], { seq: 2, type: 'message', role: 'user',
    responseId: 'second-response', content: '补充一项检查。' },
    ...firstHistory.slice(1).map(event => ({ ...event, seq: event.seq + 1 }))];
  let earlyRecord = { key: 'early-inputs', runId: 'opening-run', responseId: 'first-response',
    runtimeSelection, options: {}, deliveries: [] };
  const earlyOptions = { ...openingOptions, fullHistory: earlyInputs,
    store: { get: async () => earlyRecord, mutate: async (_key, fn) => { earlyRecord = fn(earlyRecord); } } };
  await publishNativeFinalReplies(earlyRecord, earlyInputs.slice(0, -1), earlyOptions);
  assert.equal(earlyRecord.deliveries.length, 1);
  assert.ok(earlyRecord.deliveries[0].text.includes(runtimeDescription));
  assert.match(earlyRecord.deliveries[0].text, /\?session=first-feishu-session&tab=sessions/,
    'a second input arriving before the opening cannot remove the entry');
  const steeredHistory = [...earlyInputs.slice(0, -1),
    { seq: 4, type: 'message', role: 'user', responseId: 'steered-response', content: '再补充一项。' },
    { ...firstHistory[1], seq: 5, providerMessageId: 'steered-opening', content: '继续检查补充信息。' }];
  await publishNativeFinalReplies(earlyRecord, steeredHistory, { ...earlyOptions, fullHistory: steeredHistory });
  assert.equal(earlyRecord.deliveries.length, 1,
    'supplementary input cannot send another opening from the first Run');
  assert.equal(buildSessionDisplayEvents(steeredHistory).filter(event => event.surfaceKind === 'opening').length, 2,
    'Web retains both useful Harness openings');
  earlyRecord = JSON.parse(JSON.stringify(earlyRecord));
  await publishNativeFinalReplies(earlyRecord, earlyInputs, { ...earlyOptions, running: false });
  await publishNativeFinalReplies(earlyRecord, earlyInputs, { ...earlyOptions, running: false });
  assert.equal(earlyRecord.deliveries.length, 2, 'restart and replay retain exactly one opening and one final');
  assert.equal(earlyRecord.deliveries[1].text, '【最终答复】\n\n核查结果。');

  const firstRun = { id: 'opening-run', responseId: 'first-response', ...runtimeSelection };
  const fallback = buildReplyPublicationPayload([earlyInputs.at(-1)], firstRun,
    { session: openingOptions.session, fullHistory: earlyInputs });
  assert.ok(fallback.text.includes(runtimeDescription), 'terminal fallback uses the same frozen runtime');
  assert.match(fallback.text, /\?session=first-feishu-session&tab=sessions/);
  let fallbackRecord = { key: 'fallback', runId: firstRun.id, responseId: firstRun.responseId,
    runtimeSelection, options: {}, deliveries: [] };
  const fallbackOptions = { ...earlyOptions, running: false,
    store: { get: async () => fallbackRecord, mutate: async (_key, fn) => { fallbackRecord = fn(fallbackRecord); } } };
  await publishNativeFinalReplies(fallbackRecord, [earlyInputs.at(-1)], fallbackOptions);
  assert.ok(fallbackRecord.deliveries[0].text.includes(runtimeDescription),
    'cold recovery with only a final delta still includes the entry');
  const laterHistory = [earlyInputs[1], { ...earlyInputs.at(-1), seq: 5, providerMessageId: 'later-final' }];
  const laterPayload = buildReplyPublicationPayload(laterHistory,
    { ...firstRun, responseId: 'second-response' }, { session: openingOptions.session, fullHistory: earlyInputs });
  assert.equal(laterPayload.text, '核查结果。', 'later turns do not repeat the creation information');
  let laterRecord = { key: 'later', runId: 'later-run', responseId: 'second-response', runtimeSelection, options: {}, deliveries: [] };
  await publishNativeFinalReplies(laterRecord, laterHistory, { ...earlyOptions, running: false,
    store: { get: async () => laterRecord, mutate: async (_key, fn) => { laterRecord = fn(laterRecord); } } });
  assert.equal(laterRecord.deliveries[0].text, '【最终答复】\n\n核查结果。');
  for (const cards of [true, false]) {
    const continuingHistory = [earlyInputs[1],
      { ...firstHistory[1], seq: 5, providerMessageId: 'later-opening', content: '继续检查。' },
      { ...firstHistory[1], seq: 6, providerMessageId: 'later-question', messageKind: 'user_question', content: '请选择输入。' },
      { ...firstHistory[2], seq: 7, providerMessageId: 'later-result' }];
    const fullHistory = [...firstHistory, ...continuingHistory];
    let continuing = { ...laterRecord, key: `continuing-${cards}`, options: { workboardEnabled: cards },
      deliveries: [], streamedSurfaceMessageIds: [], streamedFinalReplyIds: [] };
    const options = { ...openingOptions, session: { ...openingOptions.session, workboardPilot: cards }, fullHistory,
      store: { get: async () => continuing, mutate: async (_key, fn) => { continuing = fn(continuing); } } };
    await publishNativeFinalReplies(continuing, continuingHistory.slice(0, -1), options);
    assert.deepEqual(continuing.deliveries.map(item => item.surfaceKind), ['question'],
      'later Feishu turns retain questions without a routine start message, with or without cards');
    await publishNativeFinalReplies(continuing, continuingHistory, { ...options, running: false });
    await publishNativeFinalReplies(continuing, continuingHistory, { ...options, running: false });
    assert.deepEqual(continuing.deliveries.map(item => item.surfaceKind), ['question', 'final']);
    assert.ok(continuing.deliveries.every(item => !item.sessionEntryIncluded));
    assert.ok(buildSessionDisplayEvents(continuingHistory).some(event => event.surfaceKind === 'opening'));
    continuing = { ...continuing, deliveries: [], streamedSurfaceMessageIds: [], streamedFinalReplyIds: [] };
    await publishNativeFinalReplies(continuing, continuingHistory.slice(0, 2),
      { ...options, plan: { connector: 'wechat', target: { to: 'peer' } } });
    assert.deepEqual(continuing.deliveries.map(item => item.surfaceKind), ['opening'],
      'the Feishu-only rule preserves other connectors');
  }
  const silent = buildReplyPublicationPayload([earlyInputs[0],
    { ...earlyInputs.at(-1), content: '<private>silence</private>' }], firstRun,
    { session: openingOptions.session, fullHistory: earlyInputs });
  assert.equal(silent.text, '', 'creation metadata cannot turn a silent decision into a message');
  const entry = buildSessionEntry(openingOptions.session, { runtimeSelection });
  const alreadyLinked = appendSessionEntryFooter(`正文\n\n${entry.url}`, entry);
  assert.ok(alreadyLinked.includes(runtimeDescription), 'a link already present does not suppress runtime information');
  assert.equal(appendSessionEntryFooter(alreadyLinked, entry), alreadyLinked, 'appending the footer is idempotent');
  const unknownEntry = buildSessionEntry(openingOptions.session, { runtimeSelection: { tool: 'codex', model: '', effort: '' } });
  assert.match(unknownEntry.runtimeDescription, /模型：默认（由 Harness 决定）/,
    'an unknown accepted provider default is never replaced by later Session settings');
  let probe = { key: 'probe', runId: 'probe-run', responseId: 'probe-response', options: {}, deliveries: [] };
  await publishNativeFinalReplies(probe, ['unready-assets', 'ready-text'].map(providerMessageId => ({
    type: 'message', role: 'assistant', phase: 'final_answer', providerMessageId, content: 'ready reply',
  })), {
    store: { get: async () => probe, mutate: async (key, fn) => { probe = fn(probe); } },
    running: false,
    plan: { connector: 'feishu', target: { chatId: 'probe-chat' } },
    prepareFinal: async event => { if (event.providerMessageId === 'unready-assets') throw new Error('asset transport unavailable'); return event; },
  });
  assert.deepEqual(probe.streamedFinalReplyIds, ['ready-text'], 'failed asset preparation does not freeze observation or other final replies');
  assert.equal(probe.deliveries.length, 1);
  const visibilitySession = await createSession(tempHome, 'fake-codex', 'Visibility integration');
  const visibilityPrompt = await buildPrompt(visibilitySession.id, await getSession(visibilitySession.id),
    'Check it.', 'fake-codex', 'fake-codex');
  assert.match(visibilityPrompt, /Message visibility on RemoteLab surfaces/);
  assert.match(visibilityPrompt, /<progress>\.\.\.<\/progress>/);
  assert.doesNotMatch(visibilityPrompt, /Feishu replies use shared message labels|【待你确认】/,
    'message labels remain transparent to the AI');
  const visibilityOutcome = await sendMessage(visibilitySession.id, 'hold-progress 检查投递。', [], {
    tool: 'fake-codex', model: 'fake-model', effort: 'low',
    sourceContext: { feishuOutcomeRequired: true },
    sourceDelivery: { connector: 'feishu', sourceRouteId: 'visibility-test',
      target: { chatId: 'visibility-chat', messageId: 'incoming', threadId: 'visibility-topic' } },
  });
  for (const expected of ['先检查消息链路。', '原因已经找到。']) {
    let claim;
    await waitFor(async () => {
      claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'visibility-test' });
      return !!claim;
    }, 'visible progress delivery while model is blocked');
    assert.equal(claim.delivery.text, `【${expected === '先检查消息链路。' ? '开始处理' : '进展'}】\n\n${expected}`);
    assert.equal(claim.delivery.target.threadId, 'visibility-topic');
    assert.equal((await requests.byRunId(visibilityOutcome.run.id)).result, null, 'opening and progress precede the result');
    await completeSourceDelivery(claim.delivery.id, claim.leaseId, { externalId: `visible-${expected}` });
  }
  assert.equal(await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'visibility-test' }), null, 'untagged commentary is never queued');
  writeFileSync(join(tempHome, 'release-progress-test'), 'continue');
  await waitFor(async () => (await getSessionReplyPublication(visibilitySession.id, visibilityOutcome.response.id))?.state === 'ready', 'visibility run finalization');
  const visibilityPublication = await getSessionReplyPublication(visibilitySession.id, visibilityOutcome.response.id);
  assert.equal(visibilityPublication.payload.text, '主 Harness 已经直接完成并交付结果。');
  const visibilityReaction = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'visibility-test' });
  assert.equal(visibilityReaction.delivery.kind, 'reaction', 'outcome is queued only when the final answer arrives');
  await completeSourceDelivery(visibilityReaction.delivery.id, visibilityReaction.leaseId, { externalId: 'visibility-outcome' });
  const visibilityFinal = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'visibility-test' });
  assert.equal(visibilityFinal.delivery.text, '【最终答复】\n\n主 Harness 已经直接完成并交付结果。');
  await completeSourceDelivery(visibilityFinal.delivery.id, visibilityFinal.leaseId, { externalId: 'visibility-final' });
  assert.equal(await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'visibility-test' }), null, 'settlement does not resend streamed replies');
  const taggedSession = await createSession(tempHome, 'fake-codex', 'Explicit task result');
  await appendEvent(taggedSession.id, { type: 'message', role: 'assistant', source: 'workboard_checklist',
    workboard: { taskId: 'result-task', revision: 1, goal: '结果', status: 'blocked', reason: '等待输入',
      items: [{ id: 'a', title: '输入', condition: '可查', status: 'pending', evidenceRefs: [] }] } });
  await assert.rejects(enqueueSourceDelivery({ sessionId: taggedSession.id, responseId: 'stale-task-result', text: '说明',
    sourceDelivery: { connector: 'feishu', target: { chatId: 'tagged-chat' } }, workboardTaskId: 'result-task', workboardRevision: 2 }), /current task/);
  await enqueueSourceDelivery({ sessionId: taggedSession.id, responseId: 'tagged-result', text: '尚未完成，等待输入',
    sourceDelivery: { connector: 'feishu', target: { chatId: 'tagged-chat' } }, workboardTaskId: 'result-task', workboardRevision: 1 });
  const tagged = await claimSourceDelivery({ connector: 'feishu' });
  await completeSourceDelivery(tagged.delivery.id, tagged.leaseId, { externalId: 'om-tagged-result' });
  const taggedBoard = projectWorkboards(await loadHistory(taggedSession.id))[0].board;
  assert.equal(taggedBoard.deliveryState, 'delivered'); assert.equal(taggedBoard.status, 'blocked');
  const session = await createSession(tempHome, 'fake-codex', 'Direct Reply Publication', {
    space: 'Product',
    group: 'RemoteLab',
    description: 'Verify direct publication after the selected Harness completes.',
  });
  const outcome = await sendMessage(session.id, '直接完成这项工作。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  const responseId = outcome.response?.id;
  const runId = outcome.run?.id;
  assert.ok(responseId);
  assert.ok(runId);

  await waitFor(
    async () => (await getRunState(runId))?.state === 'completed',
    'main Harness run to complete',
  );
  await waitFor(
    async () => (await getSessionReplyPublication(session.id, responseId))?.state === 'ready',
    'reply publication to become ready directly',
  );

  const publication = await getSessionReplyPublication(session.id, responseId);
  assert.equal(publication?.resolution, 'accepted_as_is');
  assert.equal(publication?.rootRunId, runId);
  assert.equal(publication?.finalRunId, runId);
  assert.deepEqual(publication?.continuationRunIds, []);
  assert.equal(publication?.payload?.text, '主 Harness 已经直接完成并交付结果。');

  assert.equal(Object.hasOwn(await getRun(runId), 'replyPublication'), false, 'publication has no independently mutable persisted state');
  const recoveredPublication = await getSessionReplyPublication(session.id, responseId);
  assert.equal(
    recoveredPublication?.state,
    'ready',
    'publication reads the immutable request result',
  );
  assert.equal(recoveredPublication?.resolution, 'accepted_as_is');

  const secondOutcome = await sendMessage(session.id, '继续当前会话。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.ok(secondOutcome.run?.id, 'a later message should start a Harness run directly');
  assert.equal(secondOutcome.queued, false);
  assert.notEqual(secondOutcome.response?.state, 'checking');

  const connectorSession = await createSession(tempHome, 'fake-codex', 'Feishu connector session', {
    sourceId: 'feishu',
    sourceName: 'Feishu',
    externalTriggerId: 'feishu:topic:chat-1:thread-1',
    initiatedByIdentityId: 'workboard-test-owner',
  });
  await updateSessionWorkboardPilot(connectorSession.id, true);
  const connectorOptions = {
    requestId: 'connector-first',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
    initiatedByIdentityId: 'workboard-test-owner',
    sourceDelivery: { connector: 'feishu', sourceRouteId: 'bot-2', target: { chatId: 'test-chat', messageId: 'first-message', threadId: 'test-thread' } },
  };
  assert.deepEqual(buildSessionEntryDeliveries(connectorSession, { userMessageCount: 1 }, connectorOptions), [], 'pre-existing history never gets a retroactive notice');
  assert.deepEqual(buildSessionEntryDeliveries(connectorSession, { userMessageCount: 0 }, { ...connectorOptions, internalOperation: 'trigger_delivery' }), []);
  assert.deepEqual(buildSessionEntryDeliveries(connectorSession, { userMessageCount: 0 }, { ...connectorOptions, recordUserMessage: false }), []);
  assert.deepEqual(buildSessionEntryDeliveries(session, { userMessageCount: 0 }, connectorOptions), [], 'browser sessions do not receive connector notices');
  const firstConnectorOutcome = await submitHttpMessage(connectorSession.id, 'hold-entry-notice 首轮消息。', [], connectorOptions);
  const expectedSessionUrl = `https://remote.example.test/?session=${connectorSession.id}&tab=sessions`;
  const earlyClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot-2' });
  assert.equal(earlyClaim, null, 'Feishu sends no separate fixed creation notice while waiting for the useful opening');
  await waitFor(async () => (await getSession(connectorSession.id)).model === 'fake-model', 'session metadata to reflect the admitted runtime');
  assert.equal((await getSession(connectorSession.id)).effort, 'low');
  const admitted = await requests.byResponse(connectorSession.id, firstConnectorOutcome.response.id);
  assert.equal(admitted.options.checklistGateReceipt.status, 'harness',
    'the card decision stays with the executing Harness instead of a message-only classifier');
  assert.equal(admitted.runtimeSelection.model, 'fake-model');
  assert.equal(admitted.runtimeSelection.effort, 'low');
  const queuedOptions = { requestId: 'connector-queued-defaults' };
  const queuedOutcome = await submitHttpMessage(connectorSession.id, 'Use the saved runtime after the blocked turn.', [], queuedOptions);
  assert.equal(queuedOutcome.queued, true);
  await updateSessionRuntimePreferences(connectorSession.id, { model: 'changed-after-admission', effort: 'high' });
  const queuedReplay = await submitHttpMessage(connectorSession.id, 'Use the saved runtime after the blocked turn.', [], queuedOptions);
  assert.equal(queuedReplay.duplicate, true, 'changing defaults must not change the original request fingerprint');
  assert.equal((await requests.byResponse(connectorSession.id, queuedOutcome.response.id)).runtimeSelection.model, 'fake-model');
  const commandSelection = { tool: 'fake-codex', model: 'command-model', effort: 'low', thinking: false };
  await updateSessionRuntimePreferences(connectorSession.id, { feishuRuntimeSelection: commandSelection });
  const commandOptions = { ...connectorOptions, requestId: 'command-pinned', model: 'web-ui-model' };
  const commandOutcome = await submitHttpMessage(connectorSession.id, 'Pinned command choice.', [], commandOptions);
  assert.equal(commandOutcome.queued, true);
  assert.deepEqual((await requests.byResponse(connectorSession.id, commandOutcome.response.id)).runtimeSelection, commandSelection);
  assert.equal((await requests.byResponse(connectorSession.id, firstConnectorOutcome.response.id)).runtimeSelection.model, 'fake-model', 'active input retains its snapshot');
  await updateSessionRuntimePreferences(connectorSession.id, { feishuRuntimeSelection: null });
  const commandReplay = await submitHttpMessage(connectorSession.id, 'Pinned command choice.', [], commandOptions);
  assert.equal(commandReplay.duplicate, true);
  assert.deepEqual((await requests.byResponse(connectorSession.id, commandOutcome.response.id)).runtimeSelection, commandSelection, '/follow does not rewrite queued or replayed inputs');
  assert.equal((await requests.byResponse(connectorSession.id, firstConnectorOutcome.response.id)).result, null);
  assert.equal((await submitHttpMessage(connectorSession.id, 'hold-entry-notice 首轮消息。', [], connectorOptions)).duplicate, true);
  assert.equal(await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot-2' }), null, 'replayed submission does not resend the link');
  writeFileSync(join(tempHome, 'release-entry-test'), 'continue');
  await waitFor(
    async () => (await getSessionReplyPublication(connectorSession.id, firstConnectorOutcome.response?.id))?.state === 'ready',
    'first connector reply publication to become ready',
  );
  const firstConnectorPublication = await getSessionReplyPublication(
    connectorSession.id,
    firstConnectorOutcome.response?.id,
  );
  assert.equal(firstConnectorPublication?.payload?.sessionEntry?.url, expectedSessionUrl);
  assert.equal(firstConnectorPublication?.payload?.text, `主 Harness 已经直接完成并交付结果。\n\n模型：fake-model · 思考强度：low · 执行工具：fake-codex\n\n查看会话详情和进度：${expectedSessionUrl}`, 'a reply without an opening retains its accepted runtime and one usable Session entry');
  const finalClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot-2' });
  assert.equal(finalClaim?.delivery?.kind, 'content');
  assert.equal(finalClaim.delivery.text, `【最终答复】\n\n${firstConnectorPublication.payload.text}`);
  await completeSourceDelivery(finalClaim.delivery.id, finalClaim.leaseId, { externalId: 'final-reply-message' });

  await waitFor(async () => (await getRunState(queuedOutcome.run.id))?.state === 'completed', 'queued run completion');
  const queuedManifest = await getRunManifest(queuedOutcome.run.id);
  assert.equal(queuedManifest.options.model, 'fake-model', 'the runner must use the admitted selection after preferences change');
  assert.equal(queuedManifest.options.effort, 'low');
  await waitFor(async () => (await getRunState(commandOutcome.run.id))?.state === 'completed', 'pinned queued run completion');
  assert.equal((await getRunManifest(commandOutcome.run.id)).options.model, 'command-model');

  const laterConnectorOutcome = await submitHttpMessage(connectorSession.id, '后续消息。', [], { ...connectorOptions, requestId: 'connector-later' });
  assert.equal((await requests.byResponse(connectorSession.id, laterConnectorOutcome.response.id)).runtimeSelection.model, 'command-model', 'a Session runtime change remains stable for later connector inputs');
  assert.equal((await requests.byResponse(connectorSession.id, laterConnectorOutcome.response.id)).deliveries.length, 0);
  await waitFor(
    async () => (await getSessionReplyPublication(connectorSession.id, laterConnectorOutcome.response?.id))?.state === 'ready',
    'later connector reply publication to become ready',
  );
  const laterConnectorPublication = await getSessionReplyPublication(
    connectorSession.id,
    laterConnectorOutcome.response?.id,
  );
  assert.equal(laterConnectorPublication?.payload?.sessionEntry, undefined);
  assert.doesNotMatch(laterConnectorPublication?.payload?.text || '', new RegExp(connectorSession.id));
  const legacySession = await createSession(tempHome, 'fake-codex', 'Connector without outbox', { sourceId: 'wechat' });
  const legacyOutcome = await sendMessage(legacySession.id, 'Normal reply.', [], { tool: 'fake-codex', model: 'fake-model' });
  await waitFor(async () => (await getSessionReplyPublication(legacySession.id, legacyOutcome.response.id))?.state === 'ready', 'legacy connector response');
  assert.ok((await getSessionReplyPublication(legacySession.id, legacyOutcome.response.id)).payload.sessionEntry?.url.includes(legacySession.id), 'adapters without the shared outbox retain their existing first-reply link');
  await waitFor(async () => (await getRunState(secondOutcome.run.id))?.finalizedAt, 'second request to finish');

  const shortSession = await createSession(tempHome, 'fake-codex', 'Short reply terminal fallback', { sourceId: 'feishu' });
  const shortOutcome = await submitHttpMessage(shortSession.id, '简短回复。', [], {
    requestId: 'short-terminal', tool: 'fake-codex', model: 'fake-model', effort: 'low', sourceDelivery: shortPlan,
  });
  await waitFor(async () => (await requests.byRunId(shortOutcome.run.id))?.result, 'short reply terminal settlement');
  const shortRequest = await requests.byRunId(shortOutcome.run.id);
  assert.equal(shortRequest.result.payload.sessionEntry, undefined, 'terminal short reply adds no runtime footer');
  assert.equal(shortRequest.deliveries.length, 1);
  assert.equal(shortRequest.deliveries[0].text, '主 Harness 已经直接完成并交付结果。',
    'terminal fallback also publishes the mainline answer without a heading');
  assert.equal(shortRequest.deliveries[0].target.messageId, 'short-source');
} finally {
  await killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-reply-publication: ok');
