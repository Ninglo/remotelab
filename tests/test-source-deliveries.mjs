#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.REMOTELAB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'remotelab-source-deliveries-'));

const {
  buildSourceDeliveryPlan,
  claimSourceDelivery,
  claimSourceDeliveryWithWait,
  completeSourceDelivery,
  enqueueSourceDelivery,
  failSourceDelivery,
  getSourceDelivery,
  listSourceDeliveries,
} = await import('../chat/source-deliveries.mjs');

const plan = buildSourceDeliveryPlan({
  session: {
    connector: 'feishu',
    sourceRouteId: 'unknown',
    chatId: 'oc_group',
    chatType: 'group',
    conversationKind: 'group',
  },
  message: {
    connector: 'feishu',
    messageId: 'om_anchor',
    topicId: 'omt_topic',
    threadId: 'omt_topic',
    groupMessageType: 'topic',
    chatMode: 'thread',
  },
  requestId: 'feishu:om_anchor',
});

assert.deepEqual(plan, {
  connector: 'feishu',
  sourceRouteId: 'default',
  target: {
    chatId: 'oc_group',
    chatType: 'group',
    conversationKind: 'group',
    messageId: 'om_anchor',
    topicId: 'omt_topic',
    threadId: 'omt_topic',
    groupMessageType: 'topic',
    chatMode: 'thread',
  },
});

const first = await enqueueSourceDelivery({
  responseId: 'trigger:trg_test',
  runId: 'run_test',
  sessionId: 'sess_test',
  triggerId: 'trg_test',
  sourceDelivery: plan,
  text: '今天日期：2026-07-27',
});
const duplicate = await enqueueSourceDelivery({
  responseId: 'trigger:trg_test',
  runId: 'run_test',
  sessionId: 'sess_test',
  triggerId: 'trg_test',
  sourceDelivery: plan,
  text: '今天日期：2026-07-27',
});
assert.equal(first.id, duplicate.id);
assert.equal((await listSourceDeliveries()).length, 1);

const claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'default' });
assert.equal(claim.delivery.id, first.id);
assert.match(claim.leaseId, /^lease_[a-f0-9]{24}$/);

const failed = await failSourceDelivery(first.id, claim.leaseId, new Error('temporary'), {
  now: '2026-07-27T00:00:00.000Z',
  retryDelayMs: 1,
  safeToRetry: true,
});
assert.equal(failed.state, 'pending');
assert.equal(failed.attempts, 1);

const secondClaim = await claimSourceDelivery({
  connector: 'feishu',
  sourceRouteId: 'default',
  now: '2026-07-27T00:00:01.000Z',
});
assert.equal(secondClaim.delivery.id, first.id);
const completed = await completeSourceDelivery(first.id, secondClaim.leaseId, {
  externalId: 'om_outbound',
  now: '2026-07-27T00:00:02.000Z',
});
assert.equal(completed.state, 'delivered');
assert.equal(completed.externalId, 'om_outbound');
assert.equal((await getSourceDelivery(first.id)).state, 'delivered');

// A waiter must wake from a durable outbox commit without an interval poll.
const waitingClaim = claimSourceDeliveryWithWait({
  connector: 'feishu', sourceRouteId: 'wake-route', waitMs: 1000,
});
const wakeDelivery = await enqueueSourceDelivery({
  responseId: 'wake-response', sessionId: 'wake-session', text: 'wake now',
  sourceDelivery: { connector: 'feishu', sourceRouteId: 'wake-route', target: { chatId: 'wake-chat' } },
});
const woken = await waitingClaim;
assert.equal(woken.delivery.id, wakeDelivery.id);
await completeSourceDelivery(wakeDelivery.id, woken.leaseId, { externalId: 'wake-message' });

const retryDelivery = await enqueueSourceDelivery({
  responseId: 'retry-response', sessionId: 'retry-session', text: 'retry later',
  sourceDelivery: { connector: 'feishu', sourceRouteId: 'retry-route', target: { chatId: 'retry-chat' } },
});
const retryFirstClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'retry-route' });
await failSourceDelivery(retryDelivery.id, retryFirstClaim.leaseId, 'temporary', {
  safeToRetry: true, retryDelayMs: 10,
});
const retrySecondClaim = await claimSourceDeliveryWithWait({
  connector: 'feishu', sourceRouteId: 'retry-route', waitMs: 1000,
});
assert.equal(retrySecondClaim.delivery.id, retryDelivery.id, 'long claim wakes when retry backoff becomes due');
await completeSourceDelivery(retryDelivery.id, retrySecondClaim.leaseId, { externalId: 'retry-message' });

const abortedWait = new AbortController();
const abortedClaim = claimSourceDeliveryWithWait({
  connector: 'feishu', sourceRouteId: 'abort-route', waitMs: 1000, signal: abortedWait.signal,
});
abortedWait.abort();
assert.equal(await abortedClaim, null, 'connector shutdown aborts an idle claim immediately');

// An uncertain first group publication fences this Session, without blocking another occurrence.
const { withSessionsMetaMutation, findSessionMeta } = await import('../chat/session-meta-store.mjs');
const freshContinue = {
  connector: 'feishu', sourceRouteId: 'fresh-continue-route',
  target: { chatId: 'fresh-continue-chat', messageId: 'inbound-message' },
};
await withSessionsMetaMutation(async (metas, save) => {
  metas.push({ id: 'fresh-continue-session', conversation: freshContinue });
  await save(metas);
});
const freshContinueDelivery = await enqueueSourceDelivery({
  sessionId: 'fresh-continue-session', responseId: 'fresh-continue-response', text: 'reply in group',
  sourceDelivery: freshContinue,
});
const freshContinueClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'fresh-continue-route' });
await completeSourceDelivery(freshContinueDelivery.id, freshContinueClaim.leaseId, {
  externalId: 'fresh-group-reply', messageId: 'fresh-group-reply', threadId: 'unexpected-thread',
});
assert.deepEqual((await findSessionMeta('fresh-continue-session')).conversation, freshContinue,
  'a continue-mode receipt must not rewrite the Session binding as a thread');

// The group Session can advance before an older reaction is delivered. Keep
// the original inbound message ID, and send that reaction before its text.
const { requests } = await import('../chat/requests.mjs');
const { buildReplyDeliveries } = await import('../lib/reply-deliveries.mjs');
const oldReactionPlan = { connector: 'feishu', sourceRouteId: 'reaction-route',
  target: { chatId: 'reaction-chat', conversationKind: 'main', messageId: 'old-inbound' } };
await withSessionsMetaMutation(async (metas, save) => {
  metas.push({ id: 'reaction-session', conversation: { ...oldReactionPlan,
    target: { ...oldReactionPlan.target, messageId: 'new-inbound' } } });
  await save(metas);
});
const reactionRequest = await requests.accept({ sessionId: 'reaction-session', requestId: 'reaction-request',
  text: 'older request', options: { sourceDelivery: oldReactionPlan } });
await requests.settle(reactionRequest.record.key, { state: 'completed' },
  buildReplyDeliveries(oldReactionPlan, { reaction: 'THANKS', text: '谢谢' }));
const reactionClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'reaction-route' });
assert.equal(reactionClaim.delivery.kind, 'reaction');
assert.equal(reactionClaim.delivery.target.messageId, 'old-inbound');
await completeSourceDelivery(reactionClaim.delivery.id, reactionClaim.leaseId, { externalId: 'reaction-id' });
const textClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'reaction-route' });
assert.equal(textClaim.delivery.kind, 'content');
assert.equal(textClaim.delivery.target.messageId, 'old-inbound', 'text keeps the same inbound quote as its reaction');
await completeSourceDelivery(textClaim.delivery.id, textClaim.leaseId, { externalId: 'reply-id' });

const quotePlan = { connector: 'feishu', sourceRouteId: 'quote-route',
  target: { chatId: 'quote-chat', chatType: 'group', conversationKind: 'main', messageId: 'quote-inbound' } };
await withSessionsMetaMutation(async (metas, save) => {
  const { messageId, ...target } = quotePlan.target;
  metas.push({ id: 'quote-session', conversation: { ...quotePlan, target } });
  await save(metas);
});
const quoteRequest = await requests.accept({ sessionId: 'quote-session', requestId: 'quote-request',
  text: 'reply here', options: { sourceDelivery: quotePlan } });
await requests.settle(quoteRequest.record.key, { state: 'completed' }, buildReplyDeliveries(quotePlan,
  { text: 'quoted result', attachments: [{ assetId: 'result' }] }));
for (const kind of ['content', 'attachment']) {
  const claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'quote-route' });
  assert.equal(claim.delivery.kind, kind);
  assert.deepEqual(claim.delivery.target, quotePlan.target, 'claim retains the source anchor for every part');
  await completeSourceDelivery(claim.delivery.id, claim.leaseId, { externalId: `quote-${kind}`,
    messageId: `quote-${kind}`, threadId: 'provider-thread' });
}
assert.equal((await findSessionMeta('quote-session')).conversation.target.messageId, undefined,
  'a quoted inline receipt leaves the shared mainline Session unanchored');

const legacyThread = {
  connector: 'feishu', sourceRouteId: 'continue-route',
  target: { chatId: 'continue-chat', messageId: 'old-root', rootId: 'old-root', threadId: 'old-thread', replyInThread: true },
};
await withSessionsMetaMutation(async (metas, save) => {
  metas.push({ id: 'continue-session', conversation: legacyThread });
  await save(metas);
});
const continueDelivery = await enqueueSourceDelivery({
  sessionId: 'continue-session', responseId: 'continue-response', text: 'reply in group',
  sourceDelivery: {
    connector: 'feishu', sourceRouteId: 'continue-route',
    target: { chatId: 'continue-chat', messageId: 'current-message' },
  },
});
const continueClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'continue-route' });
assert.equal(continueClaim.delivery.id, continueDelivery.id);
assert.deepEqual(continueClaim.delivery.target, { chatId: 'continue-chat', messageId: 'current-message' },
  'claim preserves an unthreaded request snapshot instead of restoring a legacy Session thread');
await completeSourceDelivery(continueDelivery.id, continueClaim.leaseId, { externalId: 'group-reply' });

const group = { connector: 'feishu', sourceRouteId: 'new-root', target: { chatId: 'same-group' } };
await withSessionsMetaMutation(async (metas, save) => {
  metas.push(...['opening-a', 'opening-b'].map(id => ({ id, conversation: group })));
  await save(metas);
});
const enqueue = (sessionId, responseId) => enqueueSourceDelivery({ sessionId, responseId, text: 'output', sourceDelivery: group });
const root = await enqueue('opening-a', 'root-a');
const later = await enqueue('opening-a', 'later-a');
const other = await enqueue('opening-b', 'root-b');
const pendingRoot = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'new-root' });
assert.equal(pendingRoot.delivery.id, root.id);
await failSourceDelivery(root.id, pendingRoot.leaseId, 'ambiguous network failure');
const independent = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'new-root' });
assert.equal(independent.delivery.id, other.id, 'another Session can open its own topic');
assert.equal((await getSourceDelivery(later.id)).state, 'pending', 'later output cannot open a duplicate root');
await completeSourceDelivery(root.id, pendingRoot.leaseId, { messageId: 'actual-root', threadId: 'actual-thread' });
assert.equal((await findSessionMeta('opening-a')).conversation.target.rootId, 'actual-root');
const follow = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'new-root' });
assert.equal(follow.delivery.id, later.id);
assert.equal(follow.delivery.target.rootId, 'actual-root');
const { resolveSourceDelivery } = await import('../chat/source-deliveries.mjs');
await failSourceDelivery(other.id, independent.leaseId, 'no receipt');
await assert.rejects(resolveSourceDelivery(other.id, { state: 'delivered' }), /actual messageId/);
await resolveSourceDelivery(other.id, { state: 'delivered', messageId: 'operator-root', externalId: 'operator-root' });
assert.equal((await findSessionMeta('opening-b')).conversation.target.rootId, 'operator-root');

// An old already-confirmed terminal result can regain its missing canonical
// receipt through the original acknowledgement, including after archival.
const { loadHistory } = await import('../chat/history.mjs');
const retainedPlan = { connector: 'feishu', sourceRouteId: 'receipt-recovery', target: { chatId: 'retained-chat', chatType: 'p2p', conversationKind: 'main' } };
await withSessionsMetaMutation(async (metas, save) => {
  metas.push({ id: 'retained-session', conversation: retainedPlan }); await save(metas);
});
const retained = (await requests.accept({ sessionId: 'retained-session', requestId: 'retained-result', text: 'request',
  options: { sourceDelivery: retainedPlan }, result: { state: 'completed', payload: { text: '已交付', attachments: [],
    displayEvents: [{ type: 'message', role: 'assistant', phase: 'final_answer', providerMessageId: 'retained-final' }] } },
  plans: [{ ...retainedPlan, kind: 'content', text: '【最终答复】\n\n已交付' }] })).record;
const retainedDelivery = retained.deliveries[0];
await requests.mutate(retained.key, current => ({ ...current, postCompletionPending: false,
  deliveries: current.deliveries.map(part => ({ ...part, state: 'delivered', externalId: 'om-retained', receiptLeaseId: 'original-lease' })) }));
await requests.archiveFinished(retained.key);
await completeSourceDelivery(retainedDelivery.id, 'original-lease', { externalId: 'om-retained' });
await completeSourceDelivery(retainedDelivery.id, 'original-lease', { externalId: 'om-retained' });
const recovered = (await loadHistory('retained-session')).filter(event => event.type === 'source_delivery');
assert.equal(recovered.length, 1, 'duplicate acknowledgements recover one history receipt without sending');
assert.equal(recovered[0].providerMessageId, 'retained-final');
assert.equal(recovered[0].externalId, 'om-retained');
assert.equal(recovered[0].receiptRecovered, true);
assert.equal((await requests.get(retained.key)).deliveries[0].attempts, 0, 'recovery cannot create another send attempt');
console.log('SourceDelivery outbox tests passed.');
