import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'remotelab-delivery-recovery-'));
process.env.REMOTELAB_CONFIG_DIR = root;
const { enqueueSourceDelivery, claimSourceDelivery, getSourceDelivery, completeSourceDelivery, resolveSourceDelivery } = await import('../chat/source-deliveries.mjs');
try {
  const input = { sessionId: 'session_a', responseId: 'reply_a', text: 'answer', sourceDelivery: { connector: 'feishu', sourceRouteId: 'default', target: { chatId: 'chat_a' } } };
  const first = await enqueueSourceDelivery(input);
  const claim = await claimSourceDelivery({ connector: 'feishu', now: '2030-01-01T00:00:00Z' });
  assert.equal(claim.delivery.id, first.id);
  await enqueueSourceDelivery({ ...input, responseId: 'reply_b' });
  const other = await enqueueSourceDelivery({ ...input, responseId: 'reply_c', sourceDelivery: { ...input.sourceDelivery, target: { chatId: 'chat_b' } } });
  const next = await claimSourceDelivery({ connector: 'feishu', now: '2030-01-01T00:05:00Z' });
  assert.equal((await getSourceDelivery(first.id)).state, 'unknown', 'a lost receipt is not permission to resend');
  assert.equal(next.delivery.id, other.id, 'ambiguous delivery blocks its target, not other chats');
  await completeSourceDelivery(first.id, claim.leaseId, { externalId: 'late' });
  assert.equal((await getSourceDelivery(first.id)).externalId, 'late', 'known receipt closes the same expired attempt');
  const second = await claimSourceDelivery({ connector: 'feishu', now: '2030-01-01T00:06:00Z' });
  await claimSourceDelivery({ connector: 'feishu', now: '2030-01-01T00:09:00Z' });
  await resolveSourceDelivery(second.delivery.id, { state: 'pending', reason: 'operator verified absence' });
  const replacement = await claimSourceDelivery({ connector: 'feishu', now: '2030-01-01T00:10:00Z' });
  assert.notEqual(second.leaseId, replacement.leaseId);
  await assert.rejects(completeSourceDelivery(second.delivery.id, second.leaseId, { externalId: 'old' }), /lease/);
  const multipart = await enqueueSourceDelivery({ sessionId: 'multipart', responseId: 'parts', text: 'answer',
    attachments: [{ assetId: 'asset-a' }, { assetId: 'asset-b' }],
    sourceDelivery: { connector: 'feishu', sourceRouteId: 'attachments', target: { chatId: 'chat-parts' } } });
  const textPart = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'attachments' });
  await completeSourceDelivery(textPart.delivery.id, textPart.leaseId, { externalId: 'text-receipt' });
  const attachmentA = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'attachments' });
  assert.equal(attachmentA.delivery.attachment.assetId, 'asset-a');
  await completeSourceDelivery(attachmentA.delivery.id, attachmentA.leaseId, { externalId: 'attachment-a-receipt' });
  const attachmentB = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'attachments' });
  assert.equal(attachmentB.delivery.attachment.assetId, 'asset-b', 'only the unfinished attachment is claimed');
  assert.equal((await getSourceDelivery(multipart.id)).externalId, 'text-receipt');
  console.log('delivery recovery: uncertainty, independent targets, lease fencing and partial attachment receipts passed');
} finally { await rm(root, { recursive: true, force: true }); }
