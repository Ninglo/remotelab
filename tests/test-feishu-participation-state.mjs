import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-participation-'));
setIsolatedTestHome(home);
try {
  const { createParticipationController, parseParticipationText, buildParticipationCard } =
    await import('../connectors/feishu/participation-state.mjs');
  const { handleMessage, handleFeishuReactionMute } = await import('../scripts/feishu-connector.mjs');
  const { classifyFeishuQuickParticipation, createFeishuQuickParticipationPilot } = await import('../connectors/feishu/quick-participation.mjs');
  const { normalizeFeishuGroups } = await import('../connectors/feishu/group-settings.mjs');
  assert.equal(parseParticipationText('你先旁听吧'), 'listening');
  assert.equal(parseParticipationText('暂停接收'), 'paused');
  assert.equal(parseParticipationText('恢复主动参与'), 'active');
  assert.equal(parseParticipationText('恢复接收消息'), 'resume_read');
  for (const text of ['他说“先旁听”', '不要暂停接收消息', '如果你先旁听呢？', '旁听机制应该怎么设计', '我觉得你应该旁听']) {
    assert.equal(parseParticipationText(text), null, text);
  }
  assert.throws(() => normalizeFeishuGroups({ work: { participationControls: true } }), /requires ambient/);
  assert.throws(() => normalizeFeishuGroups({ work: { participationStatusCard: 'false' } }), /Invalid participationStatusCard/);

  const calls = { observed: [], submitted: [], stopped: [], cards: [], reactions: [], decisions: [] };
  const runtime = { config: { storageDir: home, sourceRouteId: 'bot', responsePolicy: { group: 'all' },
    groups: { work: { responseMode: 'all' }, misc: { participationMode: 'ambient', jevReactions: true, participationControls: true,
      participationStatusMessageId: 'om_existing' } } }, storagePaths: {}, botIdentity: { openId: 'bot' },
    appClient: { im: { v1: { message: {
      patch: async x => { calls.cards.push(x); return { code: 0 }; },
      create: async () => { throw new Error('must reuse existing main card'); },
    } } } } };
  const options = { resolveSession: async () => 's1', cancelSession: async id => calls.stopped.push(id), authorize: async () => true };
  runtime.participation = createParticipationController(runtime, options);
  const base = { chatId: 'misc', chatType: 'group', chatMode: 'group', tenantKey: 'tenant',
    messageType: 'text', sender: { senderType: 'user', openId: 'human' }, mentions: [] };
  let verdict = { decision: 'reply', workMode: 'short', invited: false, topicChanged: false };
  const helpers = {
    enrichSummaryWithChatMetadata: async (_r, s) => s,
    observeRemoteLabMessage: async (_r, s) => {
      calls.observed.push(s.messageId);
      return { sessionId: 's1', observation: { eventSeq: calls.observed.length, recent: [
        { text: '我们在讨论预算', sender: 'human' }, { text: s.messageText, sender: 'human' } ] } };
    },
    classifyJevReaction: async () => verdict,
    recordJevDecision: async (_s, _m, decision) => { calls.decisions.push(decision); return { decision }; },
    submitRemoteLabRequest: async (_r, s) => { calls.submitted.push(s); return { sessionId: 's1' }; },
    enqueueJevReaction: async () => calls.reactions.push('reaction'),
    addProcessingReaction: async () => calls.reactions.push('processing'),
  };
  const send = (id, text, extra = {}) => handleMessage(runtime, { ...base, messageId: id, messageText: text, ...extra }, 'test', helpers);
  await send('listen', '你先旁听吧');
  assert.equal((await runtime.participation.state(base)).mode, 'listening');
  assert.deepEqual(calls.stopped, ['s1']);
  assert.equal(calls.cards[0].path.message_id, 'om_existing');
  assert.equal(calls.observed.length, 0);

  await send('discussion', '我们继续讨论预算');
  assert.deepEqual(calls.observed, ['discussion'], 'listening information enters the Session');
  assert.equal(calls.submitted.length, 0, 'classifier reply is not an invitation');
  assert.equal(calls.reactions.length, 0);
  verdict = { ...verdict, topicChanged: true };
  await send('new-topic', '换个话题，周末去哪玩');
  const changed = await runtime.participation.state(base);
  assert.equal(changed.mode, 'listening');
  assert.equal(changed.topicHint, true);
  assert.match(JSON.stringify(buildParticipationCard(changed)), /换了话题，要我参与吗/);
  assert.equal(calls.submitted.length, 0);

  verdict = { ...verdict, invited: true };
  await send('other-person', '@_human_2 帮忙看看', { mentions: [{ openId: 'human_2' }] });
  assert.equal(calls.submitted.length, 0, 'cannot take a request addressed to another human');
  await send('invited-once', '你帮忙回答一下');
  assert.equal(calls.submitted.length, 1);
  assert.equal(calls.submitted[0].participationOnce, true);
  assert.equal((await runtime.participation.state(base)).mode, 'listening');

  await send('pause', '暂停接收消息');
  const observed = calls.observed.length;
  const submitted = calls.submitted.length;
  const receipt = await send('private-segment', '@_bot 这段别读', { mentions: [{ openId: 'bot' }], messageType: 'file' });
  assert.equal(receipt.reason, 'participation_paused');
  assert.equal(calls.observed.length, observed, 'paused messages never reach the Session or classifier');
  assert.equal(calls.submitted.length, submitted);
  await send('resume-read', '恢复接收消息');
  assert.equal((await runtime.participation.state(base)).mode, 'listening', 'read restoration preserves prior listening mode');
  const resumed = await runtime.participation.state(base);
  assert.ok(resumed.contextAfterMs > 0, 'resumption fences history before the restore command');
  const log = join(home, 'events.jsonl');
  await writeFile(log, JSON.stringify({ allowed: true, summary: { ...base, messageId: 'hidden', createTime: String(Date.now() - 10000), messageText: 'private paused content' } }) + '\n');
  const quick = createFeishuQuickParticipationPilot(runtime, { react: async () => { throw new Error('no reactions during restore'); } });
  assert.deepEqual(await quick.restore(log, { shouldRemember: async () => false }), [], 'paused history is not restored into classifier context');
  runtime.participation = createParticipationController(runtime, options);
  assert.equal((await runtime.participation.state(base)).mode, 'listening', 'state survives restart');
  await send('resume', '恢复参与');
  await send('ordinary-work', '先旁听', { chatId: 'work' });
  assert.equal(calls.submitted.at(-1).chatId, 'work', 'work groups keep their original admission');
  await handleFeishuReactionMute(runtime, { ...base, sourceKind: 'reaction_mute', messageId: 'hush', eventId: 'reaction-1', feedbackSessionId: 's1' }, helpers);
  assert.equal((await runtime.participation.state(base)).mode, 'listening');
  assert.equal(calls.stopped.at(-1), 's1');
  const card = await runtime.participation.state(base);
  const rejected = await runtime.participation.action({ event: { action: { value: {
    namespace: 'participation', key: card.key, mode: 'active', epoch: card.epoch - 1 }, },
    context: { open_chat_id: 'misc', open_message_id: card.cardMessageId }, operator: { open_id: 'human' } } });
  assert.equal(rejected.toast.type, 'error', 'stale buttons cannot reverse newer state');
  const accepted = await runtime.participation.action({ event: { action: { value: {
    namespace: 'participation', key: card.key, mode: 'active', epoch: card.epoch } },
    context: { open_chat_id: 'misc', open_message_id: card.cardMessageId }, operator: { open_id: 'human' } } });
  assert.equal(accepted.toast.type, 'info');
  await runtime.participation.idle();
  assert.equal((await runtime.participation.state(base)).mode, 'active', 'accepted card action changes the same durable state');

  const cardCallsBeforeHide = calls.cards.length;
  runtime.config.groups.misc.participationStatusCard = false;
  await runtime.participation.change({ ...base, messageId: 'hidden-listen' }, 'listening');
  assert.equal((await runtime.participation.state(base)).mode, 'listening', 'hiding cards preserves mode controls');
  await runtime.participation.change({ ...base, messageId: 'hidden-resume' }, 'active');
  runtime.participation = createParticipationController(runtime, options);
  await runtime.participation.restore();
  assert.equal(calls.cards.length, cardCallsBeforeHide, 'hidden group cards are not recreated on mode change or restart');
  assert.equal((await runtime.participation.state(base)).mode, 'active');
  delete runtime.config.groups.misc.participationStatusCard;
  await runtime.participation.publish({ ...await runtime.participation.state(base), mode: 'paused', cardSuppressed: true });
  assert.equal(calls.cards.length, cardCallsBeforeHide, 'durable suppression also protects a withdrawn card');

  const result = await classifyFeishuQuickParticipation('换个话题，聊一下打印机', {
    key: 'fixture', includeHandoff: false, participationState: { mode: 'listening', topicAnchor: '预算' },
    fetchImpl: async (_url, req) => {
      const body = JSON.parse(req.body);
      assert.equal(body.state.agent_participation.mode, 'listening');
      assert.match(body.questions.topicChange.instructions, /never restores participation/);
      return { ok: true, json: async () => ({ answers: {
        participation: { choice: 'reply', probabilities: { reply: 0.99, silent: 0.01 } },
        participationControl: { choice: 'none', probabilities: { none: 0.99 } },
        invitation: { choice: 'no', probabilities: { no: 0.99 } },
        topicChange: { choice: 'yes', probabilities: { yes: 0.98 } },
      } }) };
    },
  });
  assert.equal(result.controlMode, null);
  assert.equal(result.invited, false);
  assert.equal(result.topicChanged, true);
  console.log('Feishu participation: observation, pause/resume, invitations, topic hints, scope and persistence passed');
} finally { await rm(home, { recursive: true, force: true }); }
