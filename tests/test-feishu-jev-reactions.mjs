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
  assert.throws(() => normalizeFeishuGroups({ pilot: { jevReactions: true } }), /jevReactions requires/);
  const config = { storageDir: home, sourceRouteId: 'pilot-bot',
    responsePolicy: { group: 'all' },
    groups: { pilot: { participationMode: 'ambient', groupFeed: true,
      quickReactions: true, jevReactions: true } } };
  const base = { chatId: 'pilot', chatType: 'group', messageType: 'text',
    sender: { senderType: 'user', openId: 'person' }, mentions: [],
    messageId: 'surprise', messageText: '这个结果真惊喜' };
  assert.equal(resolveFeishuGroupSettings(config, base).jevReactions, true);
  assert.doesNotMatch(resolveFeishuGroupSettings(config, base).systemPrompt, /THINKING|<feishu-reaction emoji=/);
  assert.equal(resolveFeishuGroupSettings(config, { ...base, threadId: 'thread' }).jevReactions, undefined,
    'the pilot must stay on the selected group mainline');

  const classified = await classifyFeishuQuickParticipation('Ada: 这个结果真惊喜', {
    key: 'fixture', includeHandoff: false, fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      participation: { choice: 'silent', probabilities: { silent: 0.98, reply: 0.02 } },
      emotion: { choice: 'surprise' },
    } }) }),
  });
  assert.equal(classified.decision, 'silent');
  assert.equal(classified.emojiType, 'WOW');

  await classifyFeishuQuickParticipation('Ada: old group', {
    key: 'fixture', fetchImpl: async (_url, request) => {
      const questions = JSON.parse(request.body).questions;
      assert.equal(questions.emotion, undefined, 'other groups keep their original Jev request size');
      assert.equal(questions.reactionOnly, undefined);
      assert(questions.projectHandoff);
      return { ok: true, json: async () => ({ answers: {
        participation: { choice: 'silent', probabilities: { silent: 0.98, reply: 0.02 } },
      } }) };
    },
  });

  const emojiOnly = await classifyFeishuQuickParticipation('Ada @Bot: 只回个表情就行，太惊喜了', {
    key: 'fixture', includeHandoff: false, fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      participation: { choice: 'reply', probabilities: { silent: 0.02, reply: 0.98 } },
      emotion: { choice: 'surprise' },
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
      assert.match(context, /这个结果真惊喜|请处理这个问题|只回个表情/);
      return { decision: 'silent', emojiType: 'WOW' };
    },
    recordJevDecision: async (_sessionId, _messageId, decision) => {
      effects.push(`decision:${decision.participation}:${decision.emojiType}`);
      return { decision };
    },
    submitRemoteLabRequest: async (_runtime, _summary, options) => {
      effects.push(`run:${options.skipUserMessage}`);
      return { runId: 'work-run', requestId: 'work-request' };
    },
    enqueueJevReaction: async (_runtime, _summary, _sessionId, emojiType) => {
      effects.push(`reaction:${emojiType}`);
      return { id: 'delivery' };
    },
  };
  const silent = await handleMessage(runtime, base, 'test', helpers);
  assert.equal(silent.decision.emojiType, 'WOW');
  assert.deepEqual(effects, ['observe:surprise', 'jev', 'decision:silent:WOW', 'reaction:WOW'],
    'a social reaction needs one Jev decision, one scripted delivery and no Harness Run');

  effects.length = 0;
  const direct = await handleMessage(runtime, { ...base, messageId: 'work',
    messageText: '请处理这个问题', mentions: [{ openId: 'bot' }] }, 'test', helpers);
  assert.equal(direct.runId, 'work-run');
  assert.deepEqual(effects, ['observe:work', 'jev', 'decision:reply:OnIt', 'run:true', 'reaction:OnIt'],
    'an accepted task gets OnIt after Run admission without a read reaction');

  effects.length = 0;
  const onlyReaction = await handleMessage(runtime, { ...base, messageId: 'emoji-only',
    messageText: '只回个表情就行，太惊喜了', mentions: [{ openId: 'bot' }] }, 'test', {
    ...helpers, classifyJevReaction: async () => {
      effects.push('jev');
      return { decision: 'reply', reactionOnly: true, emojiType: 'WOW' };
    },
  });
  assert.equal(onlyReaction.decision.participation, 'silent');
  assert.deepEqual(effects, ['observe:emoji-only', 'jev', 'decision:silent:WOW', 'reaction:WOW']);

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
