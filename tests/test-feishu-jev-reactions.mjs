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
  assert.match(resolveFeishuGroupSettings(config, base).systemPrompt, /optionally start your final answer/);
  assert.match(resolveFeishuGroupSettings(config, base).systemPrompt, /precedence over a late quick reaction/);
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


  for (const [choice, probability, expected] of [
    ['WOW', .96, 'WOW'], ['Get', .94, 'Get'], ['THANKS', .94, 'THANKS'],
    ['none', .99, null], ['Yes', .99, null], ['DONE', .99, null], ['WOW', .5, null], ['WOW', 2, null],
  ]) {
    const verdict = await classifyFeishuQuickParticipation('NEWEST MESSAGE TO CLASSIFY: thanks', {
      key: 'fixture', projectMemory: { secret: 'must not be sent' }, participationState: { mode: 'active' },
      fetchImpl: async (_url, req) => {
        const body = JSON.parse(req.body);
        assert.equal(_url, 'https://api.typesafe.ai/v1/systemone');
        assert.equal(body.model, 'jev-1.13.0');
        assert.equal(body.state.discussion, 'NEWEST MESSAGE TO CLASSIFY: thanks');
        assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
        assert.deepEqual(Object.keys(body.questions), ['reaction']);
        assert.equal(body.questions.reaction.type, 'choice');
        assert(!Object.hasOwn(body.questions.reaction.criteria, 'Yes'));
        assert(Object.hasOwn(body.questions.reaction.criteria, 'none'));
        return { ok: true, json: async () => ({ answers: {
          reaction: { choice, probabilities: { [choice]: probability } },
          participation: { choice: 'silent' }, workMode: { choice: 'complex' },
        } }) };
      },
    });
    assert.equal(verdict.emojiType, expected);
    for (const field of ['decision', 'workMode', 'controlMode', 'invited', 'handoffDecision']) assert.equal(field in verdict, false);
  }
  assert.equal((await classifyFeishuQuickParticipation('test', { key: 'fixture',
    fetchImpl: async () => ({ ok: false, status: 402 }) })).reason, 'http_402');

  // Use the restored TypeSafe credential, never a slower provider fallback.
  // Missing credentials must not call the network; file changes are picked up.
  const { feishuReactionApiKey } = await import('../connectors/feishu/quick-participation.mjs');
  const savedEnv = Object.fromEntries(['TYPESAFE_API_KEY', 'TYPESAFE_KEY_FILE', 'OPENAI_API_KEY'].map(name => [name, process.env[name]]));
  try {
    delete process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_KEY_FILE = join(home, 'typesafe.env');
    process.env.OPENAI_API_KEY = 'must-not-reuse';
    const missing = await classifyFeishuQuickParticipation('test', { fetchImpl: () => assert.fail('no API key must not call provider') });
    assert.equal(missing.reason, 'missing_key');
    await writeFile(process.env.TYPESAFE_KEY_FILE, 'TYPESAFE_API_KEY="file-fixture"\n');
    assert.equal(await feishuReactionApiKey(), 'file-fixture');
    process.env.TYPESAFE_API_KEY = 'env-fixture';
    assert.equal(await feishuReactionApiKey(), 'env-fixture');
  } finally {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  for (const answers of [null, {}, { reaction: { type: 'refusal' } },
    { other: { choice: 'WOW', probabilities: { WOW: .99 } } },
    { reaction: { choice: 'WOW', probabilities: { WOW: '0.99' } } }]) {
    assert.equal((await classifyFeishuQuickParticipation('test', { key: 'fixture',
      fetchImpl: async () => ({ ok: true, json: async () => ({ answers }) }) })).emojiType, null);
  }
  const timedOut = await classifyFeishuQuickParticipation('test', { key: 'fixture', timeoutMs: 1,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }) });
  assert.equal(timedOut.reason, 'timeout');
  assert.equal((await classifyFeishuQuickParticipation('test', { key: 'fixture',
    fetchImpl: async () => { throw new Error('fixture secret must not escape'); } })).reason, 'request_error');
  for (const settings of [{ responseMode: 'all' }, { responseMode: 'mention_only' },
    { participationMode: 'ambient', quickReactions: true }, { participationMode: 'ambient', groupFeed: true }]) {
    const other = resolveFeishuGroupSettings({ groups: { other: settings } }, { ...base, chatId: 'other' });
    assert.equal(other.jevReactions, undefined, 'only explicit per-group opt-in may call Jev');
    assert.doesNotMatch(other.systemPrompt, /Jev only selects/);
  }

  const { observeSessionMessage, recordSessionObservationDecision } = await import('../chat/session-observations.mjs');
  await observeSessionMessage('social', { sourceMessageId: 'source', text: 'thanks' });
  const stored = await recordSessionObservationDecision('social', 'source', { purpose: 'reaction', emojiType: 'THANKS' });
  assert.equal(stored.participation, undefined);
  assert.equal(stored.workMode, undefined);
  assert.equal((await recordSessionObservationDecision('social', 'source', { purpose: 'reaction', emojiType: 'WOW' })).emojiType, 'THANKS');
  await observeSessionMessage('social', { sourceMessageId: 'invalid', text: 'done?' });
  await assert.rejects(recordSessionObservationDecision('social', 'invalid', { purpose: 'reaction', emojiType: 'Yes' }), /Invalid social/);
  await assert.rejects(recordSessionObservationDecision('social', 'invalid', { purpose: 'reaction', emojiType: 'Get', participation: 'reply' }), /Invalid social/);

  const runtime = { config, botIdentity: { openId: 'bot' }, storagePaths: {} };
  const sent = [], submissions = [];
  const helpers = {
    observeRemoteLabMessage: async (_r, summary) => ({ sessionId: 'group-session',
      observation: { eventSeq: 1, recent: [{ text: summary.messageText }] } }),
    classifyJevReaction: async () => ({ emojiType: 'WOW' }),
    recordJevDecision: async (_s, _m, decision) => ({ decision }),
    submitRemoteLabRequest: async (_r, summary, options) => {
      submissions.push({ summary, options });
      assert.equal(options.skipUserMessage, true);
      assert.equal(options.legacyGroupWorkThread, undefined);
      assert.notEqual(summary.startThread, true);
      return { sessionId: 'group-session', runId: 'run' };
    },
    enqueueJevReaction: async (_r, summary, _s, emoji) => { sent.push([summary.messageId, emoji]); return { id: 'reaction' }; },
  };
  const drain = () => Promise.all([...runtime.jevReactionJobs.values()]);
  // A deliberately unresolved classifier must not hold the input or receipt.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = await handleMessage(runtime, base, 'test', { ...helpers, classifyJevReaction: () => gate });
  assert.equal(first.runId, 'run');
  assert.equal(sent.length, 0);
  release({ decision: 'silent', workMode: 'complex', controlMode: 'paused', emojiType: 'WOW' });
  await drain();
  assert.deepEqual(sent, [['praise', 'WOW']]);
  for (const failure of ['throw', 'record', 'enqueue']) {
    const receipt = await handleMessage(runtime, { ...base, messageId: failure }, 'test', {
      ...helpers,
      ...(failure === 'throw' ? { classifyJevReaction: () => { throw new Error('classifier offline'); } } : {}),
      ...(failure === 'record' ? { recordJevDecision: async () => { throw new Error('record offline'); } } : {}),
      ...(failure === 'enqueue' ? { enqueueJevReaction: async () => { throw new Error('queue offline'); } } : {}),
    });
    assert.equal(receipt.runId, 'run');
    await drain();
  }
  // Persisted old semantics never choose a new Session or answer a fact.
  for (const emoji of ['Yes', 'OnIt', 'THANKS']) {
    const receipt = await handleMessage(runtime, { ...base, messageId: 'old-' + emoji }, 'test', {
      ...helpers, observeRemoteLabMessage: async () => ({ sessionId: 'group-session', observation: {
        eventSeq: 2, decision: { participation: 'reply', workMode: 'complex', emojiType: emoji },
      } }),
      classifyJevReaction: () => { throw new Error('do not reclassify'); },
    });
    assert.equal(receipt.workSessionId, 'group-session');
    await drain();
  }
  assert.deepEqual(sent.slice(1), [['old-THANKS', 'THANKS']]);
  // Feedback also runs while input preparation is slow, using its own address.
  let releaseInput, feedbackDone;
  const input = new Promise(resolve => { releaseInput = resolve; });
  const feedback = new Promise(resolve => { feedbackDone = resolve; });
  const pending = handleMessage(runtime, { ...base, messageId: 'slow-input' }, 'test', {
    ...helpers, submitRemoteLabRequest: () => input,
    enqueueJevReaction: async (_r, summary) => { assert.equal(summary.messageId, 'slow-input'); feedbackDone(); },
  });
  await feedback;
  releaseInput({ sessionId: 'group-session' });
  await pending;
  await drain();
  // A late reaction cannot survive an explicit pause/resume epoch change.
  let epoch = 1, releaseLate;
  runtime.config.groups.pilot.participationControls = true;
  runtime.participation = {
    state: async () => ({ mode: 'active', epoch }), intake: async () => null,
    remember: async () => {}, assess: async () => {},
  };
  const late = new Promise(resolve => { releaseLate = resolve; });
  await handleMessage(runtime, { ...base, messageId: 'late' }, 'test', { ...helpers, classifyJevReaction: () => late });
  epoch++;
  releaseLate({ emojiType: 'Get' });
  await drain();
  assert(!sent.some(([id]) => id === 'late'));
  console.log('test-feishu-jev-reactions: ok');
} finally { await rm(home, { recursive: true, force: true }); }
