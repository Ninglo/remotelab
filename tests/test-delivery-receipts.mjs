import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeliveryReceipts } from '../lib/delivery-receipts.mjs';

const root = await mkdtemp(join(tmpdir(), 'delivery-receipts-'));
try {
  const receipts = createDeliveryReceipts(root);
  await receipts.record({ deliveryId: 'delivery_a', leaseId: 'attempt_a', externalId: 'feishu_message', target: { chatId: 'chat' } });
  await assert.rejects(receipts.flush(async () => { throw new Error('control plane offline'); }), /offline/);
  const restored = createDeliveryReceipts(root);
  let acknowledgements = 0;
  await restored.flush(async receipt => { acknowledgements++; assert.equal(receipt.externalId, 'feishu_message'); });
  await createDeliveryReceipts(root).flush(async () => { throw new Error('receipt acknowledged twice'); });
  assert.equal(acknowledgements, 1);
  console.log('delivery receipts: lost control-plane acknowledgement recovers without another external send');
} finally { await rm(root, { recursive: true, force: true }); }
