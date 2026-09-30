import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

  const classified = await classifyFeishuQuickParticipation('Ada: 你这次做得真棒', {
    key: 'fixture', includeHandoff: false, fetchImpl: async (_url, request) => {
      const { questions } = JSON.parse(request.body);
      assert.deepEqual(Object.keys(questions.emotion.criteria), ['praise', 'criticism', 'none']);
      assert.deepEqual(Object.keys(questions.workMode.criteria), ['short', 'complex']);
      assert.match(questions.participation.instructions, /only praises, criticizes, or rejects/);
      return { ok: true, json: async () => ({ answers: {
      participation: { choice: 'silent', probabilities: { silent: 0.98, reply: 0.02 } },
      emotion: { choice: 'praise', probabilities: { praise: 0.96, criticism: 0.01, none: 0.03 } },
    } }) }; },
  });
  assert.equal(classified.decision, 'silent');
  assert.equal(classified.emojiType, 'WOW');

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
    ['criticism', 0.94, 'DULL'], ['none', 0.99, null], ['praise', 0.61, null],
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
  assert.deepEqual(effects, ['observe:praise', 'jev', 'decision:silent:null:WOW', 'reaction:WOW'],
    'a social reaction needs one Jev decision, one scripted delivery and no Harness Run');

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
  assert.equal(mentionedPraise.decision.participation, 'silent');
  assert.deepEqual(effects, ['observe:mentioned-praise', 'jev', 'decision:silent:null:WOW', 'reaction:WOW'],
    'a direct mention with clear praise and a silent Jev verdict does not start work');

  effects.length = 0;
  const mentionedCriticism = await handleMessage(runtime, { ...base, messageId: 'mentioned-criticism',
    messageText: '你这次回答得很差', mentions: [{ openId: 'bot' }] }, 'test', {
      ...helpers, classifyJevReaction: async () => {
        effects.push('jev');
        return { decision: 'silent', emojiType: 'DULL' };
      },
    });
  assert.equal(mentionedCriticism.decision.participation, 'silent');
  assert.deepEqual(effects, ['observe:mentioned-criticism', 'jev',
    'decision:silent:null:DULL', 'reaction:DULL']);

  effects.length = 0;
  const onlyReaction = await handleMessage(runtime, { ...base, messageId: 'emoji-only',
    messageText: '只回个表情就行，太惊喜了', mentions: [{ openId: 'bot' }] }, 'test', {
    ...helpers, classifyJevReaction: async () => {
      effects.push('jev');
      return { decision: 'reply', reactionOnly: true, emojiType: 'WOW' };
    },
  });
  assert.equal(onlyReaction.decision.participation, 'silent');
  assert.deepEqual(effects, ['observe:emoji-only', 'jev', 'decision:silent:null:WOW', 'reaction:WOW']);

  for (const [messageId, messageText, emojiType] of [
    ['criticism', '你这次答得不对', 'DULL'],
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
    assert.deepEqual(effects, ['observe:' + messageId, 'jev',
      `decision:silent:null:${emojiType}`, ...(emojiType ? [`reaction:${emojiType}`] : [])]);
    assert.equal('deliveryId' in outcome, Boolean(emojiType));
  }

  effects.length = 0;
  const replay = await handleMessage(runtime, { ...base, messageId: 'replay' }, 'test', {
    ...helpers, observeRemoteLabMessage: async () => ({ sessionId: 'group-session',
      observation: { eventSeq: 2, decision: { participation: 'silent', emojiType: 'TEARS' } } }),
    classifyJevReaction: () => { throw new Error('replay must reuse the persisted decision'); },
  });
  assert.equal(replay.decision.emojiType, 'TEARS');
  assert.deepEqual(effects, ['reaction:TEARS']);
  console.log('test-feishu-jev-reactions: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}
