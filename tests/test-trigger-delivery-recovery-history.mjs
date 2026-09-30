import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'remotelab-trigger-recovery-'));
process.env.HOME = home;
const { appendEvents } = await import('../chat/history.mjs');
const { createRun } = await import('../chat/runs.mjs');
const delivery = await import('../chat/source-deliveries.mjs');
const { startDetachedRunObservers } = await import('../chat/session-manager.mjs');
const plan = { connector: 'feishu', sourceRouteId: 'default', target: { chatId: 'group' } };
const sessionId = 'recovery-history';
const originalStringify = JSON.stringify;
try {
  await appendEvents(sessionId, Array.from({ length: 250 }, (_, n) => ({
    type: 'message', role: 'assistant', runId: `unrelated-${n}`, content: 'unrelated '.repeat(2500),
  })));
  const makeRun = async (id, responseId) => createRun({
    status: { id, sessionId, responseId, requestId: responseId, state: 'completed', finalizedAt: new Date().toISOString() },
    manifest: { sessionId, responseId, internalOperation: 'trigger_delivery', sourceDelivery: plan },
  });
  await makeRun('run_delivered', 'delivered');
  const first = await delivery.enqueueSourceDelivery({ sessionId, responseId: 'delivered', sourceDelivery: plan, text: 'original result' });
  const claim = await delivery.claimSourceDelivery({ connector: 'feishu' });
  await delivery.completeSourceDelivery(first.id, claim.leaseId, { externalId: 'sent-message' });
  await makeRun('run_pending', 'pending');
  await delivery.enqueueSourceDelivery({ sessionId, responseId: 'pending', sourceDelivery: plan, text: 'already queued' });
  await makeRun('run_missing', 'missing');
  await appendEvents(sessionId, [{ type: 'message', role: 'assistant', runId: 'run_missing', responseId: 'missing', content: 'recovered result' }]);
  // Same response at a different target must not suppress recovery.
  await delivery.enqueueSourceDelivery({ sessionId, responseId: 'missing', sourceDelivery: { ...plan, target: { chatId: 'other-group' } }, text: 'other target' });
  let unrelatedCopies = 0;
  JSON.stringify = function(value, ...args) {
    if (value?.type === 'message' && value.content?.startsWith('unrelated ')) unrelatedCopies += 1;
    return originalStringify(value, ...args);
  };
  await startDetachedRunObservers();
  JSON.stringify = originalStringify;
  assert.equal(unrelatedCopies, 0, 'restart recovery must not copy unrelated conversation bodies');
  const records = await delivery.listSourceDeliveries();
  assert.equal(records.length, 4);
  assert.equal(records.find(record => record.id === first.id).externalId, 'sent-message');
  assert.equal(records.find(record => record.responseId === 'pending').text, 'already queued');
  assert.equal(records.find(record => record.responseId === 'missing' && record.target.chatId === 'group').text, 'recovered result');
  await startDetachedRunObservers();
  assert.equal((await delivery.listSourceDeliveries()).length, 4, 'repeat recovery must remain idempotent');
  console.log('trigger-delivery-recovery-history: ok');
} finally {
  JSON.stringify = originalStringify;
  await rm(home, { recursive: true, force: true });
}
