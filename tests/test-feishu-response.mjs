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
  const { publishLiveAssistantReplies } = await import('../chat/native-final-publication.mjs');
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

  // Missing optional placement metadata must not replace a usable answer with
  // a protocol error. Preserve the accepted address, explicit decisions and
  // per-input ownership without a model repair call.
  for (const kind of ['main', 'thread']) {
    let plain = await accept('plain-' + kind, null, { ...plan.target, conversationKind: kind,
      ...(kind === 'thread' ? { rootId: 'existing-root', threadId: 'existing-thread', replyInThread: true } : {}) });
    plain = await requests.mutate(plain.key, r => ({ ...r, options: { ...r.options,
      sourceContext: { ...r.options.sourceContext, feishuThreadSessionVersion: 1 } } }));
    const extra = await accept('unclaimed-' + kind, plain);
    const answer = final('plain-final-' + kind, '这种回复速度明显偏慢。');
    await publishNativeFeishuResponses(plain, [answer], { id: plain.runId, state: 'running' }, { running: true });
    await publish(plain, [answer]);
    const saved = await requests.get(plain.key);
    const content = saved.deliveries.filter(d => d.kind === 'content');
    assert.equal(content.length, 1);
    assert.ok(content[0].text.endsWith('这种回复速度明显偏慢。'));
    assert.equal(content[0].target.conversationKind, kind);
    if (kind === 'thread') assert.equal(content[0].target.rootId, 'existing-root');
    assert.equal((await requests.get(extra.key)).mainlineReply, undefined, 'plain final covers only its root input');
    assert.deepEqual(saved.responseDecisionErrors, {});
  }
  let invalidDefault = await accept('invalid-default');
  invalidDefault = await requests.mutate(invalidDefault.key, r => ({ ...r, options: { ...r.options,
    sourceContext: { ...r.options.sourceContext, feishuThreadSessionVersion: 1 } } }));
  await publish(invalidDefault, [final('invalid-default-final', envelope({ replyMode: 'invalid' }, '不能猜测这个显式决定'))]);
  assert.equal((await requests.get(invalidDefault.key)).deliveries.filter(d => d.kind === 'content').length, 0);
  assert.ok((await requests.get(invalidDefault.key)).responseDecisionErrors['invalid-default-final']);

  // Real latency regression: a completed answer waited for a steered input's
  // extra model calls, then vanished behind that input's combined final.
  const live = await accept('live-root');
  const liveExtra = await accept('live-extra', live);
  const first = final('live-first', envelope({ replyMode: 'inline' }, '这条直接回复。'));
  const next = final('live-next', envelope({ replyMode: 'inline',
    requestIds: [live.requestId, liveExtra.requestId] }, '补问的回答。'));
  const liveRun = { id: live.runId, state: 'running' };
  const liveOptions = { session: { id: 'session', sourceId: 'feishu' }, running: true };
  await publishNativeFeishuResponses(live, [{ ...first, phase: undefined }], liveRun, liveOptions);
  assert.equal((await requests.get(live.key)).deliveries.length, 0, 'unfinished/legacy text waits for settlement');
  await publishNativeFeishuResponses(live, [first], liveRun, { ...liveOptions, prepareFinal: async () => null });
  assert.equal((await requests.get(live.key)).deliveries.length, 0, 'unready assets defer the entire answer');
  await publishNativeFeishuResponses(live, [first], liveRun, liveOptions);
  assert.equal((await requests.get(live.key)).deliveries[0].text, '这条直接回复。');
  assert.equal((await requests.get(live.key)).result, null, 'publication does not finish the native execution');
  await publishNativeFeishuResponses(await requests.get(live.key), [first, next], liveRun, liveOptions);
  await publish(await requests.get(live.key), [first, next]);
  assert.equal((await requests.get(live.key)).deliveries.length, 1, 'root receipt survives replay and later combined finals');
  assert.equal((await requests.get(liveExtra.key)).deliveries[0].text, '补问的回答。');
  assert.deepEqual((await requests.get(liveExtra.key)).mainlineReply.contract.requestIds, [liveExtra.requestId]);
  assert.deepEqual((await requests.get(live.key)).responseDecisionErrors, {});

  // Final status comes from the real receipt, remains frozen on retry, and
  // does not weaken reply-content conflict detection or no-text decisions.
  const {recordFeatureExecution} = await import('../chat/feature-observation.mjs');
  let reviewed=await accept('receipt-visible');
  reviewed=await requests.mutate(reviewed.key,r=>({...r,options:{...r.options,messageReplyPolicy:{selfReview:true}}}));
  const packet={text:envelope({replyMode:'thread'},'交付内容')};
  await publishFeishuResponse(reviewed,packet);
  const firstReceipt=(await requests.get(reviewed.key)).mainlineReply.contract.payload;
  assert.doesNotMatch(firstReceipt.text,/自检/);
  assert.equal(firstReceipt.featureReview.state,'no_record');assert.equal(firstReceipt.featureReview.footer,'');
  await recordFeatureExecution(reviewed,{action:'begin'});
  await recordFeatureExecution(reviewed,{action:'finish',outcome:'not_applicable',checks:[]});
  await publishFeishuResponse(reviewed,packet);
  assert.deepEqual((await requests.get(reviewed.key)).mainlineReply.contract.payload,firstReceipt);
  await assert.rejects(publishFeishuResponse(reviewed,{text:envelope({replyMode:'thread'},'偷偷更改内容')}),/different|preserve/);
  let finishedReview=await accept('receipt-finished');
  finishedReview=await requests.mutate(finishedReview.key,r=>({...r,options:{...r.options,messageReplyPolicy:{selfReview:true}}}));
  await recordFeatureExecution(finishedReview,{action:'begin'});
  await recordFeatureExecution(finishedReview,{action:'finish',outcome:'not_applicable',checks:[],
    explanation:{note:'仅问答',reason:'仅回答功能含义，没有交付物需要验收',actions:[],nextStep:'没有后续验收',userAction:'无需操作'}});
  await publish(finishedReview,[final('review-final',envelope({replyMode:'thread'},'简短回答'))]);
  const finishedText=(await requests.get(finishedReview.key)).deliveries.find(d=>d.kind==='content').text;
  assert.ok(finishedText.endsWith('简短回答'));assert.doesNotMatch(finishedText,/自检/);

  // A successful routine review adds no badge to the actual Feishu publication.
  const {appendEvent}=await import('../chat/history.mjs');
  let passedReview=await accept('receipt-passed');
  passedReview=await requests.mutate(passedReview.key,r=>({...r,options:{...r.options,messageReplyPolicy:{selfReview:true}}}));
  await recordFeatureExecution(passedReview,{action:'begin'});
  const evidence=await appendEvent(passedReview.sessionId,{type:'tool_result',runId:passedReview.runId,toolName:'shell',output:'actual file verified',exitCode:0});
  await recordFeatureExecution(passedReview,{action:'finish',outcome:'passed',checks:[{criterion:'实际文件',verdict:'pass',evidenceSeqs:[evidence.seq]}]});
  await publish(passedReview,[final('passed-final',envelope({replyMode:'thread'},'交付结果'))]);
  const passedText=(await requests.get(passedReview.key)).deliveries.find(d=>d.kind==='content').text;
  assert.ok(passedText.endsWith('交付结果'));assert.doesNotMatch(passedText,/自检/);

  // Real live-publication surfaces must not occupy the terminal answer slot.
  // Cover native questions, direct supplementary replies and their combination.
  for (const kinds of [['question'], ['reply'], ['question', 'reply']]) {
    const name = 'dialogue-' + kinds.join('-');
    let dialogue = await accept(name, null, { ...plan.target, conversationKind: 'thread',
      threadId: name, rootId: name, replyInThread: true });
    dialogue = await requests.mutate(dialogue.key, current => ({ ...current,
      options: { ...current.options, messageReplyPolicy: { version: 3, opening: false, progress: 'none', final: true } } }));
    const events = kinds.map((kind, i) => ({ type: 'message', role: 'assistant', phase: 'commentary',
      seq: i + 1, runId: dialogue.runId, providerMessageId: `${name}-${kind}`,
      content: kind === 'question' ? '请选择输出形式。' : '<reply>补充的问题已核对，原任务继续。</reply>',
      ...(kind === 'question' ? { messageKind: 'user_question', questionId: name,
        questionState: 'pending', nativeQuestion: { options: ['A', 'B'] } } : {}) }));
    const session = { id: 'session', sourceId: 'feishu' };
    await publishLiveAssistantReplies(dialogue, events, { store: requests, plan: dialogue.deliveryPlan,
      session, fullHistory: events, running: true });
    assert.deepEqual((await requests.get(dialogue.key)).deliveries.map(d => d.surfaceKind), kinds);
    const answer = final(name + '-final', envelope({ replyMode: 'thread' }, '原任务已经完成。'));
    await publish(dialogue, [...events, answer]);
    await publish(dialogue, [...events, answer]);
    const delivered = await requests.get(dialogue.key);
    assert.equal(delivered.deliveries.filter(d => d.surfaceKind === 'final').length, 1,
      'dialogue permits one final and replay does not duplicate it');
    assert.deepEqual(delivered.responseDecisionErrors, {});
  }

  // Production regression: native question callbacks do not carry the ordinary
  // message protocol. They are context for the answer, not separate owners.
  const clarified = await accept('clarified');
  const clarification = await accept('feishu-question:accepted', clarified);
  await requests.mutate(clarification.key, input => ({ ...input,
    options: { nativeQuestionId: 'question-1', sourceContext: {
      connector: 'feishu', sender: { senderType: 'user' } } },
    nativeReceipt: { accepted: true, mode: 'question_answer', origin: 'user', questionId: 'question-1' } }));
  const clarifiedFinal = final('clarified-final', envelope({ replyMode: 'thread',
    requestIds: [clarification.requestId, clarified.requestId] }, '根据澄清已完成。'));
  await publish(clarified, [clarifiedFinal]); await publish(clarified, [clarifiedFinal]);
  const clarifiedSaved = await requests.get(clarified.key);
  assert.deepEqual(clarifiedSaved.responseDecisionErrors, {});
  assert.deepEqual(clarifiedSaved.mainlineReply.contract.requestIds, [clarified.requestId]);
  assert.equal(clarifiedSaved.deliveries.filter(d => d.kind === 'content').length, 1);
  assert.equal((await requests.get(clarification.key)).mainlineReply, undefined);
  for (const mode of ['foreign-run', 'foreign-group', 'rejected', 'unknown']) {
    const negative = await accept('question-negative-' + mode);
    let qid = 'feishu-question:unknown';
    if (mode !== 'unknown') {
      const q = await accept('feishu-question:' + mode, mode === 'foreign-run' ? clarified : negative,
        mode === 'foreign-group' ? { ...plan.target, chatId: 'other-group' } : plan.target);
      qid = q.requestId;
      await requests.mutate(q.key, input => ({ ...input,
        options: { nativeQuestionId: 'q', sourceContext: { connector: 'feishu', sender: { senderType: 'user' } } },
        nativeReceipt: { accepted: mode !== 'rejected', mode: 'question_answer', origin: 'user', questionId: 'q' } }));
    }
    await publish(negative, [final('negative-' + mode, envelope({ replyMode: 'thread',
      requestIds: [negative.requestId, qid] }, '不得发送'))]);
    assert(Object.keys((await requests.get(negative.key)).responseDecisionErrors).length);
    assert.equal((await requests.get(negative.key)).deliveries.length, 0);
  }

  // The run-level final index must not claim the root's input slot when a
  // supplemental answer was published first (including silent decisions).
  for (const silent of [false, true]) {
    const multi = await accept('supplement-first-' + silent);
    const supplement = await accept('supplement-owner-' + silent, multi);
    const extraFinal = final('extra-' + silent, envelope({ requestIds: [supplement.requestId], replyMode: 'thread',
      ...(silent ? { noTextReason: '无需插话' } : {}) }, silent ? '' : '补充答复'));
    const rootFinal = final('root-' + silent, envelope({ replyMode: 'thread',
      ...(silent ? { noTextReason: '无需插话' } : {}) }, silent ? '' : '原问题答复'));
    await publish(multi, [extraFinal, rootFinal]); await publish(multi, [extraFinal, rootFinal]);
    assert.deepEqual((await requests.get(multi.key)).responseDecisionErrors, {});
    assert((await requests.get(multi.key)).mainlineReply);
    assert((await requests.get(supplement.key)).mainlineReply);
  }

  const overlap = await accept('overlap');
  const overlapExtra = await accept('overlap-extra', overlap);
  const combined = final('combined-old', envelope({ replyMode: 'thread',
    requestIds: [overlap.requestId, overlapExtra.requestId] }, '已完成检查，按要求暂停。'));
  const revised = final('revised-root', envelope({ replyMode: 'thread' }, '明天再继续。'));
  await publish(overlap, [combined, revised]); await publish(overlap, [combined, revised]);
  assert.deepEqual((await requests.get(overlap.key)).responseDecisionErrors, {});
  assert.equal((await requests.get(overlap.key)).mainlineReply.contract.payload.text, '明天再继续。');
  assert.deepEqual((await requests.get(overlapExtra.key)).mainlineReply.contract.requestIds, [overlapExtra.requestId]);
  assert.equal((await requests.get(overlapExtra.key)).deliveries.filter(d => d.kind === 'content').length, 1);

  const handed = await accept('handed');
  await requests.mutate(handed.key, input => ({ ...input,
    routingHandoff: { state: 'submitted', targetSessionId: 'child' } }));
  const handedFinal = final('handed-final', envelope({ noTextReason: '已转交，主线无需重复回复。' }));
  await publish(handed, [handedFinal]); await publish(handed, [handedFinal]);
  assert.deepEqual((await requests.get(handed.key)).responseDecisionErrors, {});
  assert.equal(pilotInputResult(await requests.get(handed.key), { id: handed.runId }).state, 'completed');
  assert.equal((await requests.get(handed.key)).deliveries.length, 0);
  await publish(handed, [final('handed-content', envelope({ replyMode: 'thread' }, '不应再发正文'))]);
  assert(Object.keys((await requests.get(handed.key)).responseDecisionErrors).length);

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
  // A real-model smoke chose inline for a brief question inside an existing
  // topic. Publication must preserve that topic, regardless of this label.
  const inTopic = await accept('topic-short', null, { ...plan.target,
    conversationKind: 'thread', threadId: 'existing-topic', rootId: 'topic-root', replyInThread: true });
  await publish(inTopic, [final('topic-short-answer', envelope({ replyMode: 'inline' }, '8 × 9 = 72。'))]);
  const topicDelivery = (await requests.get(inTopic.key)).deliveries.find(d => d.kind === 'content');
  assert.equal(topicDelivery.target.conversationKind, 'thread');
  assert.equal(topicDelivery.target.threadId, 'existing-topic');
  assert.equal(topicDelivery.target.rootId, 'topic-root');

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

  // An in-flight answer or native question is not the terminal input reply.
  // Reproduce a useful supplement followed by the combined final publication.
  for (const surfaceKind of ['reply', 'question']) {
    const ongoing = await accept(`ongoing-${surfaceKind}`);
    const addition = await accept(`addition-${surfaceKind}`, ongoing);
    await requests.mutate(ongoing.key, value => ({ ...value, deliveries: [{
      id: `intermediate-${surfaceKind}`, kind: 'content', surfaceKind,
      state: 'delivered', text: '已定位，继续处理。',
    }] }));
    const completed = final(`completed-${surfaceKind}`, envelope({ replyMode: 'thread',
      requestIds: [ongoing.requestId, addition.requestId] }, '已完成并验证。'));
    await publish(ongoing, [completed]);
    await publish(ongoing, [completed]);
    const current = await requests.get(ongoing.key);
    assert.deepEqual(current.responseDecisionErrors, {});
    assert.equal(current.deliveries.filter(d => d.surfaceKind === 'final').length, 1);
    assert.equal(pilotInputResult(await requests.get(addition.key), { id: ongoing.runId }).state, 'completed');
    await assert.rejects(() => publishFeishuResponse(current, {
      text: '另一个结果', replyMode: 'thread', requestIds: [ongoing.requestId, addition.requestId],
    }), /different reply or handoff/);
  }

  // Several new matters and corrections can share one answer. The old eight-ID
  // ceiling rejected an otherwise valid response after a burst of supplements.
  const batch = await accept('batch-root');
  const additions = [];
  for (let i = 0; i < 9; i++) additions.push(await accept(`batch-${i}`, batch));
  const batchAnswer = final('batch-answer', envelope({
    requestIds: [batch.requestId, ...additions.map(r => r.requestId)], replyMode: 'thread',
  }, '方案、耗时和新增约束一起答复。'));
  await publish(batch, [batchAnswer]);
  await publish(batch, [batchAnswer]);
  assert.equal((await requests.get(batch.key)).deliveries.filter(d => d.kind === 'content').length, 1);
  for (const input of additions) {
    const value = await requests.get(input.key);
    assert.equal(value.deliveries.length, 0);
    assert.equal(pilotInputResult(value, { id: batch.runId }).state, 'completed');
  }

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
