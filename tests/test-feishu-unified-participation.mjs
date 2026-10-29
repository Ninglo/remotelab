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
  const { processSourceDeliveryOnce, handleMessage, onboardFeishuGroup } = await import('../scripts/feishu-connector.mjs');
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
  const base = { chatId: 'work', chatType: 'group', chatMode: 'group', tenantKey: 'tenant', threadId: 't1',
    rootId: 'r1', messageId: 'm1', messageType: 'text', mentions: [{ openId: 'colleague' }],
    sender: { senderType: 'user', openId: 'human' }, messageText: '@同事 这个问题怎么解决？' };
  const cancelled = [], observed = [], submitted = [], decisions = [];
  const runtime = { config, botIdentity: { openId: 'bot' }, storagePaths: {} };
  runtime.participation = createParticipationController(runtime, { cancelSession: async id => cancelled.push(id) });
  const controller = runtime.participation;
  const main = { ...base, threadId: '', rootId: '', chatMode: 'group', conversationKind: 'main' };
  const helpers = { enrichSummaryWithChatMetadata: async (_r, s) => s,
    loadAcceptedObservation: async () => ({ accepted: true, recent: [] }),
    observeRemoteLabMessage: async (_r, s) => { observed.push(s); return { sessionId: 'topic', observation: { eventSeq: 1, recent: [] } }; },
    submitRemoteLabRequest: async (_r, s) => { submitted.push(s); return { sessionId: 'topic' }; },
    classifyJevReaction: async () => { decisions.push('jev'); return { emojiType: null }; },
    recordJevDecision: async (_id, _mid, decision) => ({ decision }),
    addProcessingReaction: async () => assert.fail('no automatic processing reactions'),
  };
  const prompt = resolveFeishuGroupSettings(config, base).systemPrompt;
  assert.deepEqual(resolveFeishuGroupSettings({ ...config, groupReactionCandidates: selected }, base).reactionCandidates, selected);
  assert.deepEqual(resolveFeishuGroupSettings({ ...config, groupReactionCandidates: [] }, { ...base, chatId: 'new-group' }).reactionCandidates, []);
  assert.deepEqual(resolveFeishuGroupSettings({ ...config, groupReactionCandidates: selected, groups: { work: { reactionCandidates: ['THANKS'] } } }, base).reactionCandidates, ['THANKS']);
  assert.doesNotMatch(prompt, /Reply to each human message|By default, the human is speaking to you/);
  assert.match(prompt, /participationReason/);
  assert.match(prompt, /join human discussion when useful/);
  assert.doesNotMatch(prompt, /work kickoff/);
  const discussionPrompt = resolveFeishuGroupSettings({ ...config, projectLinks: [{ discussionChatId: 'work', workChatId: 'target' }] }, base).systemPrompt;
  assert.match(discussionPrompt, /work kickoff --file/);
  assert.match(discussionPrompt, /complete title and options unchanged/);
  assert.match(discussionPrompt, /Listening and paused/);
  assert.doesNotMatch(discussionPrompt, /substantive discussion belongs in a Thread/);
  assert.equal(resolveFeishuGroupSettings(config, base).jevReactions, true, 'modern work topics share optional Jev feedback');
  const disabledConfig = { ...config, storageDir: join(home, 'jev-disabled'), jevReactions: false,
    groups: { ...config.groups, work: { ...config.groups.work, jevReactions: true, participationMode: 'active' } } };
  const disabledRuntime = { config: disabledConfig, botIdentity: { openId: 'bot' }, storagePaths: {} };
  disabledRuntime.participation = createParticipationController(disabledRuntime);
  const disabledSubmissions = [];
  for (const summary of [base, main, { ...main, chatId: 'new-group' }]) {
    const settings = resolveFeishuGroupSettings(disabledConfig, summary);
    assert.equal(settings.jevReactions, undefined, 'connector opt-out covers explicit group opt-in, threads and new groups');
    assert.doesNotMatch(settings.systemPrompt, /Jev supplies/);
    assert.deepEqual(settings.reactionCandidates, resolveFeishuGroupSettings(config, summary).reactionCandidates,
      'main-model reaction choices remain available');
    await handleMessage(disabledRuntime, summary, 'test', { ...helpers,
      submitRemoteLabRequest: async (_runtime, input) => { disabledSubmissions.push(input); return { sessionId: 'topic' }; },
      classifyJevReaction: async () => assert.fail('disabled connector must not call Jev'),
    });
  }
  assert.equal(disabledSubmissions.length, 3, 'disabling feedback preserves main-model admission');
  assert.equal(disabledRuntime.jevReactionJobs?.size || 0, 0);
  await handleMessage(runtime, base, 'test', helpers);
  await Promise.all(runtime.jevReactionJobs.values());
  assert.equal(submitted.length, 1, 'active topic admits a colleague-directed question for main-model judgment');
  await controller.remember(main, 'topic');
  const beforeCancel = cancelled.length;
  await controller.change(main, 'listening', { controlId: 'listen-main' });
  assert.equal(cancelled.length - beforeCancel, 2, 'main and inherited topic scopes both stop even when they share a Session');
  assert.equal((await controller.state(base)).mode, 'listening');
  await handleMessage(runtime, { ...base, messageId: 'quiet' }, 'test', helpers);
  assert.equal(observed.length, 1, 'only listening inputs use observation admission');
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
  // Native topic groups bypass ordinary-group participation state. Human
  // follow-ups use the submission/steer path unless explicitly muted.
  const native = { ...base, chatId: 'native', chatMode: 'topic', threadId: 'native-topic' };
  const nativeConfig = { ...config, storageDir: join(home, 'native'), groups: {
    native: { participationMode: 'paused', responseMode: 'mention_only' },
  } };
  const nativeRuntime = { config: nativeConfig, botIdentity: runtime.botIdentity, storagePaths: {} };
  const nativePrompt = resolveFeishuGroupSettings(nativeConfig, native).systemPrompt;
  assert.match(nativePrompt, /every human message is addressed to the Agent and needs a reply/);
  assert.doesNotMatch(nativePrompt, /otherwise stay silent|Jev supplies|work kickoff/);
  assert.equal(resolveFeishuGroupSettings(nativeConfig, native).jevReactions, undefined);
  const { participationEnabled } = await import('../connectors/feishu/participation-state.mjs');
  assert.equal(participationEnabled(nativeRuntime, native), false);
  assert.equal(participationEnabled(runtime, { ...base, chatMode: 'thread' }), true,
    'legacy reply targets with chatMode=thread are not native topic groups');
  const { setFeishuConversationMuted } = await import('../connectors/feishu/conversation-settings.mjs');
  const nativeSubmitted = [];
  for (const [id, text] of [['first', 'hello'], ['steer', '补充一下'], ['control-text', '先旁听']]) {
    await handleMessage(nativeRuntime, { ...native, messageId: id, messageText: text }, 'test', {
      ...helpers,
      observeRemoteLabMessage: async () => assert.fail('native topics do not use ambient observation'),
      submitRemoteLabRequest: async (_r, summary) => { nativeSubmitted.push(summary); return { sessionId: 'native-session' }; },
    });
  }
  assert.equal(nativeSubmitted.length, 3);
  assert.equal(nativeRuntime.participation, undefined, 'native conversation never opens a three-mode controller');
  assert.equal(nativeSubmitted[0].participationEpoch, undefined);
  await setFeishuConversationMuted(nativeRuntime, native, true);
  const nativeMuted = await handleMessage(nativeRuntime, { ...native, messageId: 'explicitly-muted' }, 'test', {
    ...helpers,
    observeRemoteLabMessage: async () => assert.fail('muted native topics do not use observation'),
    submitRemoteLabRequest: async () => assert.fail('explicit mute prevents native topic submission'),
  });
  assert.equal(nativeMuted.ignored, true);
  assert.equal(nativeRuntime.participation, undefined, 'mute does not enable ordinary-group controls');
  await setFeishuConversationMuted(nativeRuntime, native, false);

  // Restart must resolve old records that lack chat metadata, skip obsolete
  // native-topic controls, and never create a missing ordinary-group card.
  const restoreRuntime = { config: { ...config, storageDir: join(home, 'restore'), groups: {} },
    storagePaths: {}, appClient: { im: { v1: { message: {
      create: async () => assert.fail('restore must not create cards'),
      reply: async () => assert.fail('restore must not create topic cards'),
      patch: async () => assert.fail('obsolete native topic cards must not be patched'),
    } } } } };
  const oldController = createParticipationController(restoreRuntime);
  const oldRecord = await oldController.remember({ ...base, chatId: 'native-old', chatMode: '' }, 'native-old-session');
  const restoreStore = createRecordStore(join(restoreRuntime.config.storageDir, 'participation-state'));
  await restoreStore.mutate(oldRecord.key, current => ({ ...current, source: {
    chatId: current.source.chatId, topicId: current.source.topicId,
    tenantKey: current.source.tenantKey, sourceRouteId: current.source.sourceRouteId,
  }, mode: 'paused', stopPending: true, cardMessageId: 'om_obsolete' }));
  const ordinaryRecord = await oldController.remember({ ...base, chatId: 'ordinary', threadId: '', rootId: '' }, 'ordinary-session');
  await restoreStore.mutate(ordinaryRecord.key, current => ({ ...current, mode: 'paused', stopPending: true }));
  const recoveredStops = [];
  const recovery = createParticipationController(restoreRuntime, {
    resolveSource: async source => ({ ...source, chatMode: source.chatId === 'native-old' ? 'topic' : 'group' }),
    cancelSession: async id => recoveredStops.push(id),
    cleanup: async record => assert.equal(record.source.chatId, 'ordinary'),
    authorize: async () => true,
  });
  await recovery.restore();
  assert.deepEqual(recoveredStops, ['ordinary-session'], 'only ordinary-group pending stops resume');
  await recovery.publish(await recovery.record(oldRecord.key));
  const rejectedNative = await recovery.action({ event: {
    action: { value: { namespace: 'participation', key: oldRecord.key, mode: 'active', epoch: 0 } },
    context: { open_chat_id: 'native-old', open_message_id: 'om_obsolete' }, operator: { open_id: 'human' },
  } });
  assert.equal(rejectedNative.toast.type, 'error');
  // Provider metadata also governs project onboarding and queued output, whose
  // stored targets may incorrectly claim to be an ordinary group.
  nativeRuntime.appClient = { im: { v1: { chat: { get: async () => ({
    code: 0, data: { chat_mode: 'topic', chat_type: 'private', name: 'native group' },
  }) } } } };
  const synthetic = { ...native, chatMode: 'group' };
  assert.equal((await onboardFeishuGroup(nativeRuntime, synthetic, {
    projectCard: true, requestRemoteLab: async () => assert.fail('native group must not create a group card Session'),
  })).reason, 'native_topic_group');
  let nativeDelivered = 0;
  await processSourceDeliveryOnce(nativeRuntime, {
    requestRemoteLab: async path => path === '/api/source-deliveries/claim'
      ? { response: { ok: true }, json: { claim: { leaseId: 'native-lease', delivery: {
        id: 'native-result', target: synthetic, kind: 'content', text: 'answer',
      } } } }
      : { response: { ok: true }, json: { delivery: { state: 'delivered' } } },
    sendFeishuText: async () => { nativeDelivered++; return { message_id: 'native-answer', thread_id: native.threadId }; },
  });
  assert.equal(nativeDelivered, 1, 'old paused group settings cannot suppress native-topic output');


  // Actual Chat API chat_type=private/public is group visibility. Exercise the
  // real metadata -> outbox -> SDK request path, not a mocked send helper.
  for (const visibility of ['private', 'public']) for (const thread of [false, true]) {
    const calls = [];
    const quoteRuntime = { config: { storageDir: join(home, `quote-${visibility}-${thread}`), sourceRouteId: 'bot' }, storagePaths: {},
      appClient: { im: { v1: {
        chat: { get: async () => ({ code: 0, data: { chat_mode: 'group', chat_type: visibility, group_message_type: 'chat' } }) },
        message: {
          reply: async body => { calls.push(body); return { code: 0, data: { message_id: 'quoted-result' } }; },
          create: async () => assert.fail('a group answer must quote the source message'),
        },
      } } } };
    const target = { ...sourceDelivery.target, ...(thread ? {
      conversationKind: 'thread', replyInThread: true, rootId: sourceDelivery.target.messageId,
    } : {}) };
    await enqueueSourceDelivery({ sessionId: 'quote-session', responseId: `quote-${visibility}-${thread}`,
      sourceDelivery: { ...sourceDelivery, target }, text: '能看到你的消息。' });
    assert.equal((await processSourceDeliveryOnce(quoteRuntime, { requestRemoteLab: deliveryHelpers.requestRemoteLab })).state, 'delivered');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path.message_id, sourceDelivery.target.messageId);
    assert.equal(calls[0].data.reply_in_thread, thread);
    assert.doesNotMatch(calls[0].data.content, /开始处理|最终答复|最终输出/);
  }

  // Processing feedback uses real durable admission/settlement and the outbox,
  // with only the provider API faked. It is independent of social candidates.
  const { requests } = await import('../chat/requests.mjs');
  const processingAdds = [], processingRemoves = [];
  const processingRuntime = { config: { storageDir: join(home, 'processing'), sourceRouteId: 'processing', defaultGroupParticipation: 'active',
    groups: { work: { reactionCandidates: ['THANKS'], participationStatusCard: false } } }, storagePaths: {},
    appClient: { im: { v1: { messageReaction: {
      create: async body => { processingAdds.push([body.path.message_id, body.data.reaction_type.emoji_type]);
        return { code: 0, data: { reaction_id: 'processing-' + processingAdds.length } }; },
      delete: async body => { processingRemoves.push(body.path.message_id); return { code: 0 }; },
    } } } } };
  processingRuntime.participation = createParticipationController(processingRuntime, { cancelSession: async () => {} });
  const processingHelpers = { enrichSummaryWithChatMetadata: async (_runtime, summary) => summary,
    requestRemoteLab: async (path, { body = {} } = {}) => ({ response: { ok: true }, json:
      path.endsWith('/claim') ? { claim: await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'processing' }) }
        : path.endsWith('/complete') ? { delivery: await completeSourceDelivery(path.split('/')[3], body.leaseId, body) }
        : { delivery: await resolveSourceDelivery(path.split('/')[3], body) } }) };
  const drainProcessing = () => processSourceDeliveryOnce(processingRuntime, processingHelpers);
  for (const state of ['completed', 'failed', 'cancelled']) {
    const messageId = 'processing-' + state;
    const processingPlan = { ...sourceDelivery, sourceRouteId: 'processing',
      target: { ...sourceDelivery.target, messageId } };
    const input = { sessionId: 'processing-session', requestId: messageId, text: 'input', options: {
      feishuConnectorAuthenticated: true, sourceContext: { feishuProcessingReaction: true }, sourceDelivery: processingPlan } };
    const { record } = await requests.accept(input);
    assert.equal((await drainProcessing()).state, 'delivered');
    assert.deepEqual(processingAdds.at(-1), [messageId, 'THINKING']);
    const before = processingAdds.length;
    assert.equal((await requests.accept(input)).duplicate, true);
    assert.equal(processingAdds.length, before, 'redelivery never starts a second reaction');
    delete processingRuntime.readReactionStore; // Restart retains the pending cleanup.
    await enqueueSourceDelivery({ sessionId: 'social-session', responseId: 'social-' + state,
      sourceDelivery: processingPlan, reaction: 'THANKS' });
    await drainProcessing();
    assert.ok(!processingRemoves.includes(messageId), 'Jev must not clear an ongoing processing indicator');
    if (state === 'cancelled') {
      await processingRuntime.participation.change(processingPlan.target, 'paused');
    }
    await requests.settle(record.key, { state, payload: { text: '', attachments: [] } });
    assert.equal((await drainProcessing()).state, 'delivered');
    assert.equal(processingRemoves.filter(id => id === messageId).length, 1,
      'silence, failure and cancellation all clear Thinking, keeping the social reaction');
    await requests.settle(record.key, { state, payload: { text: '' } });
    assert.equal((await requests.get(record.key)).deliveries.filter(part => part.processingState === 'finished').length, 1);
  }
  const forwarded = await requests.accept({ sessionId: 'worker', requestId: 'forwarded', text: 'handoff', options: {
    feishuConnectorAuthenticated: true, routingSource: { sessionId: 'main' },
    sourceContext: { feishuProcessingReaction: true }, sourceDelivery } });
  assert.equal(forwarded.record.deliveries.length, 0, 'handoff does not create another lifecycle on the original message');

  assert.throws(() => normalizeFeishuGroups({ work: { processingReactions: 'false' } }), /processingReactions/);
  const quietGroups = normalizeFeishuGroups({ quiet: { processingReactions: false } });
  assert.equal(resolveFeishuGroupSettings({ groups: quietGroups }, { ...main, chatId: 'quiet' }).processingReactions, false);
  assert.equal(resolveFeishuGroupSettings({ groups: quietGroups }, { ...base, chatId: 'quiet' }).processingReactions, false);
  assert.equal(resolveFeishuGroupSettings({ groups: quietGroups }, main).processingReactions, true,
    'other groups retain their existing processing policy');

  const quietPlan = { ...sourceDelivery, sourceRouteId: 'processing',
    target: { ...sourceDelivery.target, chatId: 'quiet', messageId: 'quiet-new' } };
  processingRuntime.config.groups.quiet = { processingReactions: false, participationStatusCard: false };
  const quiet = await requests.accept({ sessionId: 'quiet-session', requestId: 'quiet-new', text: 'input', options: {
    feishuConnectorAuthenticated: true, sourceContext: { feishuProcessingReaction: false }, sourceDelivery: quietPlan } });
  assert.equal(quiet.record.deliveries.length, 0, 'disabled intake queues no processing start');
  await requests.settle(quiet.record.key, { state: 'completed', payload: { text: '' } });
  assert.equal((await requests.get(quiet.record.key)).deliveries.length, 0, 'no start means no cleanup churn');

  const beforeQuiet = processingAdds.length;
  const stalePlan = { ...quietPlan, target: { ...quietPlan.target, messageId: 'quiet-stale' } };
  const stale = await requests.accept({ sessionId: 'quiet-session', requestId: 'quiet-stale', text: 'input', options: {
    feishuConnectorAuthenticated: true, sourceContext: { feishuProcessingReaction: true }, sourceDelivery: stalePlan } });
  assert.equal((await drainProcessing()).state, 'cancelled', 'an old queued start respects the current opt-out');
  assert.equal(processingAdds.length, beforeQuiet);
  await requests.settle(stale.record.key, { state: 'completed', payload: { text: '' } });
  assert.equal((await drainProcessing()).state, 'delivered', 'legacy cleanup remains valid');

  processingRuntime.config.groups.quiet.processingReactions = true;
  const activePlan = { ...quietPlan, target: { ...quietPlan.target, messageId: 'quiet-already-active' } };
  const active = await requests.accept({ sessionId: 'quiet-session', requestId: 'quiet-active', text: 'input', options: {
    feishuConnectorAuthenticated: true, sourceContext: { feishuProcessingReaction: true }, sourceDelivery: activePlan } });
  await drainProcessing();
  processingRuntime.config.groups.quiet.processingReactions = false;
  await enqueueSourceDelivery({ sessionId: 'social-session', responseId: 'quiet-social',
    sourceDelivery: activePlan, reaction: 'THANKS' });
  assert.equal((await drainProcessing()).state, 'delivered', 'intentional social feedback is still available');
  await requests.settle(active.record.key, { state: 'completed', payload: { text: '' } });
  assert.equal((await drainProcessing()).state, 'delivered');
  assert.equal(processingRemoves.filter(id => id === 'quiet-already-active').length, 1,
    'disabling the setting does not strand a reaction already on the message');

  console.log('Unified participation: migration boundaries, topic inheritance, explicit scope override, invitation, silence, optional Jev, candidate enforcement and durable withdrawal passed');
} finally { await rm(home, { recursive: true, force: true }); }
