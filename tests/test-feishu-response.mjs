import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-response-'));
setIsolatedTestHome(home);
try {
  const { requests } = await import('../chat/requests.mjs');
  const { publishFeishuResponse, recoverPilotReplies, pilotInputResult } = await import('../chat/feishu-response.mjs');
  const { publishNativeFeishuResponses } = await import('../chat/feishu-response-publication.mjs');
  const { buildReplyDeliveries } = await import('../lib/reply-deliveries.mjs');
  const { readFeishuResponseDecision } = await import('../lib/feishu-response-decision.mjs');
  const { resolveAmbientFeishuReplyPlan } = await import('../chat/ambient-feishu-reply.mjs');
  const plan = { connector: 'feishu', sourceRouteId: 'bot', target: {
    chatId: 'group', tenantKey: 'tenant', chatType: 'group', conversationKind: 'main', messageId: 'root',
  } };
  const options = {
    sourceContext: { feishuResponseProtocolVersion: 1, connector: 'feishu', feishuParticipation: 'ambient', feishuReplyPlacementVersion: 1 } };
  const accept = async (id, root, target = plan.target) => {
    const { record } = await requests.accept({ sessionId: 'session', requestId: id, text: id,
      options, deliveryPlan: { ...plan, target: { ...target, messageId: id } } });
    return root ? requests.mutate(record.key, value => ({ ...value,
      nativeDispatchRunId: root.runId, nativeReceipt: { accepted: true } })) : record;
  };
  const envelope = (fields, text = '') => `<private>feishu-response:${JSON.stringify(fields)}</private>${text}`;
  const final = (id, content) => ({ type: 'message', role: 'assistant', phase: 'final', providerMessageId: id, seq: 10, content });
  const publish = (root, events) => publishNativeFeishuResponses(root, events,
    { id: root.runId, state: 'completed' }, { session: { id: 'session', sourceId: 'feishu' } });

  // Every output entrance preserves the same chosen reaction, independent of
  // legacy directive order. No provider API or real group is used.
  for (const text of [envelope({ replyMode: 'thread', reaction: 'Get' }, '结果'),
    '<private><feishu-reaction emoji="Get"/></private><private>feishu-reply:thread</private>结果',
    '<private>feishu-reply:thread</private><private><feishu-reaction emoji="Get"/></private>结果']) {
    const parts = buildReplyDeliveries(plan, { text });
    assert.deepEqual(parts.map(p => p.kind), ['reaction', 'content']);
    assert.equal(parts[0].emojiType, 'Get'); assert.equal(parts[1].text, '结果');
    assert.equal(resolveAmbientFeishuReplyPlan({ options }, plan, [final('f', text)]).target.conversationKind, 'thread');
  }
  assert(readFeishuResponseDecision(envelope({ requestIds: ['a', 'a'] })).error);
  assert(readFeishuResponseDecision(envelope({ reaction: 'unrecognized' })).error);

  // Reproduce the real supplemental-link case: the final itself covers both
  // inputs, so there is no second bookkeeping tool and no false missing reply.
  const root = await accept('review-categories');
  const link = await accept('paper-link', root);
  const answer = final('answer', envelope({ requestIds: [root.requestId, link.requestId],
    replyMode: 'thread', reaction: 'THUMBSUP' }, '读了链接，已结合前面的分类回答。'));
  await publish(root, [answer]); await publish(root, [answer]);
  const saved = await requests.get(root.key);
  assert.deepEqual(saved.deliveries.map(d => d.kind), ['reaction', 'content']);
  assert.equal(saved.deliveries[1].target.conversationKind, 'thread');
  assert.equal(saved.deliveries[0].target.messageId, root.requestId);
  assert.equal((await requests.get(link.key)).deliveries.length, 0);
  assert.equal(pilotInputResult(await requests.get(link.key), { id: root.runId, state: 'completed' }).state, 'completed');
  assert.equal(saved.mainlineReply.contract.payload.reactionStage, 2);

  // A later independent supplement still publishes after the root was answered;
  // text retains the selected topic, the reaction belongs to the new message.
  const later = await accept('later-question', root);
  await publish(root, [answer, final('later-answer', envelope({ requestIds: [later.requestId],
    replyMode: 'inline', reaction: 'Get' }, '这是后一个问题的回答。'))]);
  const laterSaved = await requests.get(later.key);
  assert.equal(laterSaved.deliveries[0].target.messageId, later.requestId);
  assert.equal(laterSaved.deliveries[1].target.rootId, root.requestId);
  assert.equal(laterSaved.deliveries[1].target.conversationKind, 'thread');

  // The immediate tool is a facade over the same decision and receipt contract.
  const tool = await accept('tool-root'); const toolExtra = await accept('tool-extra', tool);
  await publishFeishuResponse(tool, { text: '<private><feishu-reaction emoji="Get"/></private>两个补充的结果。',
    requestIds: [tool.requestId, toolExtra.requestId], replyMode: 'inline' });
  assert.deepEqual((await requests.get(tool.key)).deliveries.map(d => d.kind), ['reaction', 'content']);
  assert.equal(pilotInputResult(await requests.get(toolExtra.key), { id: tool.runId, state: 'completed' }).state, 'completed');

  const quiet = await accept('thanks');
  await publish(quiet, [final('quiet', envelope({ noTextReason: '致谢，无需再发正文。', reaction: 'Get' }))]);
  const quietSaved = await requests.get(quiet.key);
  assert.deepEqual(quietSaved.deliveries.map(d => d.kind), ['reaction']);
  assert.equal(quietSaved.replyPlacement, undefined, 'a reaction does not choose the reply location');

  const withdraw = await accept('withdraw');
  await publish(withdraw, [final('withdraw', envelope({ reaction: null, noTextReason: '无需表情', participationReason: '已有人回答，无增量信息' }))]);
  const withdrawn = await requests.get(withdraw.key);
  assert.equal(withdrawn.deliveries.length, 1);
  assert.equal(withdrawn.deliveries[0].emojiType, null);
  assert.equal(withdrawn.deliveries[0].reactionStage, 2);
  assert.equal(withdrawn.mainlineReply.contract.participationReason, '已有人回答，无增量信息');
  const silentChat = await accept('silent');
  await publish(silentChat, [final('silent', envelope({ noTextReason: '同事互聊，无需补充' }))]);
  assert.deepEqual((await requests.get(silentChat.key)).deliveries, []);

  const file = await accept('file');
  const fileEvent = { ...final('attachment', envelope({ replyMode: 'thread' })),
    attachments: [{ assetId: 'asset', filename: 'report.txt', downloadUrl: '/api/assets/asset' }] };
  await publish(file, [fileEvent]);
  assert((await requests.get(file.key)).deliveries.some(d => d.kind === 'attachment'));

  // Validate the whole input set before reserving or sending anything. The
  // model cannot claim another execution, a different group, or a handoff.
  const bad = await accept('invalid-root'); const other = await accept('other-run');
  const foreign = await accept('other-group', bad, { ...plan.target, chatId: 'foreign' });
  for (const id of [other.requestId, foreign.requestId, 'unknown']) {
    await publish(bad, [final(`bad-${id}`, envelope({ requestIds: [bad.requestId, id], replyMode: 'inline' }, '不得发送'))]);
    assert.equal((await requests.get(bad.key)).deliveries.length, 0);
    assert.equal((await requests.get(bad.key)).mainlineReply, undefined);
  }
  const silent = await accept('no-body');
  const silentSupplement = await accept('human-mention', silent);
  await publish(silent, [final('silent', envelope({ requestIds: [silent.requestId, silentSupplement.requestId],
    noTextReason: '人与人之间的通知及追问，无需参与。' }))]);
  assert.equal((await requests.get(silent.key)).deliveries.length, 0);
  assert.equal(pilotInputResult(await requests.get(silent.key), { id: silent.runId }).state, 'completed');
  assert.equal((await requests.get(silentSupplement.key)).deliveries.length, 0);
  assert.equal(pilotInputResult(await requests.get(silentSupplement.key), { id: silent.runId }).state, 'completed');

  const stopped = await accept('stopped');
  await publishNativeFeishuResponses(stopped, [final('stopped-final', envelope({ replyMode: 'inline' }, '未完成的答复'))],
    { id: stopped.runId, state: 'cancelled' });
  assert.equal((await requests.get(stopped.key)).deliveries.length, 0);

  const rejected = await accept('rejected', bad);
  await requests.mutate(rejected.key, value => ({ ...value, nativeReceipt: { accepted: false } }));
  await publish(bad, [final('rejected-final', envelope({ requestIds: [rejected.requestId], replyMode: 'inline' }, '不得发送'))]);
  assert.equal((await requests.get(rejected.key)).mainlineReply, undefined);

  const revision = await accept('revision');
  await publish(revision, [final('invalid-revision', envelope({ replyMode: 'somewhere' }, '无效位置'))]);
  await publish(revision, [final('invalid-revision', envelope({ replyMode: 'inline' }, '正确位置'))]);
  assert.deepEqual((await requests.get(revision.key)).responseDecisionErrors, {});
  assert.equal((await requests.get(revision.key)).deliveries.filter(d => d.kind === 'content').length, 1);

  const long = await accept('long');
  await publish(long, [final('long-final', envelope({ replyMode: 'thread' }, '长报告'.repeat(5000)))]);
  assert((await requests.get(long.key)).deliveries.some(d => d.kind === 'content'), 'native answers retain their existing length support');

  // Recovery from a partial durable write uses the original decision and does
  // not post twice or transfer a completion claim to unrelated inputs.
  const recovery = await accept('recovery'); const recoveryExtra = await accept('recovery-extra', recovery);
  const contract = { requestIds: [recovery.requestId, recoveryExtra.requestId], ownerRequestId: recovery.requestId,
    payload: { text: '恢复原答复', reaction: 'Get', reactionStage: 2, attachments: [] }, deliveryPlan: recovery.deliveryPlan };
  await requests.mutate(recovery.key, value => ({ ...value, mainlineReplyPlans: [contract] }));
  await recoverPilotReplies(await requests.get(recovery.key)); await recoverPilotReplies(await requests.get(recovery.key));
  assert.deepEqual((await requests.get(recovery.key)).deliveries.map(d => d.kind), ['reaction', 'content']);
  assert.equal((await requests.get(recoveryExtra.key)).mainlineReply.contract.payload.text, '恢复原答复');
  console.log('FEISHU_RESPONSE_VERIFIED: native and tool parity, combined input ownership, reaction targeting, silence, attachments, invalid scope, durable recovery; no external messages.');
} finally { await rm(home, { recursive: true, force: true }); }
