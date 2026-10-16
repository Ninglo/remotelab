import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'feishu-unified-'));
setIsolatedTestHome(home);
try {
  const { effectiveFeishuGroup, normalizeFeishuGroups, resolveFeishuGroupSettings } = await import('../connectors/feishu/group-settings.mjs');
  const { FEISHU_CONFIRMED_REACTION_LABELS, FEISHU_CONFIRMED_REACTION_CANDIDATES: selected, FEISHU_SOCIAL_REACTION_CRITERIA } = await import('../lib/feishu-reaction-catalog.mjs');
  const { createParticipationController } = await import('../connectors/feishu/participation-state.mjs');
  const { createFeishuOutcomeReactionStore } = await import('../connectors/feishu/read-reactions.mjs');
  const { classifyFeishuQuickParticipation } = await import('../connectors/feishu/quick-participation.mjs');
  const { processSourceDeliveryOnce, handleMessage } = await import('../scripts/feishu-connector.mjs');
  const { enqueueSourceDelivery, claimSourceDelivery, completeSourceDelivery, resolveSourceDelivery } = await import('../chat/source-deliveries.mjs');
  const config = { storageDir: home, sourceRouteId: 'bot', defaultGroupParticipation: 'active', groups: {
    work: { responseMode: 'all', participationStatusCard: false },
    off: { participationControls: false, responseMode: 'mention_only' },
    passive: { responseMode: 'mention_only', participationStatusCard: false },
    paused: { participationMode: 'paused', participationStatusCard: false },
  } };
  assert.equal(effectiveFeishuGroup(config, 'work').initialParticipationMode, 'active');
  assert.equal(effectiveFeishuGroup(config, 'passive').responseMode, 'mention_only');
  assert.equal(effectiveFeishuGroup(config, 'passive').participationMode, undefined);
  assert.equal(effectiveFeishuGroup(config, 'off').participationControls, false);
  const base = { chatId: 'work', chatType: 'group', chatMode: 'topic', tenantKey: 'tenant', threadId: 't1',
    rootId: 'r1', messageId: 'm1', messageType: 'text', mentions: [{ openId: 'colleague' }],
    sender: { senderType: 'user', openId: 'human' }, messageText: '@同事 这个问题怎么解决？' };
  const cancelled = [], observed = [], submitted = [], decisions = [];
  const runtime = { config, botIdentity: { openId: 'bot' }, storagePaths: {} };
  runtime.participation = createParticipationController(runtime, { cancelSession: async id => cancelled.push(id) });
  const controller = runtime.participation;
  const main = { ...base, threadId: '', rootId: '', chatMode: 'group', conversationKind: 'main' };
  const helpers = { enrichSummaryWithChatMetadata: async (_r, s) => s,
    observeRemoteLabMessage: async (_r, s) => { observed.push(s); return { sessionId: 'topic', observation: { eventSeq: 1, recent: [] } }; },
    submitRemoteLabRequest: async (_r, s) => { submitted.push(s); return { sessionId: 'topic' }; },
    classifyJevReaction: async () => { decisions.push('jev'); return { emojiType: null }; },
    recordJevDecision: async (_id, _mid, decision) => ({ decision }),
    addProcessingReaction: async () => assert.fail('no automatic processing reactions'),
  };
  const prompt = resolveFeishuGroupSettings(config, base).systemPrompt;
  assert.doesNotMatch(prompt, /Reply to each human message|By default, the human is speaking to you/);
  assert.match(prompt, /participationReason/);
  assert.match(prompt, /human-to-human/);
  assert.equal(resolveFeishuGroupSettings(config, base).jevReactions, true, 'modern work topics share optional Jev feedback');
  await handleMessage(runtime, base, 'test', helpers);
  await Promise.all(runtime.jevReactionJobs.values());
  assert.equal(submitted.length, 1, 'active topic admits a colleague-directed question for main-model judgment');
  await controller.remember(main, 'topic');
  const beforeCancel = cancelled.length;
  await controller.change(main, 'listening', { controlId: 'listen-main' });
  assert.equal(cancelled.length - beforeCancel, 2, 'main and inherited topic scopes both stop even when they share a Session');
  assert.equal((await controller.state(base)).mode, 'listening');
  await handleMessage(runtime, { ...base, messageId: 'quiet' }, 'test', helpers);
  assert.equal(observed.length, 2);
  assert.equal(submitted.length, 1);
  assert.equal(decisions.length, 1, 'listening runs neither main model nor Jev without invitation');
  await handleMessage(runtime, { ...base, messageId: 'invite', mentions: [{ openId: 'bot' }] }, 'test', helpers);
  await Promise.all(runtime.jevReactionJobs.values());
  assert.equal(submitted.at(-1).participationOnce, true);
  assert.equal((await controller.state(base)).mode, 'listening');
  await controller.change(main, 'paused', { controlId: 'pause-main' });
  const paused = await handleMessage(runtime, { ...base, messageId: 'blocked', messageType: 'file' }, 'test', helpers);
  assert.equal(paused.reason, 'participation_paused');
  assert.equal((await controller.state({ ...base, chatId: 'paused' })).mode, 'paused');
  await controller.change(base, 'active', { controlId: 'topic-override' });
  assert.equal((await controller.state(base)).mode, 'active');
  assert.equal((await controller.state({ ...base, threadId: 't2', rootId: 'r2' })).mode, 'paused');
  const restored = createParticipationController(runtime);
  assert.equal((await restored.state(base)).mode, 'active');
  assert.equal((await restored.state(main)).mode, 'paused', 'upgrade/restart never resumes paused scopes');

  const { createRecordStore } = await import('../lib/durable-records.mjs');
  const legacyTopic = { ...base, threadId: 'legacy-paused', rootId: 'legacy-root' };
  const legacyState = await controller.state(legacyTopic);
  await createRecordStore(join(home, 'participation-state')).mutate(legacyState.key,
    () => ({ source: legacyState.source, mode: 'paused', epoch: 9 }));
  await controller.change(main, 'active', { controlId: 'resume-parent' });
  assert.equal((await controller.state(legacyTopic)).mode, 'paused', 'old paused records without a timestamp remain paused after migration');

  normalizeFeishuGroups({ work: { participationMode: 'active', jevReactions: true, reactionCandidates: [] } });
  assert.throws(() => normalizeFeishuGroups({ work: { reactionCandidates: ['INVALID'] } }), /reactionCandidates/);
  assert.throws(() => normalizeFeishuGroups({ work: { reactionCandidates: ['WOW', 'WOW'] } }), /reactionCandidates/);
  assert.equal((await classifyFeishuQuickParticipation('test', { reactionCandidates: [], fetchImpl: () => assert.fail('empty selection calls no model') })).reason, 'empty_selection');
  const result = await classifyFeishuQuickParticipation('test', { key: 'fixture', reactionCandidates: ['THANKS'],
    fetchImpl: async (_url, request) => {
      assert.deepEqual(Object.keys(JSON.parse(request.body).questions.reaction.criteria), ['THANKS', 'none']);
      return { ok: true, json: async () => ({ answers: { reaction: { choice: 'WOW', probabilities: { WOW: .99 } },
        reaction_needed: { choice: 'yes', probabilities: { yes: .99 } } } }) };
    } });
  assert.equal(result.emojiType, null);

  // Exercise actual outbox and connector publication with fake provider only.
  const deliveryRuntime = { config: { storageDir: join(home, 'delivery'), sourceRouteId: 'bot',
    groups: { work: { reactionCandidates: ['THANKS'] } } }, storagePaths: {} };
  const adds = [], removes = [];
  const sourceDelivery = { connector: 'feishu', sourceRouteId: 'bot', target: {
    chatId: 'work', tenantKey: 'tenant', chatType: 'group', conversationKind: 'main', messageId: 'reaction-source' } };
  const deliveryHelpers = {
    requestRemoteLab: async (path, { body = {} } = {}) => ({ response: { ok: true }, json:
      path.endsWith('/claim') ? { claim: await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' }) }
        : path.endsWith('/complete') ? { delivery: await completeSourceDelivery(path.split('/')[3], body.leaseId, body) }
        : { delivery: await resolveSourceDelivery(path.split('/')[3], body) } }),
    addProcessingReaction: async (_r, _s, emoji) => { adds.push(emoji); return { reactionId: 'own-' + adds.length }; },
    removeProcessingReaction: async (_r, messageId, id) => removes.push([messageId, id]),
  };
  const deliver = async (id, reaction, stage = 1) => {
    await enqueueSourceDelivery({ sessionId: 'reaction-session', responseId: id, sourceDelivery, reaction, reactionStage: stage });
    return processSourceDeliveryOnce(deliveryRuntime, deliveryHelpers);
  };
  assert.equal((await deliver('quick', 'THANKS')).state, 'delivered');
  assert.equal((await deliver('outside', 'WOW', 2)).state, 'cancelled');
  assert.equal((await deliver('withdraw', null, 2)).state, 'delivered');
  assert.deepEqual(removes, [['reaction-source', 'own-1']]);
  delete deliveryRuntime.outcomeReactionStore;
  assert.equal((await deliver('late-quick', 'THANKS')).state, 'cancelled');
  assert.deepEqual(adds, ['THANKS'], 'late Jev cannot resurrect a withdrawn reaction after restart');
  const snapshot = await createFeishuOutcomeReactionStore(deliveryRuntime.config.storageDir).snapshot('reaction-source');
  assert.equal(snapshot.status, 'withdrawn');
  assert.equal(selected.length, 14);
  assert.deepEqual(selected, ['THUMBSUP', 'OK', 'SOB', 'TOASTED', 'JOYFUL', 'PROUD', 'EatingFood',
    'Typing', 'OneSecond', 'THANKS', 'Yes', 'No', 'YouAreTheBest', 'OnIt']);
  assert.equal(FEISHU_CONFIRMED_REACTION_LABELS['流泪'], 'SOB');
  assert(!selected.includes('TEARS') && !selected.includes('CRY') && !selected.includes('ROSE'));
  config.groups.work.reactionCandidates = selected;
  const selectedSettings = resolveFeishuGroupSettings(config, base);
  assert.deepEqual(selectedSettings.reactionCandidates, selected);
  for (const id of selected) assert(selectedSettings.systemPrompt.includes(`${id} (`), `main model sees ${id}`);
  const selectedResult = await classifyFeishuQuickParticipation('bad news', { key: 'fixture', reactionCandidates: selected,
    fetchImpl: async (_url, request) => {
      const criteria = JSON.parse(request.body).questions.reaction.criteria;
      assert.deepEqual(Object.keys(criteria).filter(id => id !== 'none').sort(),
        selected.filter(id => Object.hasOwn(FEISHU_SOCIAL_REACTION_CRITERIA, id)).sort());
      for (const status of ['EatingFood', 'Typing', 'OneSecond', 'Yes', 'No', 'OnIt']) assert(!Object.hasOwn(criteria, status));
      assert.match(criteria.SOB, /流泪/);
      return { ok: true, json: async () => ({ answers: { reaction: { choice: 'SOB', probabilities: { SOB: .99 } },
        reaction_needed: { choice: 'yes', probabilities: { yes: .99 } } } }) };
    } });
  assert.equal(selectedResult.emojiType, 'SOB');
  config.groups.work.reactionCandidates = [];
  assert.match(resolveFeishuGroupSettings(config, base).systemPrompt, /Optional reaction candidates: none/);
  console.log('Unified participation: migration boundaries, topic inheritance, explicit scope override, invitation, silence, optional Jev, candidate enforcement and durable withdrawal passed');
} finally { await rm(home, { recursive: true, force: true }); }
