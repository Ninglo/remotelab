#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.REMOTELAB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'remotelab-source-deliveries-'));

const {
  buildSourceDeliveryPlan,
  claimSourceDelivery,
  completeSourceDelivery,
  enqueueSourceDelivery,
  failSourceDelivery,
  getSourceDelivery,
  listSourceDeliveries,
} = await import('../chat/source-deliveries.mjs');

const plan = buildSourceDeliveryPlan({
  session: {
    connector: 'feishu',
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
  text: 'ignored duplicate',
});
assert.equal(first.id, duplicate.id);
assert.equal((await listSourceDeliveries()).length, 1);

const claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'default' });
assert.equal(claim.delivery.id, first.id);
assert.match(claim.leaseId, /^lease_[a-f0-9]{24}$/);

const failed = await failSourceDelivery(first.id, claim.leaseId, new Error('temporary'), {
  now: '2026-07-27T00:00:00.000Z',
  retryDelayMs: 1,
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

console.log('SourceDelivery outbox tests passed.');
