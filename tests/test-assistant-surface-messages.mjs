import assert from 'node:assert/strict';
import { collectAssistantSurfaceMessages, parseProgressMessage } from '../lib/assistant-surface-messages.mjs';
import { buildSessionDisplayEvents, buildEventBlockEvents } from '../chat/session-display-events.mjs';
import { buildReplyPublicationPayload } from '../chat/reply-publication.mjs';
import { publishLiveAssistantReplies, excludePublishedFinalReplies, recoverTerminalReplyReceipt } from '../chat/native-final-publication.mjs';
import { buildReplyDeliveries } from '../lib/reply-deliveries.mjs';

const user = { seq: 1, type: 'message', role: 'user', content: 'Fix it' };
const message = (seq, phase, content) => ({ seq, type: 'message', role: 'assistant', phase,
  content, providerMessageId: `m${seq}` });
const history = [user, message(2, 'commentary', 'I will check the delivery path.'),
  { seq: 3, type: 'tool_use', role: 'assistant', toolName: 'shell', toolInput: 'check' },
  message(4, 'commentary', 'Routine internal update'),
  message(5, 'commentary', 'Unpublished context <progress>Found the cause.</progress> Hidden suffix'),
  { seq: 6, type: 'tool_result', role: 'system', output: 'ok' },
  message(7, 'commentary', 'Another routine update'),
  message(8, 'final_answer', 'Fixed and verified.')];
const expected = ['I will check the delivery path.', 'Found the cause.', 'Fixed and verified.'];
assert.deepEqual([...collectAssistantSurfaceMessages(history).values()].map(event => event.content), expected);
for (const sessionRunning of [true, false]) {
  const display = buildSessionDisplayEvents(history, { sessionRunning });
  assert.deepEqual(display.filter(event => event.role === 'assistant' && event.type === 'message')
    .map(event => event.content), expected);
  assert.ok(display.some(event => event.type === 'thinking_block'));
  const details = display.filter(event => event.type === 'thinking_block').flatMap(event =>
    buildEventBlockEvents(history, event.blockStartSeq, event.blockEndSeq));
  assert.ok(details.some(event => event.content === 'Routine internal update'));
  assert.ok(details.some(event => event.content === 'Another routine update'));
}
const inFlight = buildSessionDisplayEvents(history.slice(0, -1), { sessionRunning: true });
assert.deepEqual(inFlight.filter(event => event.role === 'assistant' && event.type === 'message')
  .map(event => event.content), expected.slice(0, 2), 'opening and tagged progress appear before finalization');
assert.equal(inFlight.at(-1).state, 'running');
assert.equal(history[4].content, 'Unpublished context <progress>Found the cause.</progress> Hidden suffix', 'raw history stays intact');

assert.deepEqual(parseProgressMessage('<progress>One</progress> hidden <progress>Two</progress>'),
  { progress: 'One\n\nTwo', text: 'One hidden Two' });
assert.equal(parseProgressMessage('<private><progress>Secret</progress></private><progress>Public</progress>').progress, 'Public');
for (const example of ['`<progress>example</progress>`', '```xml\n<progress>example</progress>\n```',
  '~~~xml\n<progress>example</progress>\n~~~', '<progress>unfinished']) {
  assert.equal(parseProgressMessage(example).progress, '', 'examples and incomplete tags cannot publish progress');
}
const codeExample = message(9, 'final_answer', 'Use `<progress>example</progress>` next time.');
assert.equal([...collectAssistantSurfaceMessages([codeExample]).values()][0].content, codeExample.content);
const hiddenFirst = [message(1, 'commentary', '<private>Secret</private>'), ...history.slice(1)];
assert.equal([...collectAssistantSurfaceMessages(hiddenFirst).values()][0].surfaceKind, 'opening');
const literal = message(9, 'commentary', '`<progress>example</progress>`');
assert.equal(collectAssistantSurfaceMessages([...history, literal]).has(literal), false);
const reasoning = { seq: 9, type: 'reasoning', role: 'assistant', content: '<progress>secret reasoning</progress>' };
assert.equal(collectAssistantSurfaceMessages([...history, reasoning]).has(reasoning), false);
const nextOpening = message(10, 'commentary', 'I will check the next request.');
assert.equal(collectAssistantSurfaceMessages([...history, { ...user, seq: 9 }, nextOpening])
  .get(nextOpening).surfaceKind, 'opening', 'a new human message resets the opening');
const publication = buildReplyPublicationPayload(history, { id: 'r', responseId: 'response' }, { includeSessionEntry: false });
assert.equal(publication.text, 'Fixed and verified.', 'terminal publication contains the conclusion only');
const replayedFinals = [user, message(2, 'final_answer', '文件已准备好。'),
  { ...message(3, 'final_answer', '文件已准备好。'), providerMessageId: 'm2',
    attachments: [{ assetId: 'file-ready', originalName: 'early-result.txt' }] }];
const replayedDisplay = buildSessionDisplayEvents(replayedFinals);
assert.equal(replayedDisplay.filter(event => event.surfaceKind === 'final').length, 1,
  'a provider repeating its completed final item keeps one answer at its original position');
assert.equal(replayedDisplay.find(event => event.surfaceKind === 'final').messageUpdateSeq, 3);
const replayedPayload = buildReplyPublicationPayload(replayedFinals, {}, { includeSessionEntry: false });
assert.equal(replayedPayload.text, '文件已准备好。', 'terminal recovery does not append a second answer or attachment-name fallback');
assert.equal(replayedPayload.attachments.length, 1);
const reusedAcrossRuns = replayedFinals.map((event, index) => ({ ...event, runId: index === 2 ? 'run-2' : 'run-1' }));
assert.equal(buildSessionDisplayEvents(reusedAcrossRuns).filter(event => event.surfaceKind === 'final').length, 2,
  'different Runs may reuse a provider item ID without merging their answers');
const legacy = [user, message(2, undefined, 'Opening'), message(3, undefined, 'internal'), message(4, undefined, 'Conclusion')];
assert.equal(buildReplyPublicationPayload(legacy, {}, { includeSessionEntry: false }).text, 'Conclusion');
const fileFallback = { ...message(5, undefined, 'Generated file ready to download.'), source: 'result_file_assets',
  attachments: [{ assetId: 'asset', originalName: 'result.txt' }] };
const filePublication = buildReplyPublicationPayload([...legacy, fileFallback], {}, { includeSessionEntry: false });
assert.ok(filePublication.text.startsWith('Conclusion'), 'an attachment fallback must not replace the actual conclusion');
assert.equal(filePublication.attachments.length, 1);
assert.equal(collectAssistantSurfaceMessages([message(2, undefined, 'Result\n\nArtifacts:\n- /tmp/result.txt')]).size, 0,
  'phase-less artifact answers wait for terminal attachment publication');

for (const connector of ['feishu', 'wechat', 'email']) {
  let record = { key: 'k', runId: 'r', responseId: 'response', options: { sourceContext: { feishuOutcomeRequired: true } }, deliveries: [] };
  const store = { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } };
  const options = { store, session: { sourceId: connector }, plan: { connector, sourceRouteId: 'test',
    target: { chatId: 'chat', messageId: 'inbound', threadId: 'topic', to: 'person@example.test' } } };
  const deliveryExpected = connector === 'feishu'
    ? expected.map((text, index) => `【${index === 2 ? '最终答复' : index === 0 ? '开始处理' : '进展'}】\n\n${text}`) : expected;
  await publishLiveAssistantReplies(record, history.slice(0, -1), options);
  assert.deepEqual(record.deliveries.filter(part => part.kind === 'content').map(part => part.text), deliveryExpected.slice(0, 2));
  assert.equal(record.deliveries.some(part => part.kind === 'reaction'), false, 'progress never finishes the temporary outcome reaction');
  record = JSON.parse(JSON.stringify(record)); // Restart/replay uses durable receipt state.
  await publishLiveAssistantReplies(record, history, options);
  if (connector === 'feishu') {
    assert.deepEqual(record.deliveries.filter(part => part.kind === 'content').map(part => part.text), deliveryExpected.slice(0, 2),
      'a model final cannot announce delivery while execution is running');
  }
  await publishLiveAssistantReplies(record, history, { ...options, running: false });
  await publishLiveAssistantReplies(record, history, { ...options, running: false });
  assert.deepEqual(record.deliveries.filter(part => part.kind === 'content').map(part => part.text), deliveryExpected);
  assert.deepEqual(record.streamedSurfaceMessageIds, ['m2', 'm5', 'm8']);
  assert.deepEqual(record.streamedFinalReplyIds, ['m8']);
  assert.ok(record.deliveries.every(part => part.target.threadId === 'topic'));
  const pending = excludePublishedFinalReplies(history, record.streamedSurfaceMessageIds);
  assert.equal(buildReplyPublicationPayload(pending, {}, { includeSessionEntry: false }).text, '', 'settlement does not repeat streamed messages');
}
const feishuPlan = { connector: 'feishu', target: { chatId: 'chat' } };
let stoppedRecord = { key: 'stopped', runId: 'r', responseId: 'stopped-response', options: {}, deliveries: [] };
await publishLiveAssistantReplies(stoppedRecord, history, {
  store: { get: async () => stoppedRecord, mutate: async (_key, fn) => { stoppedRecord = fn(stoppedRecord); } },
  plan: feishuPlan, running: false,
});
assert.deepEqual(stoppedRecord.deliveries.map(part => part.text), ['【最终答复】\n\nFixed and verified.'],
  'cold recovery of stopped execution does not publish stale progress as deliveries');
let automationRecord = { key: 'automation', runId: 'r', responseId: 'automation-response',
  options: { triggerId: 'trigger', automationTitle: '每日项目审阅' }, deliveries: [] };
const automationOptions = { plan: feishuPlan, session: { name: 'Renamed execution Session' },
  store: { get: async () => automationRecord, mutate: async (_key, fn) => { automationRecord = fn(automationRecord); } } };
await publishLiveAssistantReplies(automationRecord, history, { ...automationOptions, running: false });
automationRecord = JSON.parse(JSON.stringify(automationRecord));
await publishLiveAssistantReplies(automationRecord, history, { ...automationOptions, running: false });
assert.deepEqual(automationRecord.deliveries.map(part => part.text), ['【每日项目审阅】\n\nFixed and verified.'],
  'restart and Session renaming preserve the accepted task title and publish one result');
const retainedAutomationPlan = { ...feishuPlan, sourceRouteId: 'default' };
const retainedAutomation = { ...automationRecord, deliveryPlan: retainedAutomationPlan,
  result: { state: 'completed', payload: { text: 'Fixed and verified.', displayEvents: [history.at(-1)] } },
  deliveries: [{ ...retainedAutomationPlan, kind: 'content', text: '【每日项目审阅】\n\nFixed and verified.' }] };
assert.equal(recoverTerminalReplyReceipt(retainedAutomation, retainedAutomation.deliveries[0])?.providerMessageId, 'm8',
  'receipt recovery matches the task heading without creating another delivery');
assert.equal(buildReplyDeliveries(feishuPlan, { text: '【最终答复】\n完成。' }, {
  running: false, automationTitle: ' 每日\n审阅 ',
})[0].text, '【每日 审阅】\n\n完成。', 'task headings replace generic labels and stay on one line');
assert.equal(buildReplyDeliveries({ connector: 'feishu', target: { chatId: 'chat', commentId: 'comment' } }, {
  text: '评论答复',
}, { running: false, automationTitle: '每日项目审阅' })[0].text, '评论答复', 'document comment replies retain their original body');
let legacyRecord = { key: 'legacy', runId: 'r', responseId: 'legacy-response', options: {}, deliveries: [] };
await publishLiveAssistantReplies(legacyRecord, [user, message(2, undefined, 'A direct answer')], {
  store: { get: async () => legacyRecord, mutate: async (_key, fn) => { legacyRecord = fn(legacyRecord); } },
  plan: feishuPlan,
});
assert.equal(legacyRecord.deliveries.length, 0, 'a phase-less direct answer waits for terminal result publication');
await publishLiveAssistantReplies(legacyRecord, [user, message(2, undefined, '<progress>Explicit progress</progress>')], {
  store: { get: async () => legacyRecord, mutate: async (_key, fn) => { legacyRecord = fn(legacyRecord); } },
  plan: feishuPlan,
});
assert.equal(legacyRecord.deliveries[0].text, '【进展】\n\nExplicit progress', 'explicit progress can still stream without a native phase');
for (const running of [true, false]) {
  const label = running ? '进展' : '最终答复';
  assert.equal(buildReplyDeliveries(feishuPlan, { text: '【待你确认】\n请选择目标。' }, { running })[0].text,
    `【${label}】\n\n请选择目标。`, 'model-chosen labels cannot override execution state');
  assert.equal(buildReplyDeliveries(feishuPlan, { text: '【交付】\n仍在迁移。' }, { running })[0].text,
    `【${label}】\n\n仍在迁移。`, 'the actual execution state wins without duplicate labels');
}
assert.equal(buildReplyDeliveries(feishuPlan, { text: '' }, { running: false }).length, 0,
  'empty answers never become label-only messages');
assert.equal(buildReplyDeliveries(feishuPlan, { text: '通知' })[0].text, '通知', 'manual notices have no inferred phase');
assert.equal(buildReplyDeliveries(feishuPlan, { text: '仍未完成。' }, { running: false })[0].text,
  '【最终答复】\n\n仍未完成。', 'result publication never rewrites the task outcome');
const mainlinePlan = { connector: 'feishu', target: { chatId: 'chat', messageId: 'source',
  conversationKind: 'main', chatType: 'group' } };
for (const text of ['核查结果。', '【最终答复】\n\n核查结果。', '【最终回复】\n核查结果。']) {
  const parts = buildReplyDeliveries(mainlinePlan, { text, reaction: 'OK',
    attachments: [{ assetId: 'result-file' }] }, { running: false });
  assert.equal(parts.find(part => part.kind === 'content').text, '核查结果。');
  assert.equal(parts.find(part => part.kind === 'reaction').emojiType, 'OK');
  assert.equal(parts.find(part => part.kind === 'attachment').attachment.assetId, 'result-file');
  assert.ok(parts.every(part => part.target.messageId === 'source'), 'plain replies retain their source anchor');
}
assert.deepEqual(buildReplyDeliveries(mainlinePlan, { text: '开场' }, { running: true, surfaceKind: 'opening' }), []);
assert.deepEqual(buildReplyDeliveries(mainlinePlan, { text: '进度' }, { running: true, surfaceKind: 'progress' }), []);
assert.equal(buildReplyDeliveries(mainlinePlan, { text: '请选择目标。' }, {
  running: true, surfaceKind: 'question',
})[0].text, '【待你回复】\n\n请选择目标。', 'questions still ask visibly for input');
assert.equal(buildReplyDeliveries(mainlinePlan, { text: '核查结果。' }, {
  running: false, automationTitle: '每日审阅',
})[0].text, '【每日审阅】\n\n核查结果。', 'an explicit automation title remains useful');
for (const target of [{ ...mainlinePlan.target, conversationKind: 'thread', replyInThread: true },
  { ...mainlinePlan.target, threadId: 'topic' }, { ...mainlinePlan.target, chatType: 'p2p' }]) {
  assert.equal(buildReplyDeliveries({ ...mainlinePlan, target }, { text: '核查结果。' }, {
    running: false,
  })[0].text, '【最终答复】\n\n核查结果。', 'other reply modes retain their phase headings');
}
console.log('test-assistant-surface-messages: ok');
