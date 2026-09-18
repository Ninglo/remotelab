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
console.log('SourceDelivery outbox tests passed.');
