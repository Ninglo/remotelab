import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-participation-recovery-'));
setIsolatedTestHome(home);
let submissions = 0;
const server = createServer((req, res) => {
  assert.match(req.url, /^\/api\/sessions\/s\/messages$/);
  req.resume();
  submissions += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ run: { id: 'fixture-run' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const { handleMessage, addProcessingReaction, processSourceDeliveryOnce, submitRemoteLabRequest } = await import('../scripts/feishu-connector.mjs');
  const { createFeishuReadReactionStore } = await import('../connectors/feishu/read-reactions.mjs');
  for (const topic of ['', 'work-topic']) {
    const effects = { runs: [], observed: [], removed: [], resolved: [] };
    const runtime = { authCookie: 'fixture', config: { storageDir: join(home, topic || 'main'), sourceRouteId: 'bot',
      chatBaseUrl: `http://127.0.0.1:${server.address().port}`,
      groups: { misc: { participationMode: 'ambient', participationControls: true,
        participationStatusCard: false, quickReactions: true, groupFeed: true, jevReactions: true } } },
      storagePaths: {}, botIdentity: { openId: 'bot' },
      appClient: { im: { v1: { messageReaction: {
        create: async x => ({ code: 0, data: { reaction_id: `reaction-${x.path.message_id}` } }),
        delete: async x => { effects.removed.push(x.path.message_id); return { code: 0 }; },
      } } } },
    };
    const base = { chatId: 'misc', chatType: 'group', chatMode: 'group', tenantKey: 'tenant',
      messageType: 'text', sender: { senderType: 'user', openId: 'human' }, mentions: [],
      ...(topic ? { threadId: topic, rootId: 'root' } : {}),
    };
    const request = async (path, options = {}) => {
      if (path === '/api/session-conversations/resolve') return { response: { ok: true }, json: { sessionId: 's' } };
      if (path === '/api/sessions/s') return { response: { ok: true }, json: { session: { queuedMessages: [] } } };
      if (path.endsWith('/resolve')) effects.resolved.push(options.body);
      return { response: { ok: true }, json: { delivery: { state: 'cancelled' } } };
    };
    const helpers = {
      requestRemoteLab: request,
      enrichSummaryWithChatMetadata: async (_r, s) => s,
      observeRemoteLabMessage: async (_r, s) => {
        effects.observed.push(s.messageId);
        return { sessionId: 's', observation: { eventSeq: 1, recent: [{ text: s.messageText }] } };
      },
      classifyJevReaction: async () => ({ decision: 'reply', workMode: 'short', invited: true }),
      recordJevDecision: async (_s, _m, d) => ({ decision: d }),
      submitRemoteLabRequest: async (_r, s) => { effects.runs.push(s); return { sessionId: 's' }; },
      enqueueJevReaction: async () => ({ id: 'reaction' }),
    };
    const send = (id, text, extra = {}, overrides = {}) => handleMessage(runtime,
      { ...base, messageId: id, messageText: text, ...extra }, 'test', { ...helpers, ...overrides });
    await send('mute', '/mute');
    assert.equal((await runtime.participation.state(base)).mode, 'listening');
    await send('discussion', '我们继续聊 Mini', {}, {
      classifyJevReaction: async () => ({ decision: 'reply', workMode: 'short', invited: false }),
    });
    assert.deepEqual(effects.observed, ['discussion']);
    assert.equal(effects.runs.length, 0, `${topic || 'main'} ordinary listening must not run`);
    await send('invitation', '@_bot 帮忙回答', { mentions: [{ openId: 'bot' }] });
    assert.equal(effects.runs.at(-1).participationOnce, true);
    assert.equal((await runtime.participation.state(base)).mode, 'listening');
    await send('complex-invitation', '@_bot 帮忙调查', { mentions: [{ openId: 'bot' }] }, {
      classifyJevReaction: async () => ({ decision: 'reply', workMode: 'complex', invited: true }),
    });
    if (topic) assert.equal(effects.runs.at(-1).startThread, undefined,
      'an invitation in an existing topic must stay in that topic');
    const invited = effects.runs.at(-1);
    const prepared = { sessionId: 's', receipt: {}, payload: { text: 'fixture',
      sourceDelivery: { target: { participationEpoch: invited.participationEpoch } } } };
    const before = submissions;
    assert.equal((await submitRemoteLabRequest(runtime, invited, { prepared })).runId, 'fixture-run');
    assert.equal(submissions, before + 1, 'a listening invitation may submit, including a new mainline work topic');

    const snapshot = { ...await runtime.participation.state(base), receivedAt: Date.now() - 10 };
    await send('resume', '/unmute');
    const count = effects.runs.length;
    const old = await send('old-discussion', '那也行', {}, { participationSnapshot: snapshot });
    assert.equal(old.reason, 'participation_before_resume');
    assert.equal(effects.runs.length, count, 'resume cannot turn queued listening content into tasks');
    assert.equal((await submitRemoteLabRequest(runtime, invited, { prepared })).ignored, true);
    assert.equal(submissions, before + 1, 'a prepared request from before resume cannot enter the model queue');

    const activeSnapshot = { ...await runtime.participation.state(base), receivedAt: Date.now() };
    await send('mute-queued', '/mute');
    await send('queued-at', '@_bot 之前的邀请', { mentions: [{ openId: 'bot' }] }, {
      participationSnapshot: activeSnapshot,
    });
    assert.equal(effects.runs.length, count, 'arrival epoch survives intake; mute cancels queued older invitations');
    await send('resume-queued', '/unmute');
    const ongoingEpoch = (await runtime.participation.state(base)).epoch;
    await send('already-active', '/unmute');
    assert.equal((await runtime.participation.state(base)).epoch, ongoingEpoch,
      'reasserting active reception must not invalidate an ongoing reply');
    assert.equal((await submitRemoteLabRequest(runtime, { ...base, messageId: 'ongoing',
      participationEpoch: String(ongoingEpoch) }, { prepared: { ...prepared, payload: {
        sourceDelivery: { target: { participationEpoch: String(ongoingEpoch) } },
      } } })).runId, 'fixture-run');

    let resumeClassifier;
    let classificationEntered;
    const entered = new Promise(resolve => { classificationEntered = resolve; });
    const classificationGate = new Promise(resolve => { resumeClassifier = resolve; });
    if (topic) await send('listen-race', '/mute');
    const slow = send('slow', '帮忙看看', {}, { classifyJevReaction: async () => {
      classificationEntered(); await classificationGate;
      return { decision: 'reply', workMode: 'short', invited: true };
    } });
    await entered;
    await runtime.participation.change({ ...base, messageId: 'pause-race' }, 'paused');
    await runtime.participation.change({ ...base, messageId: 'resume-race' }, 'active');
    resumeClassifier(); await slow;
    assert.equal(effects.runs.length, count, 'a late classification cannot survive pause and resume');

    const current = await runtime.participation.state(base);
    await addProcessingReaction(runtime, { ...base, messageId: 'cancel-me', participationEpoch: String(current.epoch) });
    const reactionStore = runtime.readReactionStore;
    await reactionStore.add('other-conversation', async () => ({ reactionId: 'other' }), {
      chatId: 'misc', tenantKey: 'tenant', topicId: topic ? '' : 'other-topic',
    });
    await send('pause', '暂停接收消息');
    assert.ok(effects.removed.includes('cancel-me'), 'direct topic THINKING is retained and removed on pause');
    assert.ok(!effects.removed.includes('other-conversation'), 'pause cannot clear another conversation');
    assert.equal((await send('paused-at', '@_bot 旧请求', { mentions: [{ openId: 'bot' }] })).reason,
      'participation_paused');
    await reactionStore.add('suppressed', async () => ({ reactionId: 'temporary' }));
    const suppressed = await processSourceDeliveryOnce(runtime, {
      requestRemoteLab: async (path, options) => path === '/api/source-deliveries/claim'
        ? { response: { ok: true }, json: { claim: { leaseId: 'unsent-lease', delivery: {
          id: 'srcd_000000000000000000000001_0', target: { ...base, messageId: 'suppressed' }, kind: 'content', text: 'old reply',
        } } } } : request(path, options),
      sendFeishuText: async () => { throw new Error('paused delivery must never call the provider'); },
    });
    assert.equal(suppressed.state, 'cancelled');
    assert.equal(effects.resolved.at(-1).leaseId, 'unsent-lease');
    assert.ok(effects.removed.includes('suppressed'));
    assert.equal((await reactionStore.active()).length, 1);
    assert.equal((await createFeishuReadReactionStore(runtime.config.storageDir).active()).length, 1,
      'restart preserves cleanup receipts and the unrelated conversation');
    if (!topic) {
      await send('routing-resume', '/unmute');
      const originStatus = await runtime.participation.state(base);
      const routed = { ...base, threadId: 'separate-work', rootId: 'separate-root',
        messageId: 'separate-root', conversationKind: 'thread', groupMessageType: 'thread', chatMode: 'group', sourceKind: 'group_routing_work',
        participationEpoch: String(originStatus.epoch), participationScopeTopicId: 'main',
        participationScopeMessageId: 'source-request' };
      let sent = 0;
      const deliver = async id => processSourceDeliveryOnce(runtime, {
        requestRemoteLab: async (path, options) => path === '/api/source-deliveries/claim'
          ? { response: { ok: true }, json: { claim: { leaseId: 'lease-' + id, delivery: {
            id, target: routed, kind: 'content', text: 'topic result',
          } } } } : request(path, options),
        sendFeishuText: async () => { sent++; return { message_id: 'sent-' + sent, thread_id: 'separate-work' }; },
      });
      assert.notEqual(originStatus.epoch, (await runtime.participation.state(routed)).epoch);
      await deliver('routing-valid');
      assert.equal(sent, 1, 'a source mainline epoch must not be compared to a new topic epoch');
      await runtime.participation.change(routed, 'listening');
      await deliver('routing-destination-muted');
      assert.equal(sent, 1, 'destination participation remains authoritative');
      await runtime.participation.change(routed, 'active');
      await send('routing-source-pause', '/mute');
      await send('routing-source-resume', '/unmute');
      await deliver('routing-source-stale');
      assert.equal(sent, 1, 'source epoch still fences pending routing after pause and resume');
    }
    if (topic) {
      await send('resume-metadata', '/unmute');
      const raw = { threadId: '', rootId: '' };
      const rawState = await runtime.participation.state({ ...base, ...raw });
      const beforeMetadata = effects.runs.length;
      await send('metadata-invitation', '帮忙检查', raw, {
        enrichSummaryWithChatMetadata: async (_r, s) => ({ ...s, ...base }),
        addProcessingReaction: async () => ({ reactionId: 'metadata-read' }),
        participationSnapshot: { ...rawState, mode: 'paused', epoch: 99, receivedAt: Date.now() },
      });
      assert.equal(effects.runs.length, beforeMetadata + 1,
        'metadata fallback cannot apply a mainline snapshot to an independent topic');
    }
  }
  console.log('Feishu mute recovery: mainline/topic invitation, queued and in-flight fencing, scoped THINKING cleanup and unsent delivery cancellation pass');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
