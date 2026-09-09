import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-delivery-errors-'));
setIsolatedTestHome(home);
const outbox = await import('../chat/source-deliveries.mjs');
const { processSourceDeliveryOnce } = await import('../scripts/feishu-connector.mjs');
const { sendFeishuAttachment } = await import('../connectors/feishu/reply-attachments.mjs');
const apiError = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
const requestRemoteLab = async (path, { body = {} } = {}) => {
  if (path.endsWith('/claim')) return { response: { ok: true }, json: { claim: await outbox.claimSourceDelivery(body) } };
  const [, id, action] = /\/api\/source-deliveries\/([^/]+)\/(complete|fail)/.exec(path) || [];
  assert(id, path);
  const delivery = action === 'complete'
    ? await outbox.completeSourceDelivery(id, body.leaseId, body)
    : await outbox.failSourceDelivery(id, body.leaseId, body.error, body);
  return { response: { ok: true }, json: { delivery } };
};
try {
  for (const [name, failure, expected] of [
    ['type-rejection', () => { throw apiError(400, { code: 230055, msg: 'The type of file upload does not match the type of message being sent.' }); }, 'delivery_failed'],
    ['resolved-rejection', () => ({ code: 230002, msg: 'The bot is not in the group.' }), 'delivery_failed'],
    ['timeout', () => { throw Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' }); }, 'unknown'],
    ['gateway', () => { throw apiError(502, { error: 'gateway error' }); }, 'unknown'],
    ['rate-limit', () => { throw apiError(429, { code: 99991400, msg: 'rate limited' }); }, 'pending'],
    ['missing-receipt', () => ({ code: 0, data: {} }), 'unknown'],
  ]) {
    const plan = { connector: 'feishu', sourceRouteId: name, target: { chatId: `chat-${name}`, messageId: 'anchor', threadId: 'topic' } };
    const first = await outbox.enqueueSourceDelivery({ sessionId: name, responseId: 'first', text: 'first answer', sourceDelivery: plan });
    const later = await outbox.enqueueSourceDelivery({ sessionId: name, responseId: 'later', text: 'later answer', sourceDelivery: plan });
    let sends = 0;
    const runtime = { config: { sourceRouteId: name, storageDir: join(home, name) },
      appClient: { im: { v1: { message: { reply: async () => { sends++; return failure(); } } } } } };
    await assert.rejects(processSourceDeliveryOnce(runtime, { requestRemoteLab }));
    const saved = await outbox.getSourceDelivery(first.id);
    assert.equal(saved.state, expected, name);
    assert.equal(saved.attempts, 1);
    if (name === 'type-rejection') assert.match(saved.lastError, /230055.*type of file upload/);
    const messageTypes = [];
    runtime.appClient.im.v1.message.reply = async ({ data }) => { sends++; messageTypes.push(data.msg_type); return { code: 0, data: { message_id: 'next-receipt' } }; };
    await processSourceDeliveryOnce(runtime, { requestRemoteLab });
    if (expected !== 'pending') await processSourceDeliveryOnce(runtime, { requestRemoteLab });
    assert.equal((await outbox.getSourceDelivery(later.id)).state, expected !== 'pending' ? 'delivered' : 'pending');
    assert.equal(sends, expected !== 'pending' ? 3 : 1, 'failed and uncertain originals are isolated; a notice and later reply proceed');
    if (expected !== 'pending') assert.deepEqual(messageTypes, ['text', 'post'], 'failure notice uses simple text independently of rich post formatting');
  }

  // Upload failure is before the message send; no user-visible send is ambiguous.
  const plan = { connector: 'feishu', sourceRouteId: 'upload-failure', target: { chatId: 'upload-chat', messageId: 'anchor', threadId: 'topic' } };
  const first = await outbox.enqueueSourceDelivery({ sessionId: 'upload', responseId: 'upload', attachments: [{ originalName: 'clip.mp4', mimeType: 'video/mp4', data: Buffer.from('video').toString('base64') }], sourceDelivery: plan });
  let uploads = 0;
  let sends = 0;
  const runtime = { config: { sourceRouteId: 'upload-failure', storageDir: join(home, 'upload') },
    appClient: { im: { v1: {
      file: { create: async () => { uploads++; throw Object.assign(new Error('upload connection reset'), { code: 'ECONNRESET' }); } },
      message: { reply: async () => { sends++; return { code: 0, data: { message_id: 'unexpected' } }; } },
    } } } };
  await assert.rejects(processSourceDeliveryOnce(runtime, { requestRemoteLab, sendFeishuAttachment }));
  assert.equal((await outbox.getSourceDelivery(first.id)).state, 'pending');
  assert.equal(uploads, 1);
  assert.equal(sends, 0);

  // A known rejection must survive a lost controller acknowledgement and a
  // restarted connector, including a lease expiring before evidence is replayed.
  for (const commitFailure of [false, true]) {
    const route = `failure-receipt-${commitFailure}`;
    const plan = { connector: 'feishu', sourceRouteId: route, target: { chatId: route, messageId: 'anchor', threadId: 'topic' } };
    const first = await outbox.enqueueSourceDelivery({ sessionId: route, responseId: 'first', text: 'rejected', sourceDelivery: plan });
    const later = await outbox.enqueueSourceDelivery({ sessionId: route, responseId: 'later', text: 'still needs delivery', sourceDelivery: plan });
    const config = { sourceRouteId: route, storageDir: join(home, route) };
    let rejectedSends = 0;
    const rejecting = { config, appClient: { im: { v1: { message: { reply: async () => {
      rejectedSends++;
      throw apiError(400, { code: 230055, msg: 'wrong media type' });
    } } } } } };
    await assert.rejects(processSourceDeliveryOnce(rejecting, { requestRemoteLab: async (path, options) => {
      if (path.endsWith('/fail')) {
        if (commitFailure) await requestRemoteLab(path, options);
        return { response: { ok: false, status: 503 }, json: { error: 'controller unavailable' } };
      }
      return requestRemoteLab(path, options);
    } }));
    if (!commitFailure) {
      const independent = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: route, now: '2035-01-01T00:00:00Z' });
      assert.equal((await outbox.getSourceDelivery(first.id)).state, 'unknown');
      // Expiring the old lease now also releases the next message. This fixture
      // only claimed it (no send), so return it for the restarted sender.
      if (independent) await outbox.failSourceDelivery(independent.delivery.id, independent.leaseId,
        'fixture did not start sending', { safeToRetry: true, retryDelayMs: 0 });
    }
    const restarted = { config };
    const helpers = { requestRemoteLab, receiptReplayOptions: { now: Date.now() + 60000 }, sendFeishuText: async (_runtime, target, text) => {
      if (!target.deliveryNotice) assert.equal(text, 'still needs delivery');
      return { message_id: 'after-restart' };
    } };
    await processSourceDeliveryOnce(restarted, helpers);
    await processSourceDeliveryOnce(restarted, helpers);
    assert.equal((await outbox.getSourceDelivery(first.id)).state, 'delivery_failed', 'replay preserves definite rejection evidence');
    assert.equal((await outbox.getSourceDelivery(later.id)).state, 'delivered');
    assert.equal(rejectedSends, 1, 'recovery only replays acknowledgement, never the rejected send');
  }
  console.log('Feishu delivery errors: definite rejection releases topic, ambiguous sends stay fenced, upload failures retry safely');
} finally {
  await rm(home, { recursive: true, force: true });
}
