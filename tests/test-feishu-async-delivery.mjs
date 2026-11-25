import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-feishu-async-'));
setIsolatedTestHome(root);
const { startSourceDeliveryPoller, stopSourceDeliveryPoller, processSourceDeliveryOnce } = await import('../scripts/feishu-connector.mjs');
const { claimSourceDeliveryWithWait, completeSourceDelivery, enqueueSourceDelivery, getSourceDelivery } = await import('../chat/source-deliveries.mjs');
const { requests } = await import('../chat/requests.mjs');

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
async function within(promise, ms = 5_000) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Delivery did not advance within ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timeout); }
}
const response = json => ({ response: { ok: true }, json });
const route = 'async-test';
const target = (threadId, extra = {}) => ({ connector: 'feishu', sourceRouteId: route,
  target: { chatId: 'same-chat', threadId, chatType: 'group', conversationKind: 'thread', ...extra } });
const storageDir = join(root, 'connector');
const runtime = () => ({ config: { sourceRouteId: route, storageDir } });
const slowUpload = deferred(), slowReceipt = deferred(), uploading = deferred(), acknowledging = deferred();
const heldLabels = ['hold-1', 'hold-2', 'hold-3', 'hold-4'];
const heldUploads = new Map(heldLabels.map(label => [label, deferred()]));
const releaseHeldUploads = deferred();
const reactionSent = new Map([['b-inbound', deferred()], ['c-inbound', deferred()]]);
const nextSent = deferred();
let poll, replayed = 0, activeClaims = 0, maxClaims = 0;
const sends = [];
let rejectSlowReceipt = true;
try {
  const attachment = async label => (await requests.accept({ sessionId: label, requestId: `${label}-file`, text: 'attachment',
    options: { deliveryOnly: true }, result: { state: 'completed' },
    plans: [{ ...target(`thread-${label}`, { rootId: `root-${label}` }), kind: 'attachment', attachment: { assetId: `file-${label}` } }],
  })).record.deliveries[0];
  const a = await attachment('a');
  const heldDeliveries = [];
  for (const label of heldLabels) heldDeliveries.push(await attachment(label));
  const next = await enqueueSourceDelivery({ sessionId: 'a', responseId: 'next-a', text: 'body-a', sourceDelivery: target('thread-a') });
  const thinking = async label => (await requests.accept({ sessionId: label, requestId: `${label}-inbound`, text: 'please respond',
    options: { feishuConnectorAuthenticated: true, sourceContext: { connector: 'feishu', feishuProcessingReaction: true } },
    deliveryPlan: target(`thread-${label}`, { messageId: `${label}-inbound` }),
  })).record.deliveries[0];
  const b = await thinking('b');
  assert.equal(b.emojiType, 'THINKING');

  const requestRemoteLab = async (path, { body, signal } = {}) => {
    if (path.endsWith('/claim')) {
      activeClaims++;
      maxClaims = Math.max(maxClaims, activeClaims);
      try { return response({ claim: await claimSourceDeliveryWithWait({ ...body, signal }) }); }
      finally { activeClaims--; }
    }
    const [, id] = /source-deliveries\/([^/]+)\/complete$/.exec(path);
    if (id === a.id && rejectSlowReceipt) {
      acknowledging.resolve();
      await slowReceipt.promise;
      return { response: { ok: false }, json: { error: 'control-plane connection lost' } };
    }
    if (id === a.id) replayed++;
    return response({ delivery: await completeSourceDelivery(id, body.leaseId, body) });
  };
  const helpers = {
    requestRemoteLab, receiptReplayOptions: { onError() {} },
    sendFeishuAttachment: async (_runtime, summary) => {
      const label = summary.threadId.slice('thread-'.length);
      if (heldUploads.has(label)) {
        heldUploads.get(label).resolve();
        await releaseHeldUploads.promise;
        return { message_id: `file-${label}`, thread_id: summary.threadId };
      }
      assert.equal(label, 'a');
      sends.push('a-attachment'); uploading.resolve(); await slowUpload.promise;
      return { message_id: 'file-message', thread_id: 'thread-a' };
    },
    addProcessingReaction: async (_runtime, summary) => {
      assert.ok(reactionSent.has(summary.messageId));
      sends.push(`${summary.messageId[0]}-thinking`);
      reactionSent.get(summary.messageId).resolve();
      return { reactionId: 'thinking' };
    },
    sendFeishuText: async () => {
      sends.push('next-a'); nextSent.resolve(); return { message_id: 'next-message' };
    },
  };
  const first = runtime();
  poll = { runtime: first, done: startSourceDeliveryPoller(first, helpers) };
  // Five slow uploads are all live before B sends; a four-slot gate fails here.
  await within(Promise.all([uploading.promise, ...[...heldUploads.values()].map(held => held.promise),
    reactionSent.get('b-inbound').promise]));
  for (const delivery of heldDeliveries) assert.equal((await getSourceDelivery(delivery.id)).state, 'sending');
  assert.deepEqual(sends, ['a-attachment', 'b-thinking']);
  assert.equal((await getSourceDelivery(next.id)).state, 'pending', 'root and thread aliases preserve same-topic order');
  slowUpload.resolve();
  await within(acknowledging.promise);
  const cReaction = await thinking('c');
  await within(reactionSent.get('c-inbound').promise);
  assert.equal((await getSourceDelivery(next.id)).state, 'pending', 'same-topic later work waits for the receipt');
  stopSourceDeliveryPoller(first);
  slowReceipt.resolve();
  releaseHeldUploads.resolve();
  await within(poll.done);
  assert.equal(maxClaims, 1, 'only one long claim per Bot');
  assert.equal((await getSourceDelivery(b.id)).state, 'delivered');
  assert.equal((await getSourceDelivery(cReaction.id)).state, 'delivered');
  for (const delivery of heldDeliveries) assert.equal((await getSourceDelivery(delivery.id)).state, 'delivered');
  assert.equal((await getSourceDelivery(a.id)).state, 'sending');

  // A connector restarting after the provider accepted a file acknowledges the
  // saved receipt, never invoking the Feishu upload a second time.
  rejectSlowReceipt = false;
  await within(processSourceDeliveryOnce(runtime(), { ...helpers,
    receiptReplayOptions: { now: Date.now() + 60_000 },
    sendFeishuAttachment: async () => assert.fail('an accepted file must not upload again'),
  }));
  await within(nextSent.promise);
  assert.equal(replayed, 1);
  assert.deepEqual(sends, ['a-attachment', 'b-thinking', 'c-thinking', 'next-a']);
  assert.equal((await getSourceDelivery(next.id)).state, 'delivered');

  // A long poll blocked only by a previous Request must wake on that Request's
  // completion even when the completed Request has no pending parts of its own.
  const later = content => enqueueSourceDelivery({ sessionId: 'a', responseId: content, text: content, sourceDelivery: target('thread-a') });
  const c = await later('third-a');
  const d = await later('fourth-a');
  const args = { connector: 'feishu', sourceRouteId: route, waitMs: 20_000 };
  const third = await claimSourceDeliveryWithWait(args);
  assert.equal(third.delivery.id, c.id);
  const wait = new AbortController();
  const fourth = claimSourceDeliveryWithWait({ ...args, signal: wait.signal });
  try {
    await completeSourceDelivery(c.id, third.leaseId, { externalId: 'third' });
    assert.equal((await within(fourth)).delivery.id, d.id);
  } finally { wait.abort(); await fourth; }
  console.log('Feishu async delivery: five slow topics do not block a sixth; topic ordering, one long poll, receipt wake, and no resend after restart.');
} finally {
  if (poll) stopSourceDeliveryPoller(poll.runtime);
  slowUpload.resolve(); slowReceipt.resolve(); releaseHeldUploads.resolve();
  if (poll) await within(poll.done);
  await rm(root, { recursive: true, force: true });
}
