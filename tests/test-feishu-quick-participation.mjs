import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-quick-participation-'));
setIsolatedTestHome(home);
try {
  const { classifyFeishuQuickParticipation, createFeishuQuickParticipationPilot } =
    await import('../connectors/feishu/quick-participation.mjs');
  const { parseFeishuReactionDirective } = await import('../lib/feishu-reaction-directive.mjs');
  const { buildReplyDeliveries } = await import('../lib/reply-deliveries.mjs');
  const { resolveFeishuGroupSettings } = await import('../connectors/feishu/group-settings.mjs');
  const { stripHiddenBlocks, classifyAssistantReplyCandidate, selectAssistantReplyEvent } = await import('../lib/reply-selection.mjs');
  const { buildFeishuAmbientIncompleteWorkNotice, buildReplyPublicationPayload } =
    await import('../chat/reply-publication.mjs');
  const { createQuickParticipationReaction, handleMessage } = await import('../scripts/feishu-connector.mjs');
  const { createFeishuReadReactionStore, createFeishuOutcomeReactionStore } = await import('../connectors/feishu/read-reactions.mjs');
  const { FEISHU_OUTCOME_REACTIONS } = await import('../lib/feishu-reaction-catalog.mjs');
  for (const id of FEISHU_OUTCOME_REACTIONS) {
    assert.equal(parseFeishuReactionDirective(`<private><feishu-reaction emoji="${id}"/></private>`).emojiType, id);
  }
  let outcomeStore = createFeishuOutcomeReactionStore(home);
  assert.equal((await outcomeStore.snapshot('missing')).status, 'not-recorded');
  const outcomeCreates = [], outcomeRemoves = [];
  const createOutcome = id => async () => { outcomeCreates.push(id); return { reactionId: id }; };
  await outcomeStore.apply('owned-message', 'OnIt', createOutcome('bot-working'));
  await outcomeStore.apply('owned-message', 'Get', createOutcome('bot-received'), { stage: 2 });
  outcomeStore = createFeishuOutcomeReactionStore(home);
  const recoveredOutcome = await outcomeStore.snapshot('owned-message');
  assert.equal(recoveredOutcome.status, 'applied');
  assert.equal(recoveredOutcome.emojiType, 'Get');
  assert.equal(recoveredOutcome.stage, 2);
  assert(!('reactionId' in recoveredOutcome), 'the prompt snapshot exposes no provider receipt ID');

  await assert.rejects(outcomeStore.clean('owned-message', async () => { throw new Error('delete offline'); }), /offline/);
  await outcomeStore.clean('owned-message', async (messageId, id) => outcomeRemoves.push([messageId, id]));
  assert.deepEqual(outcomeRemoves, [['owned-message', 'bot-working']], 'delete only the recorded Bot outcome after replacement succeeds');
  await outcomeStore.apply('owned-message', 'Get', createOutcome('must-not-duplicate'), { stage: 2 });
  const stale = await outcomeStore.apply('owned-message', 'OnIt', createOutcome('must-not-revert'));
  assert(stale.superseded, 'late initial feedback cannot overwrite a successful routing receipt');
  assert.deepEqual(outcomeCreates, ['bot-working', 'bot-received']);
  await outcomeStore.apply('failed-create', 'OnIt', createOutcome('keep-old'));
  await assert.rejects(outcomeStore.apply('failed-create', 'Get', async () => { throw new Error('create offline'); }, { stage: 2 }), /offline/);
  await outcomeStore.clean('failed-create', async () => { throw new Error('old reaction must remain'); });
  const readStore = createFeishuReadReactionStore(home);
  let readCreates = 0;
  assert.equal((await readStore.add('read-message', async () => {
    readCreates++;
    return { reactionId: 'read-reaction' };
  })).reactionId, 'read-reaction');
  assert.equal((await createFeishuReadReactionStore(home).add('read-message', async () => {
    readCreates++;
    return { reactionId: 'unexpected' };
  })).reactionId, 'read-reaction');
  assert.equal(readCreates, 1, 'replayed inbound messages must reuse the existing receipt');
  const removed = [];
  assert.equal(await createFeishuReadReactionStore(home).remove('read-message', async (...args) => {
    removed.push(args);
  }), true);
  assert.deepEqual(removed, [['read-message', 'read-reaction']]);
  assert.equal(await readStore.remove('read-message', async () => {
    throw new Error('already removed');
  }), false);
  await readStore.add('read-message-retry', async () => ({ reactionId: 'read-reaction-retry' }));
  assert.equal(await createFeishuReadReactionStore(home).remove('read-message-retry', async () => {
    const alreadyDeleted = new Error('reaction not found after a previous DELETE');
    alreadyDeleted.code = 231011;
    throw alreadyDeleted;
  }), true, 'a successful but unrecorded DELETE can be reconciled after restart');
  const sdkCalls = [];
  const boundReaction = createQuickParticipationReaction({ appClient: { im: { v1: {
    messageReaction: { create: async request => {
      sdkCalls.push(request);
      return { code: 0, data: { reaction_id: 'reaction-1', reaction_type: request.data.reaction_type } };
    } },
  } } } });
  assert.equal((await boundReaction({ messageId: 'inbound-1' }, 'THINKING')).reactionId, 'reaction-1');
  assert.deepEqual(sdkCalls[0], {
    path: { message_id: 'inbound-1' }, data: { reaction_type: { emoji_type: 'THINKING' } },
  });
  const callOrder = [];
  const readFirst = createFeishuQuickParticipationPilot({
    config: { storageDir: home, groups: { pilot: { quickReactions: true } } },
    botIdentity: { openId: 'bot' },
  }, {
    logPath: join(home, 'read-first.jsonl'),
    react: async () => { callOrder.push('reaction'); return { reactionId: 'read-1' }; },
    classify: async () => { callOrder.push('classify'); return { decision: 'unknown' }; },
  });
  await readFirst.handle({ chatId: 'pilot', chatType: 'group', messageId: 'read-first',
    createTime: String(Date.now()), sender: { senderType: 'user', openId: 'human' } });
  assert.deepEqual(callOrder, []);
  const pilotReactionOrder = [];
  let completeThinking;
  const orderedPilot = createFeishuQuickParticipationPilot({
    config: { storageDir: home, groups: { pilot: { quickReactions: true, groupFeed: true } } },
    botIdentity: { openId: 'bot' },
  }, {
    logPath: join(home, 'ordered-pilot.jsonl'),
    classify: async () => ({ decision: 'reply', handoffDecision: 'none' }),
    react: async (_summary, emojiType) => {
      pilotReactionOrder.push(`start:${emojiType}`);
      if (emojiType === 'THINKING') await new Promise(resolve => { completeThinking = resolve; });
      pilotReactionOrder.push(`done:${emojiType}`);
      return { reactionId: emojiType };
    },
  });
  const orderedTurn = orderedPilot.handle({ chatId: 'pilot', chatType: 'group', messageId: 'ordered',
    createTime: String(Date.now()), sender: { senderType: 'user', openId: 'human' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pilotReactionOrder, [], 'no automatic group receipt is published');
  await orderedTurn;
  assert.deepEqual(pilotReactionOrder, []);
  const submitOrder = [];
  let releaseRead;
  let readStarted;
  const readStartedPromise = new Promise(resolve => { readStarted = resolve; });
  const readDone = new Promise(resolve => { releaseRead = resolve; });
  const admissionRuntime = {
    config: { sourceRouteId: 'bot-2', storageDir: home,
      groups: { pilot: { participationMode: 'ambient', quickReactions: true } },
      responsePolicy: { group: 'all' } },
    botIdentity: { openId: 'bot' }, storagePaths: {},
    quickParticipation: {
      handle: () => { submitOrder.push('start:THINKING'); readStarted(); },
      waitForReadReceipt: async () => { await readDone; submitOrder.push('done:THINKING'); },
    },
  };
  const admission = handleMessage(admissionRuntime, {
    chatId: 'pilot', chatType: 'group', messageId: 'om_admission', messageType: 'text',
    messageText: '帮我看一下', sender: { senderType: 'user', openId: 'human' }, mentions: [],
  }, 'test', { submitRemoteLabRequest: async () => {
    submitOrder.push('submit'); return { sessionId: 'session' };
  } });
  await readStartedPromise;
  await admission;
  assert.deepEqual(submitOrder, ['start:THINKING', 'submit'], 'receipt latency never blocks admission');
  releaseRead();
  const config = {
    storageDir: home, appId: 'self-app',
    groups: { pilot: { participationMode: 'ambient', quickReactions: true, contextReactions: true } },
    responsePolicy: { group: 'mention_only' },
  };
  const runtime = { config, botIdentity: { openId: 'bot' } };
  const base = {
    chatId: 'pilot', chatType: 'group', messageType: 'text', createTime: String(Date.now()),
    sender: { senderType: 'user', openId: 'human' }, mentions: [],
  };
  const reactions = [];
  const inputs = [];
  const handoffCandidates = [];
  const pilot = createFeishuQuickParticipationPilot(runtime, {
    classify: async context => {
      inputs.push(context);
      return { decision: inputs.length === 1 ? 'silent' : 'reply',
        handoffDecision: inputs.length === 2 ? 'offer' : 'none', confidence: 0.9, latencyMs: 50 };
    },
    react: async (summary, emojiType) => reactions.push([summary.messageId, emojiType]),
    onHandoffCandidate: async summary => handoffCandidates.push(summary.messageId),
  });
  await pilot.handle({ ...base, messageId: 'first', messageText: '链接打不开。' });
  await pilot.handle({ ...base, messageId: 'second', messageText: '是机器人发的测试报告，下午要用。' });
  assert.deepEqual(reactions, []);
  assert.equal(inputs.length, 0, 'legacy receipt path no longer calls a classifier');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(handoffCandidates, []);
  await pilot.handle({ ...base, messageId: 'second', messageText: '是机器人发的测试报告，下午要用。' });
  await pilot.handle({ ...base, chatId: 'other', messageId: 'other' });
  await pilot.handle({ ...base, threadId: 'thread', messageId: 'thread', messageText: '话题里的问题' });
  await pilot.handle({ ...base, sender: { senderType: 'bot', openId: 'other-bot' }, messageId: 'bot' });
  assert.equal(reactions.length, 0, 'topics bypass quick-participation judgment and use direct replies');
  assert.equal(inputs.length, 0);
  const records = (await readFile(join(home, 'quick-participation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(records.every(item => item.decision === undefined));
  await pilot.handle({ ...base, threadId: 'unbound', messageId: 'unbound', messageText: '在话题里决定开工' },
    { reactionMode: 'none' });
  assert.equal(reactions.length, 0, 'unbound topic intake must not add a quick reaction');

  const eventsPath = join(home, 'events.jsonl');
  await writeFile(eventsPath, `${JSON.stringify({ allowed: true, summary: { ...base, messageId: 'restored', messageText: '早上说过报告打不开。' } })}\n`);
  let restoredInput = '';
  const restored = createFeishuQuickParticipationPilot(runtime, {
    classify: async context => { restoredInput = context; return { decision: 'unknown', reason: 'low_support' }; },
    react: async (_summary, emojiType) => reactions.push(['restored-test', emojiType]),
  });
  await restored.restore(eventsPath);
  await restored.handle({ ...base, messageId: 'now', messageText: '下午评审。' });
  assert.equal(restoredInput, '');
  assert.deepEqual(reactions, []);

  restored.seedConversation(base, [
    { messageId: 'bot-reply', timestamp: Date.now(), senderType: 'app', senderId: 'self-app',
      sender: '茵蒂克丝', text: '我可以继续处理报告链接。' },
  ]);
  await restored.handle({ ...base, messageId: 'follow-up', messageText: '那就继续处理。' });
  assert.equal(restoredInput, '');

  const contextualReactions = [];
  const expressive = createFeishuQuickParticipationPilot(runtime, {
    classify: async context => ({ decision: 'silent',
      silentReaction: context.split('\n').at(-1).includes('惊喜') ? 'surprise' : 'none' }),
    react: async (_summary, emojiType) => {
      contextualReactions.push(emojiType);
      return { reactionId: emojiType === 'THINKING' ? 'temporary' : 'expressive' };
    },
  });
  await expressive.handle({ ...base, messageId: 'surprise', messageText: '这个结果真惊喜' });
  await expressive.handle({ ...base, messageId: 'no-reaction', messageText: '两个人聊别的' });
  assert.deepEqual(contextualReactions, []);
  await expressive.handle({ ...base, messageId: 'praise-one', messageText: '这次对了' });
  await expressive.handle({ ...base, messageId: 'praise-two', messageText: '这次对了' });
  assert.deepEqual(contextualReactions.slice(2), []);
  const mentionedReactions = [];
  const mentioned = createFeishuQuickParticipationPilot(runtime, {
    classify: async () => ({ decision: 'silent', silentReaction: 'none' }),
    react: async (_summary, emojiType) => mentionedReactions.push(emojiType),
  });
  await mentioned.handle({ ...base, messageId: 'direct-mention', messageText: '@bot 帮我看看',
    mentions: [{ openId: 'bot' }] });
  assert.deepEqual(mentionedReactions, []);
  const reactionOnly = createFeishuQuickParticipationPilot(runtime, {
    classify: async () => ({ decision: 'reply', handoffDecision: 'none' }),
    react: async (_summary, emojiType) => {
      mentionedReactions.push(emojiType);
      return { reactionId: emojiType };
    },
  });
  await reactionOnly.handle({ ...base, messageId: 'reaction-only',
    messageText: '测试下表情能不能正常回复，茵蒂克丝回复个表情就行' });
  assert.deepEqual(mentionedReactions.slice(1), []);
  const prompt = resolveFeishuGroupSettings(runtime.config, base).systemPrompt;
  assert.match(prompt, /feishu-response:/);
  assert.match(prompt, /General automatic new-topic splitting is deferred/,
    'ambient timeline guard applies even without groupFeed');
  assert.doesNotMatch(prompt, /connector call feishu:react_to_source/);
  const onlyReaction = '<private><feishu-reaction emoji="THANKS"/></private>';
  assert.deepEqual(parseFeishuReactionDirective(onlyReaction),
    { emojiType: 'THANKS', text: '', invalid: false });
  assert.equal(parseFeishuReactionDirective(`${onlyReaction}谢谢你`).text, '谢谢你');
  assert.equal(parseFeishuReactionDirective('<private><feishu-reaction emoji="INVALID"/></private>').invalid, true);
  assert.equal(stripHiddenBlocks(onlyReaction), '');
  assert.equal(classifyAssistantReplyCandidate({ type: 'message', role: 'assistant', content: onlyReaction }).kind, 'suppress');
  assert.equal(await selectAssistantReplyEvent([
    { type: 'message', role: 'assistant', content: 'internal progress' },
    { type: 'message', role: 'assistant', content: onlyReaction },
  ]), null, 'reaction-only final must not publish earlier progress');

  const feishuSession = { id: 'session', sourceId: 'feishu' };
  const run = { id: 'run', responseId: 'response' };
  const history = final => [
    { seq: 1, type: 'message', role: 'user', content: '这次对了' },
    { seq: 2, type: 'message', role: 'assistant', content: 'private commentary' },
    { seq: 3, type: 'message', role: 'assistant', content: final },
  ];
  const reactionPayload = buildReplyPublicationPayload(history(onlyReaction), run,
    { session: feishuSession, includeSessionEntry: false });
  assert.equal(reactionPayload.text, '');
  assert.equal(reactionPayload.reaction, 'THANKS');
  const textPayload = buildReplyPublicationPayload(history('<private><feishu-reaction emoji="OnIt"/></private>简短回答'), run,
    { session: feishuSession, includeSessionEntry: false });
  assert.equal(textPayload.text, '简短回答');
  assert.equal(textPayload.reaction, 'OnIt');
  const plan = { connector: 'feishu', sourceRouteId: 'bot-2', target: { chatId: 'pilot', messageId: 'om_source' } };
  assert.deepEqual(buildReplyDeliveries(plan, textPayload).map(part => part.kind), ['reaction', 'content']);
  assert.deepEqual(buildReplyDeliveries(plan, reactionPayload).map(part => part.kind), ['reaction']);
  const mainReaction = buildReplyDeliveries(plan, reactionPayload)[0];
  assert.equal(mainReaction.reactionStage, 2);
  await outcomeStore.apply('main-correction', 'WOW', createOutcome('quick-wow'));
  await outcomeStore.apply('main-correction', mainReaction.emojiType, createOutcome('main-thanks'),
    { stage: mainReaction.reactionStage });
  await outcomeStore.clean('main-correction', async (messageId, id) => outcomeRemoves.push([messageId, id]));
  assert(outcomeRemoves.some(([messageId, id]) => messageId === 'main-correction' && id === 'quick-wow'));
  const lateQuick = await outcomeStore.apply('main-correction', 'WOW', createOutcome('must-not-revert-main'));
  assert.equal(lateQuick.superseded, true);
  assert(!outcomeCreates.includes('must-not-revert-main'));
  // Keeping Jev's fitting reaction still establishes main-Session ownership,
  // with no second create and no rollback from late quick feedback.
  await outcomeStore.apply('main-keeps', 'THANKS', createOutcome('quick-thanks'));
  await outcomeStore.apply('main-keeps', 'THANKS', createOutcome('duplicate-thanks'), { stage: 2 });
  assert.equal((await outcomeStore.snapshot('main-keeps')).stage, 2);
  const lateAfterKeep = await outcomeStore.apply('main-keeps', 'WOW', createOutcome('late-after-keep'));
  assert.equal(lateAfterKeep.superseded, true);
  assert(!outcomeCreates.includes('duplicate-thanks'));
  assert(!outcomeCreates.includes('late-after-keep'));
  // Main Session can also supply the only reaction when the quick call failed.
  await outcomeStore.apply('main-fallback', mainReaction.emojiType, createOutcome('main-only'),
    { stage: mainReaction.reactionStage });
  assert.deepEqual(buildReplyDeliveries(plan, { text: '' }), [], 'silence must not invent a fallback emoji');

  assert.deepEqual(buildReplyDeliveries(plan, { text: '' }, { requireFeishuOutcome: true })
    .map(part => [part.kind, part.emojiType]), [],
  'legacy required-outcome flags no longer manufacture an emoji');
  assert.deepEqual(buildReplyDeliveries(plan, { text: '答复', reaction: 'BAD' },
    { requireFeishuOutcome: true }).map(part => part.emojiType || part.kind),
  ['content']);
  assert.equal(buildReplyDeliveries({ ...plan, target: { chatId: 'pilot' } }, reactionPayload).length, 0,
    'a reaction needs the bound source message');
  const invalidPayload = buildReplyPublicationPayload(history('<private><feishu-reaction emoji="BAD"/></private>'), run,
    { session: feishuSession, includeSessionEntry: false });
  assert.equal(invalidPayload.reaction, undefined);
  assert.match(invalidPayload.text, /表情指令无效/);
  assert.doesNotMatch(invalidPayload.text, /feishu-reaction/);

  const interruptedWork = [
    { seq: 1, type: 'message', role: 'user', content: '@张思源 看一下 UI' },
    { seq: 2, type: 'message', role: 'assistant', content: 'I will inspect the UI.' },
    { seq: 3, type: 'tool_use', role: 'assistant', toolName: 'exec' },
    { seq: 4, type: 'message', role: 'assistant', content: '' },
  ];
  const silentPayload = buildReplyPublicationPayload(interruptedWork, run,
    { session: feishuSession, includeSessionEntry: false });
  assert.equal(silentPayload.text, '', 'earlier commentary is not a completed Feishu reply');
  assert.match(buildFeishuAmbientIncompleteWorkNotice(interruptedWork, silentPayload, feishuSession), /工作仍未完成/);
  const wrongReactionPayload = buildReplyPublicationPayload([
    ...interruptedWork.slice(0, -1),
    { seq: 4, type: 'message', role: 'assistant', content: '<private><feishu-reaction emoji="EatingFood"/></private>' },
  ], run, { session: feishuSession, includeSessionEntry: false });
  assert.match(buildFeishuAmbientIncompleteWorkNotice(interruptedWork, wrongReactionPayload, feishuSession), /工作仍未完成/,
    'reaction-only cannot conceal tool work');
  assert.equal(buildFeishuAmbientIncompleteWorkNotice(interruptedWork.slice(0, 2), silentPayload), '',
    'mere commentary without tool work does not trigger the incomplete-work notice');
  console.log('test-feishu-quick-participation: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}
