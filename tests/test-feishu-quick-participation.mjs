import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-quick-participation-'));
setIsolatedTestHome(home);
try {
  const { classifyFeishuQuickParticipation, createFeishuQuickParticipationPilot, isReactionOnlyRequest, SILENT_REACTION_EMOJI } =
    await import('../connectors/feishu/quick-participation.mjs');
  const { createQuickParticipationReaction } = await import('../scripts/feishu-connector.mjs');
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
  assert.deepEqual(pilotReactionOrder, ['start:THINKING', 'done:THINKING', 'start:OnIt', 'done:OnIt']);
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
        silentReaction: 'seen',
        handoffDecision: inputs.length === 2 ? 'offer' : 'none', confidence: 0.9, latencyMs: 50 };
    },
    react: async (summary, emojiType) => reactions.push([summary.messageId, emojiType]),
    onHandoffCandidate: async summary => handoffCandidates.push(summary.messageId),
  });
  await pilot.handle({ ...base, messageId: 'first', messageText: '链接打不开。' });
  await pilot.handle({ ...base, messageId: 'second', messageText: '是机器人发的测试报告，下午要用。' });
  assert.deepEqual(reactions, [
    ['first', 'THINKING'], ['first', 'GLANCE'],
    ['second', 'THINKING'],
  ]);
  assert.match(inputs[1], /链接打不开/);
  assert.match(inputs[1], /下午要用/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(handoffCandidates, ['second']);
  await pilot.handle({ ...base, messageId: 'second', messageText: '是机器人发的测试报告，下午要用。' });
  await pilot.handle({ ...base, chatId: 'other', messageId: 'other' });
  await pilot.handle({ ...base, threadId: 'thread', messageId: 'thread', messageText: '话题里的问题' });
  await pilot.handle({ ...base, sender: { senderType: 'bot', openId: 'other-bot' }, messageId: 'bot' });
  assert.equal(reactions.length, 5);
  assert.doesNotMatch(inputs[2], /链接打不开/);
  const records = (await readFile(join(home, 'quick-participation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(item => item.decision), ['silent', 'reply', 'reply']);
  await pilot.handle({ ...base, threadId: 'unbound', messageId: 'unbound', messageText: '在话题里决定开工' },
    { reactionMode: 'none' });
  assert.equal(reactions.length, 5, 'unbound thread scanning must not add a reply reaction');

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
  const praise = await classifyFeishuQuickParticipation('A: 你做得很好，谢谢', {
    key: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      participation: { choice: 'silent', probabilities: { reply: 0.05, silent: 0.95 } },
      silentReaction: { choice: 'thanks', probabilities: { thanks: 0.92, seen: 0.03, none: 0.05 } },
    } }) }),
  });
  assert.equal(praise.silentReaction, 'thanks');
  const modestPraise = await classifyFeishuQuickParticipation('assistant: 完成了。\nuser: 谢谢你！', {
    key: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      participation: { choice: 'silent', probabilities: { reply: 0, silent: 1 } },
      silentReaction: { choice: 'thanks', probabilities: { thanks: 0.52, none: 0.47, seen: 0.01 } },
    } }) }),
  });
  assert.equal(modestPraise.silentReaction, 'thanks');
  const ambiguousPraise = await classifyFeishuQuickParticipation('assistant: 完成了。\nuser: 嗯', {
    key: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      participation: { choice: 'silent', probabilities: { reply: 0, silent: 1 } },
      silentReaction: { choice: 'thanks', probabilities: { thanks: 0.51, none: 0.49 } },
    } }) }),
  });
  assert.equal(ambiguousPraise.silentReaction, 'none');
  assert.deepEqual(SILENT_REACTION_EMOJI, {
    thanks: 'THANKS', seen: 'GLANCE', surprise: 'WOW', puzzled: 'WHAT',
    setback: 'DULL', teary: 'TEARS',
  });
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
  assert.deepEqual(contextualReactions, ['THINKING', 'WOW', 'THINKING']);
  const mentionedReactions = [];
  const mentioned = createFeishuQuickParticipationPilot(runtime, {
    classify: async () => ({ decision: 'silent', silentReaction: 'none' }),
    react: async (_summary, emojiType) => mentionedReactions.push(emojiType),
  });
  await mentioned.handle({ ...base, messageId: 'direct-mention', messageText: '@bot 帮我看看',
    mentions: [{ openId: 'bot' }] });
  assert.deepEqual(mentionedReactions, ['THINKING', 'OnIt']);
  assert.equal(isReactionOnlyRequest({ messageText: '茵蒂克丝回复个表情就行' }), true);
  assert.equal(isReactionOnlyRequest({ messageText: '帮我看看，回文字' }), false);
  const reactionOnly = createFeishuQuickParticipationPilot(runtime, {
    classify: async () => ({ decision: 'reply', handoffDecision: 'none' }),
    react: async (_summary, emojiType) => {
      mentionedReactions.push(emojiType);
      return { reactionId: emojiType };
    },
  });
  await reactionOnly.handle({ ...base, messageId: 'reaction-only',
    messageText: '测试下表情能不能正常回复，茵蒂克丝回复个表情就行' });
  assert.deepEqual(mentionedReactions.slice(2), ['THINKING']);
  console.log('test-feishu-quick-participation: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}
