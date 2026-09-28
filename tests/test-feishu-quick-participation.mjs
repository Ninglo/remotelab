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
  const { createFeishuReadReactionStore } = await import('../connectors/feishu/read-reactions.mjs');
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
  assert.deepEqual(callOrder, ['reaction', 'classify']);
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
  assert.deepEqual(pilotReactionOrder, ['start:THINKING'], 'pilot status must wait for the read receipt');
  completeThinking();
  await orderedTurn;
  assert.deepEqual(pilotReactionOrder, ['start:THINKING', 'done:THINKING']);
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
  assert.deepEqual(submitOrder, ['start:THINKING']);
  releaseRead();
  await admission;
  assert.deepEqual(submitOrder, ['start:THINKING', 'done:THINKING', 'submit']);
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
  assert.deepEqual(reactions, [
    ['first', 'THINKING'], ['second', 'THINKING'],
  ]);
  assert.match(inputs[1], /链接打不开/);
  assert.match(inputs[1], /下午要用/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(handoffCandidates, ['second']);
  await pilot.handle({ ...base, messageId: 'second', messageText: '是机器人发的测试报告，下午要用。' });
  await pilot.handle({ ...base, chatId: 'other', messageId: 'other' });
  await pilot.handle({ ...base, threadId: 'thread', messageId: 'thread', messageText: '话题里的问题' });
  await pilot.handle({ ...base, sender: { senderType: 'bot', openId: 'other-bot' }, messageId: 'bot' });
  assert.equal(reactions.length, 3);
  assert.doesNotMatch(inputs[2], /链接打不开/);
  const records = (await readFile(join(home, 'quick-participation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(item => item.decision), ['silent', 'reply', 'reply']);
  await pilot.handle({ ...base, threadId: 'unbound', messageId: 'unbound', messageText: '在话题里决定开工' },
    { reactionMode: 'none' });
  assert.equal(reactions.length, 3, 'unbound thread scanning must not add a reaction');

  const eventsPath = join(home, 'events.jsonl');
  await writeFile(eventsPath, `${JSON.stringify({ allowed: true, summary: { ...base, messageId: 'restored', messageText: '早上说过报告打不开。' } })}\n`);
  let restoredInput = '';
  const restored = createFeishuQuickParticipationPilot(runtime, {
    classify: async context => { restoredInput = context; return { decision: 'unknown', reason: 'low_support' }; },
    react: async (_summary, emojiType) => reactions.push(['restored-test', emojiType]),
  });
  await restored.restore(eventsPath);
  await restored.handle({ ...base, messageId: 'now', messageText: '下午评审。' });
  assert.match(restoredInput, /早上说过报告打不开/);
  assert.deepEqual(reactions.at(-1), ['restored-test', 'THINKING']);

  restored.seedConversation({ ...base, threadId: 'ongoing' }, [
    { messageId: 'bot-reply', timestamp: Date.now(), senderType: 'app', senderId: 'self-app',
      sender: '茵蒂克丝', text: '我可以继续处理报告链接。' },
  ]);
  await restored.handle({ ...base, threadId: 'ongoing', messageId: 'follow-up', messageText: '那就继续处理。' });
  assert.match(restoredInput, /assistant: 我可以继续处理报告链接/);

  const uncertain = await classifyFeishuQuickParticipation('A: @bot', {
    key: 'test-key',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      model: 'jev-test', answers: { participation: {
        choice: 'reply', confidence: 0.01, probabilities: { reply: 0.5, silent: 0.5 },
      } },
    }) }),
  });
  assert.equal(uncertain.decision, 'unknown');
  assert.equal(uncertain.reason, 'low_support');
  const weakSilent = await classifyFeishuQuickParticipation('A: 怎么压缩时间', {
    key: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({
      answers: { participation: { choice: 'silent', confidence: 0.7,
        probabilities: { reply: 0.21, silent: 0.79 } } },
    }) }),
  });
  assert.equal(weakSilent.decision, 'unknown', 'weak silence must not promise to ignore a possible request');
  const handoff = await classifyFeishuQuickParticipation('A: 方案定了，转干活群开始做', {
    key: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      participation: { choice: 'reply', probabilities: { reply: 0.95, silent: 0.05 } },
      projectHandoff: { choice: 'offer', probabilities: { offer: 0.94, none: 0.06 } },
    } }) }),
  });
  assert.equal(handoff.handoffDecision, 'offer');
  assert.equal(weakSilent.handoffDecision, 'none');
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
  assert.deepEqual(contextualReactions, ['THINKING', 'THINKING']);
  await expressive.handle({ ...base, messageId: 'praise-one', messageText: '这次对了' });
  await expressive.handle({ ...base, messageId: 'praise-two', messageText: '这次对了' });
  assert.deepEqual(contextualReactions.slice(2), ['THINKING', 'THINKING']);
  const mentionedReactions = [];
  const mentioned = createFeishuQuickParticipationPilot(runtime, {
    classify: async () => ({ decision: 'silent', silentReaction: 'none' }),
    react: async (_summary, emojiType) => mentionedReactions.push(emojiType),
  });
  await mentioned.handle({ ...base, messageId: 'direct-mention', messageText: '@bot 帮我看看',
    mentions: [{ openId: 'bot' }] });
  assert.deepEqual(mentionedReactions, ['THINKING']);
  const reactionOnly = createFeishuQuickParticipationPilot(runtime, {
    classify: async () => ({ decision: 'reply', handoffDecision: 'none' }),
    react: async (_summary, emojiType) => {
      mentionedReactions.push(emojiType);
      return { reactionId: emojiType };
    },
  });
  await reactionOnly.handle({ ...base, messageId: 'reaction-only',
    messageText: '测试下表情能不能正常回复，茵蒂克丝回复个表情就行' });
  assert.deepEqual(mentionedReactions.slice(1), ['THINKING']);
  const prompt = resolveFeishuGroupSettings(runtime.config, base).systemPrompt;
  assert.match(prompt, /<feishu-reaction emoji=/);
  assert.match(prompt, /Keep this timeline for observing the discussion/,
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
  assert.deepEqual(buildReplyDeliveries(plan, { text: '' }, { requireFeishuOutcome: true })
    .map(part => [part.kind, part.emojiType]), [['reaction', 'EatingFood']],
  'an empty model result still leaves one final reaction');
  assert.deepEqual(buildReplyDeliveries(plan, { text: '答复', reaction: 'BAD' },
    { requireFeishuOutcome: true }).map(part => part.emojiType || part.kind),
  ['EatingFood', 'content']);
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
