import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-jev-reactions-'));
setIsolatedTestHome(home);
try {
  const { handleMessage } = await import('../scripts/feishu-connector.mjs');
  const { classifyFeishuQuickParticipation } = await import('../connectors/feishu/quick-participation.mjs');
  const { normalizeFeishuGroups, resolveFeishuGroupSettings } = await import('../connectors/feishu/group-settings.mjs');
  const { applyFeishuReplyRouting, buildFeishuSessionConversationTarget,
    buildFeishuRequestDeliveryTarget } = await import('../connectors/feishu/reply-routing.mjs');
  const { shouldReplyInFeishuThread } = await import('../connectors/feishu/index.mjs');
  assert.throws(() => normalizeFeishuGroups({ pilot: { jevReactions: true } }), /jevReactions requires/);
  const config = { storageDir: home, sourceRouteId: 'pilot-bot',
    responsePolicy: { group: 'all' },
    groups: { pilot: { participationMode: 'ambient', groupFeed: true,
      quickReactions: true, jevReactions: true } } };
  const base = { chatId: 'pilot', chatType: 'group', messageType: 'text',
    sender: { senderType: 'user', openId: 'person' }, mentions: [],
    messageId: 'praise', messageText: '你这次做得真棒' };
  assert.equal(resolveFeishuGroupSettings(config, base).jevReactions, true);
  assert.doesNotMatch(resolveFeishuGroupSettings(config, base).systemPrompt, /THINKING|<feishu-reaction emoji=/);
  assert.match(resolveFeishuGroupSettings(config, base).systemPrompt, /Decide whether a useful text reply or task is needed/);
  assert.match(resolveFeishuGroupSettings(config, base).systemPrompt, /stay silent when no text contribution is needed/);
  assert.equal(resolveFeishuGroupSettings(config, { ...base, threadId: 'thread' }).jevReactions, undefined,
    'the pilot must stay on the selected group mainline');
  const workSummary = applyFeishuReplyRouting(config, {
    ...base, replyModeOverride: 'thread', startThread: true,
  });
  const workTarget = buildFeishuRequestDeliveryTarget(workSummary);
  assert.equal(workTarget.conversationKind, 'thread');
  assert.equal(workTarget.rootId, base.messageId);
  assert.equal(workTarget.messageId, base.messageId);
  assert.equal(shouldReplyInFeishuThread(workTarget), true);
  assert.equal(buildFeishuSessionConversationTarget(workSummary).rootId, base.messageId);
  assert.equal(resolveFeishuGroupSettings(config, workSummary).quickReactions, undefined,
    'a new Jev work Session must not inherit the old reaction directive prompt');
  assert.doesNotMatch(resolveFeishuGroupSettings(config, workSummary).systemPrompt,
    /THINKING|<feishu-reaction emoji=/,
    'the new work Session must not be told to answer with a reaction');
  assert.match(resolveFeishuGroupSettings(config, workSummary).systemPrompt,
    /Keep replies in the same topic/);
  assert.equal(resolveFeishuGroupSettings(config, workSummary).responseMode, 'all');

  const classified = await classifyFeishuQuickParticipation('Ada: 你这次做得真棒', {
    key: 'fixture', includeHandoff: false, fetchImpl: async (_url, request) => {
      const { questions } = JSON.parse(request.body);
      assert.deepEqual(Object.keys(questions.emotion.criteria), ['praise', 'criticism', 'none']);
      assert.deepEqual(Object.keys(questions.binaryAnswer.criteria), ['yes', 'no', 'none']);
      assert.deepEqual(Object.keys(questions.workMode.criteria), ['short', 'complex']);
      assert.match(questions.participation.instructions, /only praises, criticizes, or rejects/);
      assert.match(questions.participation.instructions, /how many groups have this bot/);
      assert.match(questions.participation.instructions, /mention alone does not authorize work/);
      return { ok: true, json: async () => ({ answers: {
      participation: { choice: 'silent', probabilities: { silent: 0.98, reply: 0.02 } },
      emotion: { choice: 'praise', probabilities: { praise: 0.96, criticism: 0.01, none: 0.03 } },
    } }) }; },
  });
  assert.equal(classified.decision, 'silent');
  assert.equal(classified.workMode, null);
  assert.equal(classified.emojiType, 'WOW');

  const receiptAnswer = await classifyFeishuQuickParticipation(
    'Ada: 再试一下\nNEWEST MESSAGE TO CLASSIFY: Ada: 你能不能看到这条消息', {
      key: 'fixture', includeHandoff: false, newestText: '你能不能看到这条消息',
      fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
        participation: { choice: 'silent', probabilities: { silent: 0.93, reply: 0.07 } },
        binaryAnswer: { choice: 'yes', probabilities: { yes: 0.98, no: 0.01, none: 0.01 } },
      } }) }),
    });
  assert.equal(receiptAnswer.decision, 'reply');
  assert.equal(receiptAnswer.workMode, 'reaction');
  assert.equal(receiptAnswer.emojiType, 'Yes');

  const olderQuestion = await classifyFeishuQuickParticipation(
    'Ada: 你能不能看到这条消息\nNEWEST MESSAGE TO CLASSIFY: Ada: 看来是不中', {
      key: 'fixture', includeHandoff: false, newestText: '看来是不中',
      fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
        participation: { choice: 'silent', probabilities: { silent: 0.95, reply: 0.05 } },
        binaryAnswer: { choice: 'yes', probabilities: { yes: 0.98, no: 0.01, none: 0.01 } },
        emotion: { choice: 'criticism', probabilities: { criticism: 0.96 } },
      } }) }),
    });
  assert.equal(olderQuestion.decision, 'silent');
  assert.equal(olderQuestion.emojiType, 'TOASTED');

  for (const [choice, probability, expected] of [
    ['short', 0.93, 'short'], ['short', 0.59, 'complex'], ['complex', 0.92, 'complex'],
  ]) {
    const verdict = await classifyFeishuQuickParticipation('Ada: 请答复这个问题', {
      key: 'fixture', includeHandoff: false,
      fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
        participation: { choice: 'reply', probabilities: { silent: 0.02, reply: 0.98 } },
        workMode: { choice, probabilities: { [choice]: probability } },
      } }) }),
    });
    assert.equal(verdict.workMode, expected);
  }

  for (const [choice, probability, expected] of [
    ['criticism', 0.94, 'TOASTED'], ['none', 0.99, null], ['praise', 0.61, null],
  ]) {
    const verdict = await classifyFeishuQuickParticipation('Ada: 这次答得不对', {
      key: 'fixture', includeHandoff: false,
      fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
        participation: { choice: 'silent', probabilities: { silent: 0.98, reply: 0.02 } },
        emotion: { choice, probabilities: { [choice]: probability } },
      } }) }),
    });
    assert.equal(verdict.emojiType, expected);
  }

  await classifyFeishuQuickParticipation('Ada: old group', {
    key: 'fixture', fetchImpl: async (_url, request) => {
      const questions = JSON.parse(request.body).questions;
      assert.equal(questions.emotion, undefined, 'other groups keep their original Jev request size');
      assert.equal(questions.reactionOnly, undefined);
      assert.equal(questions.workMode, undefined);
      assert(questions.projectHandoff);
      assert.doesNotMatch(questions.participation.instructions, /only praises, criticizes, or rejects/);
      return { ok: true, json: async () => ({ answers: {
        participation: { choice: 'silent', probabilities: { silent: 0.98, reply: 0.02 } },
      } }) };
    },
  });

  const emojiOnly = await classifyFeishuQuickParticipation('Ada @Bot: 只回个表情就行，太惊喜了', {
    key: 'fixture', includeHandoff: false, fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      participation: { choice: 'reply', probabilities: { silent: 0.02, reply: 0.98 } },
      emotion: { choice: 'praise', probabilities: { praise: 0.97 } },
      reactionOnly: { choice: 'yes', probabilities: { yes: 0.97, no: 0.03 } },
    } }) }),
  });
  assert.equal(emojiOnly.reactionOnly, true);

  const effects = [];
  const runtime = { config, botIdentity: { openId: 'bot' }, storagePaths: {},
    quickParticipation: { handle: () => { throw new Error('temporary read reaction must not run'); } } };
  const helpers = {
    addProcessingReaction: () => { throw new Error('temporary read reaction must not run'); },
    observeRemoteLabMessage: async (_runtime, summary) => {
      effects.push(`observe:${summary.messageId}`);
      return { sessionId: 'group-session', externalTriggerId: 'group-binding',
        observation: { eventSeq: 1, recent: [
          { time: Date.now(), sender: 'Ada', text: summary.messageText },
        ] } };
    },
    classifyJevReaction: async context => {
      effects.push('jev');
      assert.match(context, /你这次做得真棒|请处理这个问题|只回个表情/);
      return { decision: 'silent', emojiType: 'WOW' };
    },
    recordJevDecision: async (_sessionId, _messageId, decision) => {
      effects.push(`decision:${decision.participation}:${decision.workMode}:${decision.emojiType}`);
      return { decision };
    },
    submitRemoteLabRequest: async (_runtime, workSummary, options) => {
      effects.push(`run:${options.skipUserMessage === true ? 'group' : 'new'}:${workSummary.replyModeOverride || 'inline'}`);
      return { sessionId: options.skipUserMessage ? 'group-session' : 'thread-session',
        runId: 'work-run', requestId: 'work-request' };
    },
    enqueueJevReaction: async (_runtime, _summary, _sessionId, emojiType) => {
      effects.push(`reaction:${emojiType}`);
      return { id: 'delivery' };
    },
  };
  const silent = await handleMessage(runtime, base, 'test', helpers);
  assert.equal(silent.decision.emojiType, 'WOW');
  assert.equal(silent.workSessionId, 'group-session');
  assert.deepEqual(effects, ['observe:praise', 'jev', 'decision:silent:null:WOW', 'run:group:inline', 'reaction:WOW'],
    'Jev keeps the social reaction while the Session model judges whether text is needed');

  effects.length = 0;
  const direct = await handleMessage(runtime, { ...base, messageId: 'work',
    messageText: '请处理这个问题', mentions: [{ openId: 'bot' }] }, 'test', {
      ...helpers, classifyJevReaction: async () => {
        effects.push('jev');
        return { decision: 'reply', workMode: 'complex', emojiType: null };
      },
    });
  assert.equal(direct.runId, 'work-run');
  assert.equal(direct.workSessionId, 'thread-session');
  assert.deepEqual(effects, ['observe:work', 'jev', 'decision:reply:complex:OnIt', 'run:new:thread', 'reaction:OnIt'],
    'complex work starts its own Session and Thread after the group observation');

  effects.length = 0;
  const short = await handleMessage(runtime, { ...base, messageId: 'short',
    messageText: '这个词是什么意思？' }, 'test', {
      ...helpers, classifyJevReaction: async () => {
        effects.push('jev');
        return { decision: 'reply', workMode: 'short' };
      },
    });
  assert.equal(short.workSessionId, 'group-session');
  assert.deepEqual(effects, ['observe:short', 'jev', 'decision:reply:short:OnIt', 'run:group:inline', 'reaction:OnIt'],
    'short work stays in the original Session and group mainline');

  effects.length = 0;
  await handleMessage(runtime, { ...base, messageId: 'legacy-work' }, 'test', {
    ...helpers, observeRemoteLabMessage: async () => ({ sessionId: 'group-session',
      observation: { eventSeq: 2, decision: { participation: 'reply', emojiType: 'OnIt' } } }),
    classifyJevReaction: () => { throw new Error('a persisted decision must not be reclassified'); },
    submitRemoteLabRequest: async (_runtime, _summary, options) => {
      effects.push(`legacy:${options.skipUserMessage}:${options.legacyGroupWorkThread}`);
      return { sessionId: 'group-session', runId: 'old-run' };
    },
  });
  assert.deepEqual(effects, ['legacy:true:true', 'reaction:OnIt'],
    'older decisions replay in their original topology');

  effects.length = 0;
  const mentionedPraise = await handleMessage(runtime, { ...base, messageId: 'mentioned-praise',
    messageText: '你这次做得真棒', mentions: [{ openId: 'bot' }] }, 'test', helpers);
  assert.equal(mentionedPraise.decision.participation, 'reply');
  assert.deepEqual(effects, ['observe:mentioned-praise', 'jev', 'decision:reply:short:OnIt',
    'run:group:inline', 'reaction:OnIt'],
    'a direct mention falls back to the existing group Session with one work reaction');

  effects.length = 0;
  const mentionedCriticism = await handleMessage(runtime, { ...base, messageId: 'mentioned-criticism',
    messageText: '你这次回答得很差', mentions: [{ openId: 'bot' }] }, 'test', {
      ...helpers, classifyJevReaction: async () => {
        effects.push('jev');
        return { decision: 'silent', emojiType: 'TOASTED' };
      },
    });
  assert.equal(mentionedCriticism.decision.participation, 'reply');
  assert.deepEqual(effects, ['observe:mentioned-criticism', 'jev',
    'decision:reply:short:OnIt', 'run:group:inline', 'reaction:OnIt']);

  effects.length = 0;
  const testMention = await handleMessage(runtime, { ...base, messageId: 'test-mention',
    messageText: '用户彻底怒了！', mentions: [{ openId: 'bot' }] }, 'test', {
      ...helpers, classifyJevReaction: async () => {
        effects.push('jev');
        return { decision: 'unknown', reason: 'low_support', emojiType: null };
      },
    });
  assert.equal(testMention.decision.participation, 'reply');
  assert.deepEqual(effects, ['observe:test-mention', 'jev', 'decision:reply:short:OnIt',
    'run:group:inline', 'reaction:OnIt'],
    'an uncertain @ mention wakes the existing group Session with only OnIt');

  effects.length = 0;
  const onlyReaction = await handleMessage(runtime, { ...base, messageId: 'emoji-only',
    messageText: '只回个表情就行，太惊喜了', mentions: [{ openId: 'bot' }] }, 'test', {
    ...helpers, classifyJevReaction: async () => {
      effects.push('jev');
      return { decision: 'reply', reactionOnly: true, emojiType: 'WOW' };
    },
  });
  assert.equal(onlyReaction.decision.participation, 'silent');
  assert.equal(onlyReaction.runId, 'work-run');
  assert.deepEqual(effects, ['observe:emoji-only', 'jev', 'decision:silent:null:WOW', 'run:group:inline', 'reaction:WOW'],
    'a reaction-only classification cannot suppress the Session model');

  effects.length = 0;
  const yes = await handleMessage(runtime, { ...base, messageId: 'receipt-question',
    messageText: '你能不能看到这条消息' }, 'test', {
      ...helpers, classifyJevReaction: async () => {
        effects.push('jev');
        return { decision: 'reply', workMode: 'reaction', emojiType: 'Yes' };
      },
    });
  assert.equal(yes.decision.participation, 'reply');
  assert.equal(yes.runId, 'work-run');
  assert.equal(yes.workSessionId, 'group-session');
  assert.deepEqual(effects, ['observe:receipt-question', 'jev',
    'decision:reply:reaction:Yes', 'run:group:inline', 'reaction:Yes'],
    'a binary reaction is preserved and still reaches the existing Session for reply judgment');

  for (const [messageId, messageText, emojiType] of [
    ['criticism', '你这次答得不对', 'TOASTED'],
    ['neutral', '今天下午三点开会', null],
    ['thanks', '谢谢', null],
  ]) {
    effects.length = 0;
    const outcome = await handleMessage(runtime, { ...base, messageId, messageText }, 'test', {
      ...helpers, classifyJevReaction: async () => {
        effects.push('jev');
        return { decision: 'silent', emojiType };
      },
    });
    assert.equal(outcome.decision.emojiType, emojiType);
    assert.equal(outcome.runId, 'work-run');
    assert.deepEqual(effects, ['observe:' + messageId, 'jev',
      `decision:silent:null:${emojiType}`, 'run:group:inline', ...(emojiType ? [`reaction:${emojiType}`] : [])]);
    assert.equal('deliveryId' in outcome, Boolean(emojiType));
  }

  for (const reason of ['timeout', 'missing_key', 'low_support', 'request_error']) {
    effects.length = 0;
    const outcome = await handleMessage(runtime, { ...base, messageId: reason,
      messageText: '刚才的问题还没有回答，请再看一下' }, 'test', {
      ...helpers, classifyJevReaction: async () => {
        effects.push('jev');
        return { decision: 'unknown', reason };
      },
    });
    assert.equal(outcome.runId, 'work-run');
    assert.equal(outcome.workSessionId, 'group-session');
    assert.deepEqual(effects, [`observe:${reason}`, 'jev', 'decision:silent:null:null', 'run:group:inline'],
      'failed or uncertain Jev classification must forward an unmentioned message without a fallback reaction');
  }

  effects.length = 0;
  const replay = await handleMessage(runtime, { ...base, messageId: 'replay' }, 'test', {
    ...helpers, observeRemoteLabMessage: async () => ({ sessionId: 'group-session',
      observation: { eventSeq: 2, decision: { participation: 'silent', emojiType: 'TEARS' } } }),
    classifyJevReaction: () => { throw new Error('replay must reuse the persisted decision'); },
  });
  assert.equal(replay.decision.emojiType, 'TEARS');
  assert.deepEqual(effects, ['run:group:inline', 'reaction:TEARS'],
    'replay reuses the reaction decision while resubmitting through the idempotent Session request path');
  const { GROUP_ROUTING_PILOT_FILE } = await import('../lib/group-routing-pilot.mjs');
  await mkdir(join(home, '.config/remotelab'), { recursive: true });
  await writeFile(GROUP_ROUTING_PILOT_FILE, JSON.stringify({ version: 1, enabled: true,
    groups: [{ sourceRouteId: 'pilot-bot', chatId: 'pilot', tenantKey: 'tenant', folder: home }] }));
  effects.length = 0;
  const routedPilot = await handleMessage(runtime, { ...base, tenantKey: 'tenant', messageId: 'pilot-complex' }, 'test', {
    ...helpers, classifyJevReaction: async () => ({ decision: 'reply', workMode: 'complex' }),
  });
  assert.equal(routedPilot.workSessionId, 'group-session', 'pilot lets the main Harness choose new work versus supplement');
  assert(effects.includes('run:group:inline')); assert(!effects.includes('run:new:thread'));
  effects.length = 0;
  const otherTenant = await handleMessage(runtime, { ...base, tenantKey: 'another', messageId: 'other-tenant-complex' }, 'test', {
    ...helpers, classifyJevReaction: async () => ({ decision: 'reply', workMode: 'complex' }),
  });
  assert.equal(otherTenant.workSessionId, 'thread-session', 'all non-pilot routes preserve Jev placement');
  console.log('test-feishu-jev-reactions: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}
