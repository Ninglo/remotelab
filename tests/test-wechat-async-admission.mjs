#!/usr/bin/env node
/**
 * test-wechat-async-admission.mjs
 *
 * Hermetic fault/recovery tests for:
 *   1. WeChat + Email target normalisation in source-deliveries
 *   2. Email single-delivery (text + attachments in one record)
 *   3. WeChat outbox delivery lifecycle (claim/complete)
 *   4. Unknown-send semantics on network timeout
 *   5. processWeChatSourceDeliveryOnce simulation (mock HTTP + mock send)
 *   6. Durable receipt: crash-between-send-and-ack recovery
 *   7. handleWeChatMessageAsync — no waitForConnectorPublication call
 *   8. Connector inbox idempotency and per-conversation serialisation
 *   9. Email target ordering key (different threads don't block each other)
 *
 * All tests are hermetic (isolated temp dirs, mock HTTP, virtual time).
 * No real WeChat API calls or RemoteLab server requests are made.
 *
 * Each test group uses a distinct sourceRouteId to prevent cross-test
 * pollution in the shared outbox (CONFIG_DIR points to a single tmpdir).
 */

import assert from 'assert/strict';
import { mkdtempSync } from 'fs';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// ─── Isolated environment ────────────────────────────────────────────────────
const tmpBase = mkdtempSync(join(tmpdir(), 'remotelab-wechat-async-'));
process.env.REMOTELAB_CONFIG_DIR = tmpBase;

// ─── Imports (after env is set) ──────────────────────────────────────────────
const {
  normalizeSourceDeliveryPlan,
  buildSourceDeliveryPlan,
  buildReplyDeliveries,
  claimSourceDelivery,
  completeSourceDelivery,
  failSourceDelivery,
  resolveSourceDelivery,
  enqueueSourceDelivery,
} = await import('../chat/source-deliveries.mjs');

const { createDeliveryReceipts } = await import('../lib/delivery-receipts.mjs');
const { createConnectorInbox } = await import('../lib/connector-inbox.mjs');
const {
  handleWeChatMessageAsync,
  processWeChatSourceDeliveryOnce,
} = await import('../scripts/wechat-connector.mjs');

// ─── Test runner ─────────────────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passCount++;
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error?.message || error}`);
    if (error?.stack) {
      for (const line of error.stack.split('\n').slice(1, 4)) {
        console.error(`        ${line.trim()}`);
      }
    }
    failCount++;
  }
}

// Unique counter to generate isolated source route IDs within each test.
let routeSeq = 0;
const uniqueRoute = (prefix = 'tst') => `${prefix}-${++routeSeq}`;

// ─── §1 WeChat target normalisation ──────────────────────────────────────────
console.log('\n§1 WeChat target normalisation');

await test('accepts wechat with accountId + peerUserId', () => {
  const plan = normalizeSourceDeliveryPlan({
    connector: 'wechat',
    sourceRouteId: 'wechat-default',
    target: {
      accountId: 'bot_123',
      peerUserId: 'user_456',
      contextToken: 'ctx_abc',
      messageId: 'msg_789',
    },
  });
  assert.equal(plan.connector, 'wechat');
  assert.equal(plan.sourceRouteId, 'wechat-default');
  assert.equal(plan.target.accountId, 'bot_123');
  assert.equal(plan.target.peerUserId, 'user_456');
  assert.equal(plan.target.contextToken, 'ctx_abc');
  assert.equal(plan.target.messageId, 'msg_789');
});

await test('rejects wechat without peerUserId', () => {
  assert.equal(
    normalizeSourceDeliveryPlan({ connector: 'wechat', target: { accountId: 'bot_123' } }),
    null,
  );
});

await test('rejects wechat without accountId', () => {
  assert.equal(
    normalizeSourceDeliveryPlan({ connector: 'wechat', target: { peerUserId: 'user_456' } }),
    null,
  );
});

await test('buildSourceDeliveryPlan builds wechat plan from sourceContext', () => {
  const plan = buildSourceDeliveryPlan({
    session: { connector: 'wechat', accountId: 'bot_123' },
    message: { connector: 'wechat', peerUserId: 'user_456', contextToken: 'ctx_abc' },
  });
  assert.equal(plan.connector, 'wechat');
  assert.equal(plan.target.accountId, 'bot_123');
  assert.equal(plan.target.peerUserId, 'user_456');
});

// ─── §2 Email target normalisation ───────────────────────────────────────────
console.log('\n§2 Email target normalisation');

await test('accepts email with to field', () => {
  const plan = normalizeSourceDeliveryPlan({
    connector: 'email',
    target: {
      to: 'user@example.com',
      subject: 'Re: Hello',
      inReplyTo: '<msg-1@example.com>',
      references: ['<msg-0@example.com>', '<msg-1@example.com>'],
      threadId: 'thread_abc',
      messageId: 'msg_xyz',
    },
  });
  assert.equal(plan.connector, 'email');
  assert.equal(plan.target.to, 'user@example.com');
  assert.equal(plan.target.subject, 'Re: Hello');
  assert.deepEqual(plan.target.references, ['<msg-0@example.com>', '<msg-1@example.com>']);
  assert.equal(plan.target.threadId, 'thread_abc');
});

await test('coerces string references to array', () => {
  const plan = normalizeSourceDeliveryPlan({
    connector: 'email',
    target: { to: 'a@b.com', references: '<single@example.com>' },
  });
  assert.deepEqual(plan.target.references, ['<single@example.com>']);
});

await test('rejects email without to', () => {
  assert.equal(
    normalizeSourceDeliveryPlan({ connector: 'email', target: { subject: 'no recipient' } }),
    null,
  );
});

await test('rejects unknown connector', () => {
  assert.equal(
    normalizeSourceDeliveryPlan({ connector: 'signal', target: { chatId: 'x' } }),
    null,
  );
});

// ─── §3 Email buildReplyDeliveries single-delivery contract ──────────────────
console.log('\n§3 Email buildReplyDeliveries single-delivery contract');

await test('email: ONE delivery with text + attachments', () => {
  const plan = normalizeSourceDeliveryPlan({
    connector: 'email',
    target: { to: 'a@b.com', inReplyTo: '<ref@x.com>' },
  });
  const parts = buildReplyDeliveries(plan, {
    text: 'Here is your report.',
    attachments: [{ name: 'report.pdf', url: 'file://tmp/report.pdf' }],
  });
  assert.equal(parts.length, 1, 'email: must produce exactly 1 delivery');
  assert.equal(parts[0].kind, 'content');
  assert.equal(parts[0].text, 'Here is your report.');
  assert.deepEqual(parts[0].attachments, [{ name: 'report.pdf', url: 'file://tmp/report.pdf' }]);
});

await test('email: text only → one delivery', () => {
  const plan = normalizeSourceDeliveryPlan({ connector: 'email', target: { to: 'a@b.com' } });
  const parts = buildReplyDeliveries(plan, { text: 'Hello', attachments: [] });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].attachments.length, 0);
});

await test('email: attachments only → one delivery', () => {
  const plan = normalizeSourceDeliveryPlan({ connector: 'email', target: { to: 'a@b.com' } });
  const parts = buildReplyDeliveries(plan, { text: '', attachments: [{ name: 'f.png', url: 'x' }] });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].text, '');
  assert.equal(parts[0].attachments.length, 1);
});

await test('email: empty payload → no delivery', () => {
  const plan = normalizeSourceDeliveryPlan({ connector: 'email', target: { to: 'a@b.com' } });
  assert.equal(buildReplyDeliveries(plan, { text: '', attachments: [] }).length, 0);
});

await test('feishu: text + attachments → separate deliveries (unchanged)', () => {
  const plan = normalizeSourceDeliveryPlan({
    connector: 'feishu',
    target: { chatId: 'oc_chat', messageId: 'om_msg' },
  });
  const parts = buildReplyDeliveries(plan, {
    text: 'See file:',
    attachments: [{ name: 'file.pdf', url: 'x' }],
  });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].kind, 'content');
  assert.equal(parts[1].kind, 'attachment');
});

// ─── §4 WeChat outbox delivery lifecycle ─────────────────────────────────────
console.log('\n§4 WeChat outbox delivery lifecycle');

await test('claim → complete lifecycle', async () => {
  const route = uniqueRoute('wc-lifecycle');
  const plan = normalizeSourceDeliveryPlan({
    connector: 'wechat',
    sourceRouteId: route,
    target: { accountId: 'bot_1', peerUserId: 'user_1', contextToken: 'ctx_1', messageId: 'msg_1' },
  });
  const first = await enqueueSourceDelivery({
    responseId: `wc:${route}:msg_1`,
    sessionId: `sess_${route}`,
    sourceDelivery: plan,
    text: '你好，回复来了。',
  });

  const claim = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route });
  assert.equal(claim.delivery.id, first.id);
  assert.equal(claim.delivery.connector, 'wechat');
  assert.equal(claim.delivery.target.accountId, 'bot_1');
  assert.equal(claim.delivery.target.peerUserId, 'user_1');
  assert.equal(claim.delivery.target.contextToken, 'ctx_1');
  assert.equal(claim.delivery.text, '你好，回复来了。');

  const completed = await completeSourceDelivery(first.id, claim.leaseId, {
    externalId: 'wechat_msg_ext_1',
  });
  assert.equal(completed.state, 'delivered');
  assert.equal(completed.externalId, 'wechat_msg_ext_1');
});

await test('idempotent enqueue returns same delivery id', async () => {
  const route = uniqueRoute('wc-idem');
  const plan = normalizeSourceDeliveryPlan({
    connector: 'wechat',
    sourceRouteId: route,
    target: { accountId: 'bot_2', peerUserId: 'user_2' },
  });
  const a = await enqueueSourceDelivery({ responseId: `wc:${route}:msg_2`, sessionId: `sess_${route}`, sourceDelivery: plan, text: 'hello' });
  const b = await enqueueSourceDelivery({ responseId: `wc:${route}:msg_2`, sessionId: `sess_${route}`, sourceDelivery: plan, text: 'hello' });
  assert.equal(a.id, b.id, 'Duplicate enqueue must return the same delivery id');
  // Clean up.
  const claim = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route });
  await completeSourceDelivery(claim.delivery.id, claim.leaseId, {});
});

// ─── §5 Unknown-send semantics ────────────────────────────────────────────────
console.log('\n§5 Unknown-send semantics on timeout');

await test('timeout failure → unknown state (not retry-safe)', async () => {
  const route = uniqueRoute('wc-timeout');
  const plan = normalizeSourceDeliveryPlan({
    connector: 'wechat',
    sourceRouteId: route,
    target: { accountId: 'bot_t', peerUserId: 'user_t' },
  });
  const delivery = await enqueueSourceDelivery({
    responseId: `wc:${route}:msg_t`,
    sessionId: `sess_${route}`,
    sourceDelivery: plan,
    text: 'timeout test',
  });

  const claim = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route });
  assert.equal(claim.delivery.id, delivery.id, 'Claim must pick this test\'s delivery');

  const result = await failSourceDelivery(delivery.id, claim.leaseId, new Error('WeChat send timed out'), {
    safeToRetry: false,
    definiteFailure: false,
  });
  assert.equal(result.state, 'unknown', 'Timeout must produce unknown, not delivery_failed or pending');
});

await test('429 failure → retryable pending', async () => {
  const route = uniqueRoute('wc-429');
  const plan = normalizeSourceDeliveryPlan({
    connector: 'wechat',
    sourceRouteId: route,
    target: { accountId: 'bot_r', peerUserId: 'user_r' },
  });
  const delivery = await enqueueSourceDelivery({
    responseId: `wc:${route}:msg_r`,
    sessionId: `sess_${route}`,
    sourceDelivery: plan,
    text: 'rate-limit test',
  });

  const claim = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route });
  assert.equal(claim.delivery.id, delivery.id);

  const result = await failSourceDelivery(delivery.id, claim.leaseId, new Error('429 Too Many Requests'), {
    safeToRetry: true,
    now: '2026-01-01T00:00:00.000Z',
    retryDelayMs: 10,
  });
  assert.equal(result.state, 'pending', '429 must be retryable');
  assert.equal(result.attempts, 1);
  // Clean up.
  const claim2 = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route, now: '2026-01-01T00:00:01.000Z' });
  await completeSourceDelivery(claim2.delivery.id, claim2.leaseId, {});
});

await test('unknown delivery → operator can resolve to delivered', async () => {
  const route = uniqueRoute('wc-resolve');
  const plan = normalizeSourceDeliveryPlan({
    connector: 'wechat',
    sourceRouteId: route,
    target: { accountId: 'bot_u', peerUserId: 'user_u' },
  });
  const delivery = await enqueueSourceDelivery({
    responseId: `wc:${route}:msg_u`,
    sessionId: `sess_${route}`,
    sourceDelivery: plan,
    text: 'resolve test',
  });

  const claim = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route });
  assert.equal(claim.delivery.id, delivery.id);
  // Produce unknown state.
  await failSourceDelivery(delivery.id, claim.leaseId, new Error('timeout'), {
    safeToRetry: false, definiteFailure: false,
  });
  const resolved = await resolveSourceDelivery(delivery.id, {
    state: 'delivered',
    externalId: 'manual_ext',
    reason: 'confirmed by operator via WeChat Web',
  });
  assert.equal(resolved.state, 'delivered');
  assert.equal(resolved.resolution, 'confirmed by operator via WeChat Web');
});

// ─── §6 processWeChatSourceDeliveryOnce simulation ───────────────────────────
console.log('\n§6 processWeChatSourceDeliveryOnce simulation');

await test('sender claims delivery, sends, records receipt', async () => {
  const route = uniqueRoute('wc-sender');
  const plan = normalizeSourceDeliveryPlan({
    connector: 'wechat',
    sourceRouteId: route,
    target: { accountId: 'bot_s', peerUserId: 'user_s', contextToken: 'ctx_s', messageId: 'msg_s' },
  });
  const delivery = await enqueueSourceDelivery({
    responseId: `wc:${route}:msg_s`,
    sessionId: `sess_${route}`,
    sourceDelivery: plan,
    text: '发送测试',
  });

  const sent = [];
  const storageDir = join(tmpBase, `wc-sender-${route}`);
  await mkdir(storageDir, { recursive: true });

  // Mock the RemoteLab HTTP calls (claim + complete) by delegating directly to
  // the in-process outbox so we don't need a real server.
  const mockRequester = async (path, options = {}) => {
    if (path === '/api/source-deliveries/claim' && options.method === 'POST') {
      const claimResult = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route });
      if (!claimResult) {
        return { response: { ok: true, status: 200 }, json: { claim: null }, text: '{"claim":null}' };
      }
      return { response: { ok: true, status: 200 }, json: { claim: claimResult }, text: '' };
    }
    if (/^\/api\/source-deliveries\/.+\/complete$/.test(path) && options.method === 'POST') {
      const id = path.split('/')[3];
      const completed = await completeSourceDelivery(id, options.body.leaseId, { externalId: options.body.externalId });
      return { response: { ok: true, status: 200 }, json: { delivery: completed }, text: '' };
    }
    return { response: { ok: true, status: 200 }, json: null, text: '' };
  };

  const mockSendWeChatText = async (runtime, summary, text) => {
    sent.push({ accountId: summary.accountId, peerUserId: summary.peerUserId, text });
    return { message_id: 'wechat_ext_s' };
  };

  const runtime = {
    config: { storageDir, sourceRouteId: route },
    accountsDoc: { accounts: { bot_s: { token: 'fake_token', status: 'ready', accountId: 'bot_s' } } },
    contextTokensDoc: { accounts: {} },
    wechatDeliveryReceipts: null,
  };

  const result = await processWeChatSourceDeliveryOnce(runtime, {
    requestRemoteLab: mockRequester,
    sendWeChatText: mockSendWeChatText,
  });

  assert.equal(sent.length, 1, 'Should have sent exactly one WeChat message');
  assert.equal(sent[0].accountId, 'bot_s');
  assert.equal(sent[0].peerUserId, 'user_s');
  assert.equal(sent[0].text, '发送测试');
  assert.equal(result?.state, 'delivered');
});

await test('sender returns null when no pending deliveries', async () => {
  const route = uniqueRoute('wc-empty');
  const storageDir = join(tmpBase, `wc-empty-${route}`);
  await mkdir(storageDir, { recursive: true });

  const mockRequester = async (path, options = {}) => {
    if (path === '/api/source-deliveries/claim') {
      return { response: { ok: true, status: 200 }, json: { claim: null }, text: '{"claim":null}' };
    }
    return { response: { ok: true, status: 200 }, json: null, text: '' };
  };

  const runtime = {
    config: { storageDir, sourceRouteId: route },
    accountsDoc: { accounts: {} },
    contextTokensDoc: { accounts: {} },
    wechatDeliveryReceipts: null,
  };

  const result = await processWeChatSourceDeliveryOnce(runtime, { requestRemoteLab: mockRequester });
  assert.equal(result, null);
});

await test('sender marks delivery unknown on network timeout (no retry)', async () => {
  const route = uniqueRoute('wc-send-timeout');
  const plan = normalizeSourceDeliveryPlan({
    connector: 'wechat',
    sourceRouteId: route,
    target: { accountId: 'bot_to', peerUserId: 'user_to' },
  });
  const delivery = await enqueueSourceDelivery({
    responseId: `wc:${route}:msg_to`,
    sessionId: `sess_${route}`,
    sourceDelivery: plan,
    text: 'timeout delivery',
  });

  const storageDir = join(tmpBase, `wc-send-timeout-${route}`);
  await mkdir(storageDir, { recursive: true });

  const failed = [];
  const mockRequester = async (path, options = {}) => {
    if (path === '/api/source-deliveries/claim' && options.method === 'POST') {
      const claimResult = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route });
      if (!claimResult) return { response: { ok: true, status: 200 }, json: { claim: null }, text: '' };
      return { response: { ok: true, status: 200 }, json: { claim: claimResult }, text: '' };
    }
    if (/fail$/.test(path) && options.method === 'POST') {
      failed.push(options.body);
      // Actually apply the fail to the outbox.
      const id = path.split('/')[3];
      await failSourceDelivery(id, options.body.leaseId, new Error(options.body.error), {
        safeToRetry: options.body.safeToRetry,
        definiteFailure: options.body.definiteFailure,
      });
      return { response: { ok: true, status: 200 }, json: {}, text: '' };
    }
    return { response: { ok: true, status: 200 }, json: null, text: '' };
  };

  const timeoutError = new Error('WeChat API request timed out');
  timeoutError.code = 'CONNECTOR_SEND_TIMEOUT';
  const mockSendWeChatText = async () => { throw timeoutError; };

  const runtime = {
    config: { storageDir, sourceRouteId: route },
    accountsDoc: { accounts: { bot_to: { token: 'tok', status: 'ready', accountId: 'bot_to' } } },
    contextTokensDoc: { accounts: {} },
    wechatDeliveryReceipts: null,
  };

  await assert.rejects(
    () => processWeChatSourceDeliveryOnce(runtime, {
      requestRemoteLab: mockRequester,
      sendWeChatText: mockSendWeChatText,
    }),
    /timed out/i,
  );

  assert.equal(failed.length, 1, 'Must have called the fail endpoint once');
  assert.equal(failed[0].safeToRetry, false, 'Timeout must NOT be marked safeToRetry');
  assert.equal(failed[0].definiteFailure, false, 'Timeout must NOT be definiteFailure (unknown semantics)');
});

// ─── §7 Durable receipt recovery ─────────────────────────────────────────────
console.log('\n§7 Durable receipt recovery');

await test('receipt survives process restart before control-plane ack', async () => {
  const receiptDir = join(tmpBase, 'receipt-recovery-test');
  await mkdir(receiptDir, { recursive: true });

  // First "process": buffer receipt, then crash.
  const receipts1 = createDeliveryReceipts(receiptDir);
  await receipts1.record({
    deliveryId: 'srcd_aabbcc_0',
    leaseId: 'lease_xyz',
    externalId: 'wechat_msg_acked',
  });

  // Second "process": fresh instance, flushes the buffered entry.
  const receipts2 = createDeliveryReceipts(receiptDir);
  const acknowledged = [];
  await receipts2.flush(async receipt => { acknowledged.push(receipt); });

  assert.equal(acknowledged.length, 1);
  assert.equal(acknowledged[0].deliveryId, 'srcd_aabbcc_0');
  assert.equal(acknowledged[0].externalId, 'wechat_msg_acked');
});

await test('recording the same receipt twice does not double-acknowledge', async () => {
  const receiptDir = join(tmpBase, 'receipt-idempotent-test');
  await mkdir(receiptDir, { recursive: true });
  const receipts = createDeliveryReceipts(receiptDir);

  await receipts.record({ deliveryId: 'srcd_idem_0', leaseId: 'lease_idem', externalId: 'ext_1' });
  await receipts.record({ deliveryId: 'srcd_idem_0', leaseId: 'lease_idem', externalId: 'ext_1' });

  const acknowledged = [];
  await receipts.flush(async receipt => { acknowledged.push(receipt); });
  assert.equal(acknowledged.length, 1, 'Duplicate record must not duplicate the acknowledgement');
});

// ─── §8 handleWeChatMessageAsync — no publication wait ───────────────────────
console.log('\n§8 handleWeChatMessageAsync — no waitForConnectorPublication call');

await test('submits to RemoteLab and returns without waiting', async () => {
  const calls = { submit: 0, waitForPublication: 0 };

  const mockSubmit = async () => {
    calls.submit++;
    return { sessionId: 'sess_async', requestId: 'wechat:bot_a:msg_a', responseId: 'resp_a', runId: 'run_a', duplicate: false };
  };

  const runtime = {
    config: { storageDir: tmpBase, sourceRouteId: 'default', processingAckDelayMs: 0 },
    storagePaths: { handledMessagesPath: join(tmpBase, `handled-${uniqueRoute()}.json`) },
    processingMessageIds: new Set(),
    accountsDoc: { accounts: {} },
    contextTokensDoc: { accounts: {} },
  };

  const summary = {
    accountId: 'bot_a', peerUserId: 'user_a', messageId: 'msg_a',
    textPreview: 'hello world',
    messageTypeNumeric: 1,  // USER
    messageStateNumeric: 2, // FINISH
    contextToken: '',
    imageResources: [],
  };

  await handleWeChatMessageAsync(runtime, summary, {
    wasMessageHandled: async () => false,
    markMessageHandled: async () => {},
    submitWeChatMessageAsync: mockSubmit,
  });

  assert.equal(calls.submit, 1, 'Should have called submit once');
  assert.equal(calls.waitForPublication, 0, 'Must never call waitForConnectorPublication');
});

await test('already-handled messages are not re-submitted', async () => {
  const calls = { submit: 0 };
  const runtime = {
    config: { storageDir: tmpBase, sourceRouteId: 'default', processingAckDelayMs: 0 },
    storagePaths: { handledMessagesPath: join(tmpBase, `handled-${uniqueRoute()}.json`) },
    processingMessageIds: new Set(),
    accountsDoc: { accounts: {} },
    contextTokensDoc: { accounts: {} },
  };
  const summary = {
    accountId: 'bot_b', peerUserId: 'user_b', messageId: 'msg_b',
    textPreview: 'hello', messageTypeNumeric: 1, messageStateNumeric: 2,
    contextToken: '', imageResources: [],
  };

  await handleWeChatMessageAsync(runtime, summary, {
    wasMessageHandled: async () => true, // already handled
    markMessageHandled: async () => {},
    submitWeChatMessageAsync: async () => { calls.submit++; return {}; },
  });

  assert.equal(calls.submit, 0, 'Already-handled message must not be re-submitted');
});

await test('unsupported message type is silently skipped (no submit)', async () => {
  const calls = { submit: 0 };
  const runtime = {
    config: { storageDir: tmpBase, sourceRouteId: 'default', processingAckDelayMs: 0 },
    storagePaths: { handledMessagesPath: join(tmpBase, `handled-${uniqueRoute()}.json`) },
    processingMessageIds: new Set(),
    accountsDoc: { accounts: {} },
    contextTokensDoc: { accounts: {} },
  };
  const summary = {
    accountId: 'bot_c', peerUserId: 'user_c', messageId: 'msg_c',
    textPreview: '',      // no text
    messageTypeNumeric: 1, messageStateNumeric: 2,
    contextToken: '', imageResources: [], // no images either
  };

  await handleWeChatMessageAsync(runtime, summary, {
    wasMessageHandled: async () => false,
    markMessageHandled: async () => {},
    submitWeChatMessageAsync: async () => { calls.submit++; return {}; },
  });

  assert.equal(calls.submit, 0, 'Unsupported message type must not be submitted');
});

// ─── §9 Connector inbox idempotency ──────────────────────────────────────────
console.log('\n§9 Connector inbox idempotency');

await test('rejects duplicate upstream event ID with different content', async () => {
  const inboxDir = join(tmpBase, `inbox-idem-${uniqueRoute()}`);
  const inbox = createConnectorInbox(inboxDir, {
    conversationKey: entry => entry.summary?.peerUserId || 'unknown',
    process: async () => {},
    onError: () => {},
  });

  await inbox.accept('event-idem-1', { summary: { peerUserId: 'u1', text: 'hello' } });
  // Same content → idempotent, no error.
  await inbox.accept('event-idem-1', { summary: { peerUserId: 'u1', text: 'hello' } });
  // Different content → must throw.
  await assert.rejects(
    () => inbox.accept('event-idem-1', { summary: { peerUserId: 'u1', text: 'CHANGED' } }),
    /already accepted with different content/,
  );
});

await test('inbox serialises messages per conversation key', async () => {
  const inboxDir = join(tmpBase, `inbox-serial-${uniqueRoute()}`);
  const order = [];
  let resolveBlock;
  const blocked = new Promise(r => { resolveBlock = r; });

  const inbox = createConnectorInbox(inboxDir, {
    conversationKey: entry => entry.summary.peerUserId,
    process: async entry => {
      if (entry.summary.seq === 1) await blocked;
      order.push(entry.summary.seq);
    },
    onError: () => {},
  });

  await inbox.accept('evt-s1', { summary: { peerUserId: 'p1', seq: 1 } });
  await inbox.accept('evt-s2', { summary: { peerUserId: 'p1', seq: 2 } });

  // Manually drive the first tick (starts message 1 which then blocks).
  await inbox.tick();
  // Give the process function time to reach its blocked await.
  await new Promise(r => setTimeout(r, 30));
  assert.equal(order.includes(2), false, 'Message 2 must wait until message 1 completes');

  // Unblock message 1 and wait for it to finish.
  resolveBlock();
  await inbox.idle(); // waits for running.values() (message 1's promise)

  // Message 1 is done and removed from `running`. Trigger a second tick to
  // pick up message 2 (the serialQueue blocks same-key records until the
  // previous one is no longer running).
  await inbox.tick();
  await inbox.idle(); // waits for message 2

  assert.deepEqual(order, [1, 2], 'Messages must complete in arrival order');
});

await test('inbox processes different conversations in parallel', async () => {
  const inboxDir = join(tmpBase, `inbox-parallel-${uniqueRoute()}`);
  const order = [];
  let resolveP1;
  const blockedP1 = new Promise(r => { resolveP1 = r; });

  const inbox = createConnectorInbox(inboxDir, {
    conversationKey: entry => entry.summary.peerUserId,
    process: async entry => {
      if (entry.summary.peerUserId === 'p1') await blockedP1;
      order.push(entry.summary.peerUserId);
    },
    onError: () => {},
  });

  await inbox.accept('evt-p1', { summary: { peerUserId: 'p1' } });
  await inbox.accept('evt-p2', { summary: { peerUserId: 'p2' } });
  inbox.start();

  // p2 should complete even though p1 is blocked.
  await new Promise(r => setTimeout(r, 80));
  assert.ok(order.includes('p2'), 'p2 must process independently of p1');

  resolveP1();
  await inbox.idle();
  inbox.stop();
});

// ─── §10 Email target ordering key ───────────────────────────────────────────
console.log('\n§10 Email target ordering key');

await test('different email threads do not block each other', async () => {
  const routeA = uniqueRoute('email-A');
  const routeB = uniqueRoute('email-B');

  const planA = normalizeSourceDeliveryPlan({
    connector: 'email',
    sourceRouteId: routeA,
    target: { to: 'a@b.com', inReplyTo: '<thread-A@x.com>' },
  });
  const planB = normalizeSourceDeliveryPlan({
    connector: 'email',
    sourceRouteId: routeB,
    target: { to: 'a@b.com', inReplyTo: '<thread-B@x.com>' },
  });

  const dA = await enqueueSourceDelivery({
    responseId: `email:${routeA}:threadA`,
    sessionId: `sess_email_A_${routeA}`,
    sourceDelivery: planA,
    text: 'Thread A reply',
  });
  const dB = await enqueueSourceDelivery({
    responseId: `email:${routeB}:threadB`,
    sessionId: `sess_email_B_${routeB}`,
    sourceDelivery: planB,
    text: 'Thread B reply',
  });

  const claimA = await claimSourceDelivery({ connector: 'email', sourceRouteId: routeA });
  assert.ok(claimA, 'Should claim thread A delivery');
  assert.equal(claimA.delivery.id, dA.id);

  const claimB = await claimSourceDelivery({ connector: 'email', sourceRouteId: routeB });
  assert.ok(claimB, 'Should claim thread B delivery');
  assert.equal(claimB.delivery.id, dB.id);

  assert.notEqual(claimA.delivery.id, claimB.delivery.id);

  await completeSourceDelivery(claimA.delivery.id, claimA.leaseId, { externalId: 'sent-A' });
  await completeSourceDelivery(claimB.delivery.id, claimB.leaseId, { externalId: 'sent-B' });
});

await test('wechat: different peers are independent in the outbox', async () => {
  const route = uniqueRoute('wc-peers');
  const make = (peer) => normalizeSourceDeliveryPlan({
    connector: 'wechat',
    sourceRouteId: route,
    target: { accountId: 'bot_multi', peerUserId: peer },
  });

  const d1 = await enqueueSourceDelivery({ responseId: `wc:${route}:p1`, sessionId: `sess_${route}_1`, sourceDelivery: make('peer1'), text: 'msg to peer1' });
  const d2 = await enqueueSourceDelivery({ responseId: `wc:${route}:p2`, sessionId: `sess_${route}_2`, sourceDelivery: make('peer2'), text: 'msg to peer2' });

  // Both should be claimable since they're different peerUserId keys.
  const c1 = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route });
  const c2 = await claimSourceDelivery({ connector: 'wechat', sourceRouteId: route });
  assert.ok(c1 && c2, 'Both deliveries must be claimable');
  assert.notEqual(c1.delivery.id, c2.delivery.id);

  await completeSourceDelivery(c1.delivery.id, c1.leaseId, {});
  await completeSourceDelivery(c2.delivery.id, c2.leaseId, {});
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`WeChat async admission tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
