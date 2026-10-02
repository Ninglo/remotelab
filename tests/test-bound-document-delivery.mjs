import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

setIsolatedTestHome(await mkdtemp(join(tmpdir(), 'bound-document-delivery-')));
const { resolveSessionDeliveryPlan } = await import('../chat/session-conversations.mjs');
const { buildReplyDeliveries } = await import('../lib/reply-deliveries.mjs');
const { withSessionsMetaMutation, findSessionMeta } = await import('../chat/session-meta-store.mjs');
const { enqueueSourceDelivery, claimSourceDelivery, completeSourceDelivery } = await import('../chat/source-deliveries.mjs');

const conversation = { connector: 'feishu', sourceRouteId: 'bound-doc-bot', target: {
  chatId: 'review-chat', tenantKey: 'tenant', conversationKind: 'thread',
  rootId: 'review-root', messageId: 'review-root', threadId: 'review-thread', replyInThread: true,
} };
const sourceDelivery = { connector: 'feishu', sourceRouteId: 'bound-doc-bot', target: {
  conversationKind: 'document_comment', fileToken: 'document', fileType: 'docx', commentId: 'comment', replyId: 'input',
} };
const sourceContext = { connector: 'feishu', sourceRouteId: 'bound-doc-bot',
  conversationKind: 'document_comment', documentBinding: true, documentReplyMode: 'comment',
  fileToken: 'document', fileType: 'docx', commentId: 'comment', replyId: 'input',
};
const session = { id: 'bound-document-session', conversation };
const options = { sourceContext, sourceDelivery };
const plan = resolveSessionDeliveryPlan(session, options);
assert.deepEqual(plan, sourceDelivery);
assert.equal(plan.target.chatId, undefined, 'a document reply must not retain a chat address');
assert.deepEqual(resolveSessionDeliveryPlan(session, {}), conversation, 'chat messages keep their topic');
assert.deepEqual(resolveSessionDeliveryPlan(session, { sourceContext: { ...sourceContext, documentReplyMode: undefined } }),
  conversation, 'legacy binding keeps its manual-reply contract');
assert.equal(resolveSessionDeliveryPlan(session, { ...options, suppressSourceDelivery: true }), null);
for (const changedTarget of [
  { fileToken: 'another-document' }, { commentId: 'another-comment' }, { chatId: 'review-chat' },
]) {
  assert.throws(() => resolveSessionDeliveryPlan(session, {
    ...options, sourceDelivery: { ...sourceDelivery, target: { ...sourceDelivery.target, ...changedTarget } },
  }), /match the admitted comment/);
}
assert.throws(() => resolveSessionDeliveryPlan(session, {
  ...options, sourceDelivery: { ...sourceDelivery, sourceRouteId: 'other-bot' },
}), /match the admitted comment/);
assert.throws(() => resolveSessionDeliveryPlan(session, { sourceContext }), /match the admitted comment/);
assert.throws(() => resolveSessionDeliveryPlan(session, {
  ...options, sourceContext: { ...sourceContext, commentId: '' },
}), /match the admitted comment/);
assert.throws(() => resolveSessionDeliveryPlan(session, { sourceDelivery }), /conflicts/,
  'ordinary chat requests cannot silently redirect into a document');

assert.deepEqual(buildReplyDeliveries(plan, { text: 'I am checking the source.' }, { running: true }), [],
  'only the completed answer is published in a document comment');
const parts = buildReplyDeliveries(plan, { text: 'The threshold is not yet fixed.' }, { running: false });
assert.equal(parts.length, 1);
assert.equal(parts[0].text, 'The threshold is not yet fixed.', 'document replies omit chat state labels');

await withSessionsMetaMutation(async (metas, save) => { metas.push(session); await save(metas); });
const input = { sessionId: session.id, responseId: 'bound-comment-response',
  sourceDelivery: plan, text: parts[0].text };
const delivery = await enqueueSourceDelivery(input);
assert.equal((await enqueueSourceDelivery(input)).id, delivery.id, 'replay creates no duplicate outbox item');
const claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bound-doc-bot' });
assert.equal(claim.delivery.id, delivery.id);
assert.equal(claim.delivery.target.commentId, 'comment');
assert.equal(claim.delivery.target.chatId, undefined, 'claim must not restore the Session topic');
await completeSourceDelivery(delivery.id, claim.leaseId, { externalId: 'provider-reply', messageId: 'provider-reply' });
assert.deepEqual((await findSessionMeta(session.id)).conversation, conversation,
  'a document receipt must not replace the original Session chat binding');
console.log('PASS: bound document replies preserve chat context, address the original comment, and stay idempotent');
