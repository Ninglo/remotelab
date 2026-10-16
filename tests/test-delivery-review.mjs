import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'delivery-review-'));
setIsolatedTestHome(home);
const dir = join(home, '.config/remotelab');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'a', people: ['a','b'].map(id => ({ id, name: id, identities: [{ id: 'i'+id, kind: 'web', subjectId: id }] })) }));
const plan = chatId => ({ connector: 'feishu', sourceRouteId: 'bot', target: { chatId, tenantKey: 'tenant', chatType: 'group', conversationKind: 'main' } });
const origin = { ...plan('source'), target: { ...plan('source').target, conversationKind: 'thread', rootId: 'original', replyInThread: true } };
await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify({ version: 2, enabled: true, personIds: ['a'], crossGroupSync: true, trialId: 'test', groups: ['source','reviewers'].map(chatId => ({ sourceRouteId: 'bot', chatId, tenantKey: 'tenant', folder: home })) }));
await writeFile(join(dir, 'chat-sessions.json'), JSON.stringify([{ id: 'work', name: 'original work', folder: home, conversation: origin }, { id: 'group', name: 'reviewers main', folder: home, conversation: plan('reviewers'), groupFeed: true }]));
await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
const { requests } = await import('../chat/requests.mjs');
const { findSessionMeta, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { handleDeliveryReview, deliveryReviewContext, deliveryReviewPrompt, validateDeliveryReview, completeDeliveryReview } = await import('../chat/delivery-review.mjs');
const { claimSourceDelivery, completeSourceDelivery, getSourceDelivery, listSourceDeliveries } = await import('../chat/source-deliveries.mjs');
const { canForwardNativeRequest } = await import('../chat/native-request-dispatch.mjs');
const input = async (sessionId, requestId, who = 'a', extra = {}) => (await requests.accept({ sessionId, requestId, text: `Feedback from ${who}: ${requestId}`, images: [{ name: 'evidence.png', path: '/fixture/evidence.png' }], options: { viewPersonId: who, initiatedByIdentityId: 'i'+who, ...extra, sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatId: sessionId === 'work' ? 'source' : 'reviewers', tenantKey: 'tenant', chatType: 'group', messageId: requestId, conversationContext: { messages: ['unrelated private history'] }, sender: { senderType: 'user', openId: who } } }, deliveryPlan: sessionId === 'work' ? origin : plan('reviewers') })).record;
let submissions = 0, loseAck = false, manager;
const deps = { submitHttpMessage: async (sessionId, text, images, options) => {
  const result = await requests.accept({ sessionId, requestId: options.requestId, text, images: options.preSavedAttachments, options, deliveryPlan: options.sourceDelivery });
  if (!result.duplicate) submissions++;
  if (loseAck) { loseAck = false; throw Error('lost acknowledgement'); }
  return { requestId: result.record.requestId, run: { id: result.record.runId } };
} };
try {
  const author = await input('work', 'publish');
  const body = { action: 'publish', key: 'release-review', chatId: 'reviewers', text: 'Please review this result.', scope: 'Review this result and return relevant feedback to the original work.', authorization: 'Human explicitly asked to publish this result and receive feedback.' };
  const posted = await handleDeliveryReview(author, body);
  assert.equal(posted.state, 'pending');
  assert.equal((await handleDeliveryReview(author, body)).deliveryId, posted.deliveryId);
  await assert.rejects(handleDeliveryReview(author, { ...body, text: 'changed text' }), /immutable/);
  await assert.rejects(handleDeliveryReview(author, { ...body, key: 'bad', chatId: 'outside' }), /registered/);
  const group = await findSessionMeta('group');
  const ctx = { ...plan('reviewers').target, sourceRouteId: 'bot', connector: 'feishu' };
  assert.deepEqual(await deliveryReviewContext(group, ctx), [], 'pending send is not a feedback relationship');
  const claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' });
  await completeSourceDelivery(claim.delivery.id, claim.leaseId, { messageId: 'published-message', externalId: 'published-message' });
  assert.equal((await getSourceDelivery(posted.deliveryId)).deliveredMessageId, 'published-message');
  assert.equal((await findSessionMeta('work')).conversation.target.rootId, 'original', 'publication never rebinds original work');
  assert.equal((await findSessionMeta('group')).groupFeed, true);
  const feedbackA = await input('group', 'feedback-a');
  let feedbackB = await input('group', 'feedback-b', 'b');
  feedbackB = await requests.mutate(feedbackB.key, r => ({ ...r, nativeDispatchRunId: feedbackA.runId }));
  const packet = { action: 'feedback', originSessionId: 'work', reviewId: posted.reviewId, messageId: 'published-message', requestIds: ['feedback-a','feedback-b'], reason: 'Both discuss this publication.', handled: 'Explained the known behavior.', unresolved: 'Two different proposed revisions remain.' };
  assert.match(await deliveryReviewPrompt(group, ctx), /原工作归属/);
  await assert.rejects(handleDeliveryReview(feedbackA, { ...packet, messageId: 'unrelated' }, deps), /actually delivered/);
  const unrelated = await input('work', 'other');
  await assert.rejects(handleDeliveryReview(unrelated, packet, deps), /review group/);
  loseAck = true;
  await assert.rejects(handleDeliveryReview(feedbackA, packet, deps), /lost acknowledgement/);
  const received = await handleDeliveryReview(feedbackA, packet, deps);
  assert.equal(submissions, 1, 'lost admission acknowledgement never repeats work');
  assert.equal((await handleDeliveryReview(feedbackB, packet, deps)).requestId, received.requestId);
  const request = await requests.byRequest('work', received.requestId);
  assert.equal(request.options.recordUserMessage, false);
  assert.equal(request.deliveryPlan.target.rootId, 'original');
  assert.match(request.text, /Feedback from a/); assert.match(request.text, /Feedback from b/); assert.doesNotMatch(request.text, /unrelated private history/);
  assert.equal(request.images.length, 2);
  assert.equal((await listSourceDeliveries()).length, 0, 'feedback does not send another group message');
  assert.equal(canForwardNativeRequest(request, { key: 'head', options: {} }), false, 'feedback cannot answer an active native question');
  assert.equal(canForwardNativeRequest({ key: 'human', options: {} }, request), false, 'new input cannot join review processing without its own contract');
  assert.equal(canForwardNativeRequest({ key: 'answer', options: { nativeQuestionId: 'actual-question' } }, request), true, 'a real answer can still reach a reviewing Harness question');
  await validateDeliveryReview(request);
  await requests.settle(request.key, { state: 'completed', payload: { text: 'Feedback assessed within original scope.' } });
  await completeDeliveryReview(await requests.get(request.key));
  const state = await deliveryReviewContext(group, ctx);
  assert.equal(state[0].feedback[0].state, 'completed');
  await handleDeliveryReview(feedbackA, packet, deps);
  assert.equal((await deliveryReviewContext(group, ctx))[0].feedback[0].state, 'completed', 'retry preserves completion');
  await assert.rejects(handleDeliveryReview(feedbackA, { ...packet, requestIds: ['feedback-a'] }, deps), /already been returned/);
  await assert.rejects(handleDeliveryReview(feedbackA, { ...packet, unresolved: 'new scope' }, deps), /immutable/);
  await assert.rejects(handleDeliveryReview(await input('work','other-close','b'), { action: 'close', reviewId: posted.reviewId, expectedVersion: 1, reason: 'done' }), /original publisher/);
  await handleDeliveryReview(author, { action: 'close', reviewId: posted.reviewId, expectedVersion: 1, reason: 'Review finished.' });
  await assert.rejects(validateDeliveryReview(request), /已关闭/);
  await assert.rejects(handleDeliveryReview(feedbackA, packet, deps), /closed/);
  assert.deepEqual(await deliveryReviewContext(group, ctx), []);
  assert.equal((await deliveryReviewContext(await findSessionMeta('work'), null))[0].state, 'closed');
  // Exercise the real admission/preparation/completion/outbox path as well as
  // the injected lost-ack transport. No provider credentials or live groups.
  await mkdir(join(home, 'bin'));
  await writeFile(join(home, 'bin/review-fixture'), `#!/usr/bin/env node
console.log(JSON.stringify({type:'thread.started',thread_id:'review-fixture'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'原工作已核对审阅反馈。'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`);
  await chmod(join(home, 'bin/review-fixture'), 0o755);
  process.env.PATH = join(home, 'bin') + ':' + process.env.PATH;
  await writeFile(join(dir, 'tools.json'), JSON.stringify([{ id: 'review-fixture', name: 'Review fixture', command: 'review-fixture', runtimeFamily: 'codex-json', promptMode: 'bare-user' }]));
  await mutateSessionMeta('work', s => { s.tool = 'review-fixture'; return true; });
  const live = await handleDeliveryReview(author, { ...body, key: 'runtime' });
  const liveClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' });
  await completeSourceDelivery(liveClaim.delivery.id, liveClaim.leaseId, { messageId: 'runtime-publication' });
  const liveInput = await input('group', 'runtime-feedback');
  const admission = await handleDeliveryReview(liveInput, { ...packet, reviewId: live.reviewId, messageId: 'runtime-publication', requestIds: [liveInput.requestId] }, deps);
  for (const r of await requests.projectActive(records => records)) if (r.requestId !== admission.requestId && !r.options.deliveryOnly) {
    await requests.mutate(r.key, current => ({ ...current, result: current.result || { state: 'completed', payload: { text: '' } }, releasedAt: new Date().toISOString(), postCompletionPending: false }));
  }
  manager = await import('../chat/session-manager.mjs');
  const stored = await requests.byRequest('work', admission.requestId);
  await manager.submitHttpMessage('work', stored.text, [], stored.options);
  const deadline = Date.now() + 20000;
  let actual, delay = 25;
  while (Date.now() < deadline) {
    actual = await requests.byRequest('work', admission.requestId);
    if (actual?.result && !actual.postCompletionPending) break;
    await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(500, delay * 2);
  }
  assert.equal(actual?.result?.state, 'completed', JSON.stringify(actual?.result));
  assert.equal(actual.postCompletionPending, false);
  assert.equal(actual.deliveries.filter(d => d.kind === 'content').length, 1);
  assert.equal(actual.deliveries.find(d => d.kind === 'content').target.chatId, 'source');
  assert.equal(actual.deliveries.find(d => d.kind === 'content').target.rootId, 'original');
  assert.equal((await deliveryReviewContext(group, ctx))[0].feedback[0].state, 'completed');
  console.log('delivery review: publication receipt, separate ownership, multi-author return, dedup, scope, queue and close passed');
} finally { if (manager) await manager.killAll(); await rm(home, { recursive: true, force: true }); }
