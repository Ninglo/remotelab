#!/usr/bin/env node
/**
 * Hermetic tests for the Email / Agent Mailbox source-delivery system.
 *
 * Covers:
 *  1.  parseReferencesArray – RFC 2822 header parsing
 *  2.  buildEmailReplySubject – Re: prefix logic
 *  3.  resolveEmailReplyFromAddress – domain-matched alias
 *  4.  buildEmailSourceDeliveryTarget – target shape from mailbox item
 *  5.  buildEmailSourceDelivery – full sourceDelivery plan
 *  6.  buildEmailSourceRouteId – stable deterministic ID
 *  7.  from alias preserved through normalizeSourceDeliveryPlan (email connector)
 *  8.  processEmailSourceDeliveryOnce – no pending claim → null
 *  9.  processEmailSourceDeliveryOnce – single send, success → complete
 * 10.  processEmailSourceDeliveryOnce – network error → EXACTLY ONE send attempt, unknown state
 * 11.  processEmailSourceDeliveryOnce – definite server rejection → safeToRetry
 * 12.  processEmailSourceDeliveryOnce – durable receipt recovery after crash
 * 13.  startEmailSourceDeliveryPoller – stop clears interval
 * 14.  agent-mail-worker: new submissions add sourceDelivery in message, NOT session completionTargets
 * 15.  agent-mail-worker: explicit legacy completionTargets in automation are forwarded
 * 16.  dispatchSessionEmailCompletionTargets: skipped when run has durable email sourceDelivery
 * 17.  dispatchSessionEmailCompletionTargets: fires normally when no durable sourceDelivery exists
 */

import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import http from 'http';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-mail-source-delivery-'));
setIsolatedTestHome(tempHome);

const mailboxRoot = join(tempHome, '.config', 'remotelab', 'agent-mailbox');
mkdirSync(join(tempHome, '.config', 'remotelab'), { recursive: true });
writeFileSync(
  join(tempHome, '.config', 'remotelab', 'auth.json'),
  JSON.stringify({ token: 'test-token-1234567890abcdef1234567890abcdef12345678' }, null, 2),
);

const {
  buildEmailSourceDeliveryTarget,
  buildEmailSourceDelivery,
  buildEmailSourceRouteId,
  buildEmailReplySubject,
  parseReferencesArray,
  resolveEmailReplyFromAddress,
  EMAIL_CONNECTOR_ID,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mail-source-delivery.mjs')).href);

const {
  processEmailSourceDeliveryOnce,
  processEmailSourceDeliveryInProcess,
  startEmailSourceDeliveryInProcessPoller,
  startEmailSourceDeliveryPoller,
  updateMailboxItemForDelivery,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mail-source-delivery-sender.mjs')).href);

const {
  initializeMailbox,
  ingestRawMessage,
  saveMailboxAutomation,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href);

const {
  buildEmailBindingId,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-bindings.mjs')).href);

const {
  normalizeSourceDeliveryPlan,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'source-deliveries.mjs')).href);

const {
  createRemoteLabRuntime,
  runSweep,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'agent-mail-worker.mjs')).href);

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    id: 'item_001',
    identity: { address: 'bot@example.com' },
    message: {
      fromAddress: 'user@example.com',
      toAddress: 'bot@example.com',
      effectiveToAddress: '',
      envelopeToAddress: '',
      subject: 'hello world',
      messageId: '<msg001@example.com>',
      inReplyTo: '<root@example.com>',
      references: '<root@example.com>',
      replyReferences: '',
      date: '2026-01-01T00:00:00Z',
    },
    content: { extractedText: 'Hello from user', preview: '' },
    storage: { rawPath: '' },
    ...overrides,
  };
}

/** Minimal claim payload for a delivery. */
function makeClaimPayload(overrides = {}) {
  return {
    leaseId: 'lease_abc123',
    delivery: {
      id: 'srcd_aabbccddee001122334455_0',
      responseId: 'resp_001',
      text: 'Hello from the AI',
      attachments: [],
      target: {
        to: 'user@example.com',
        from: 'bot@example.com',
        subject: 'Re: hello',
        inReplyTo: '<msg@example.com>',
        references: ['<msg@example.com>'],
        messageId: '<msg@example.com>',
        threadId: '<msg@example.com>',
      },
      ...overrides,
    },
  };
}

/** Stub receipts that flush immediately. */
function makeReceipts() {
  const pending = [];
  return {
    pending,
    flush: async (fn) => {
      for (const r of pending.splice(0)) await fn(r);
    },
    record: async (receipt) => pending.push(receipt),
  };
}

let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => { passed++; console.log(`  ok: ${name}`); })
        .catch((err) => { failed++; errors.push({ name, err }); console.error(`  FAIL: ${name}\n    ${err?.message}`); });
    }
    passed++;
    console.log(`  ok: ${name}`);
  } catch (err) {
    failed++;
    errors.push({ name, err });
    console.error(`  FAIL: ${name}\n    ${err?.message}`);
  }
}

// ─── 1. parseReferencesArray ──────────────────────────────────────────────────
await test('parseReferencesArray: empty string returns []', () => {
  assert.deepEqual(parseReferencesArray(''), []);
});
await test('parseReferencesArray: single ID', () => {
  assert.deepEqual(parseReferencesArray('<foo@bar>'), ['<foo@bar>']);
});
await test('parseReferencesArray: multiple IDs deduplicated', () => {
  assert.deepEqual(parseReferencesArray('<a@b> <c@d> <a@b>'), ['<a@b>', '<c@d>']);
});
await test('parseReferencesArray: whitespace-only returns []', () => {
  assert.deepEqual(parseReferencesArray('   '), []);
});

// ─── 2. buildEmailReplySubject ────────────────────────────────────────────────
await test('buildEmailReplySubject: adds Re: prefix', () => {
  assert.equal(buildEmailReplySubject('Hello'), 'Re: Hello');
});
await test('buildEmailReplySubject: does not double-add Re:', () => {
  assert.equal(buildEmailReplySubject('Re: Hello'), 'Re: Hello');
});
await test('buildEmailReplySubject: case-insensitive Re: detection', () => {
  assert.equal(buildEmailReplySubject('RE: Hello'), 'RE: Hello');
});
await test('buildEmailReplySubject: empty returns empty', () => {
  assert.equal(buildEmailReplySubject(''), '');
});

// ─── 3. resolveEmailReplyFromAddress ──────────────────────────────────────────
await test('resolveEmailReplyFromAddress: same-domain alias preserved', () => {
  const item = makeItem({ identity: { address: 'bot@example.com' }, message: { ...makeItem().message, effectiveToAddress: 'bot+alias@example.com' } });
  assert.equal(resolveEmailReplyFromAddress(item), 'bot+alias@example.com');
});
await test('resolveEmailReplyFromAddress: different domain returns empty', () => {
  const item = makeItem({ identity: { address: 'bot@example.com' }, message: { ...makeItem().message, effectiveToAddress: 'bot@other.com' } });
  assert.equal(resolveEmailReplyFromAddress(item), '');
});
await test('resolveEmailReplyFromAddress: falls back to toAddress', () => {
  const item = makeItem({ identity: { address: 'bot@example.com' }, message: { ...makeItem().message, effectiveToAddress: '', envelopeToAddress: '', toAddress: 'bot@example.com' } });
  assert.equal(resolveEmailReplyFromAddress(item), 'bot@example.com');
});

// ─── 4. buildEmailSourceDeliveryTarget ───────────────────────────────────────
await test('buildEmailSourceDeliveryTarget: basic shape', () => {
  const target = buildEmailSourceDeliveryTarget(makeItem());
  assert.equal(target.to, 'user@example.com');
  assert.equal(target.subject, 'Re: hello world');
  assert.equal(target.inReplyTo, '<msg001@example.com>');
  assert.equal(target.messageId, '<msg001@example.com>');
  assert(Array.isArray(target.references));
  assert(target.references.includes('<root@example.com>'));
  assert(target.references.includes('<msg001@example.com>'));
});
await test('buildEmailSourceDeliveryTarget: references always array', () => {
  const item = makeItem({ message: { ...makeItem().message, references: '', inReplyTo: '', messageId: '<solo@x.com>' } });
  assert(Array.isArray(buildEmailSourceDeliveryTarget(item).references));
});
await test('buildEmailSourceDeliveryTarget: threadId is earliest reference', () => {
  const target = buildEmailSourceDeliveryTarget(makeItem());
  assert.equal(target.threadId, target.references[0]);
});

// ─── 5 & 6. buildEmailSourceDelivery / buildEmailSourceRouteId ────────────────
await test('buildEmailSourceDelivery: connector is email', () => {
  const plan = buildEmailSourceDelivery('route_abc', { to: 'a@b.com', subject: 'hi', inReplyTo: '', references: [], messageId: '', threadId: '' });
  assert.equal(plan.connector, EMAIL_CONNECTOR_ID);
  assert.equal(plan.connector, 'email');
  assert.equal(plan.sourceRouteId, 'route_abc');
  assert.equal(plan.target.to, 'a@b.com');
});
await test('buildEmailSourceRouteId: matches buildEmailBindingId', () => {
  const id = buildEmailSourceRouteId('/some/path');
  assert.equal(id, buildEmailBindingId('/some/path'));
  assert.match(id, /^binding_email_[a-f0-9]+$/);
});

// ─── 7. from alias preserved through normalizeSourceDeliveryPlan ──────────────
await test('from alias preserved through normalizeSourceDeliveryPlan (email connector)', () => {
  const plan = normalizeSourceDeliveryPlan({
    connector: 'email',
    sourceRouteId: 'route_1',
    target: {
      to: 'user@example.com',
      from: 'bot+alias@example.com',
      subject: 'Re: test',
      inReplyTo: '<msg@example.com>',
      references: ['<msg@example.com>'],
    },
  });
  assert.ok(plan, 'normalizeSourceDeliveryPlan should accept email connector');
  assert.equal(plan?.connector, 'email');
  assert.equal(plan?.target?.from, 'bot+alias@example.com',
    'from field should be preserved through normalizeTarget for email connector');
  assert.deepEqual(plan?.target?.references, ['<msg@example.com>'],
    'references array should be preserved as array');
});

// ─── initialize mailbox for sender tests ─────────────────────────────────────
await initializeMailbox({
  rootDir: mailboxRoot,
  name: 'Bot',
  localPart: 'bot',
  domain: 'example.com',
  allowEmails: ['user@example.com'],
});

// ─── 8. processEmailSourceDeliveryOnce – no pending claim ─────────────────────
await test('processEmailSourceDeliveryOnce: returns null when no claim', async () => {
  const calls = [];
  const requestRemoteLab = async (path, opts) => {
    calls.push({ path, body: opts?.body });
    if (path === '/api/source-deliveries/claim') {
      return { response: { ok: true }, json: { claim: null } };
    }
    return { response: { ok: true }, json: {} };
  };
  const result = await processEmailSourceDeliveryOnce({
    requestRemoteLab,
    sourceRouteId: buildEmailSourceRouteId(mailboxRoot),
    mailboxRoot,
    receipts: makeReceipts(),
  });
  assert.equal(result, null);
  const claimCall = calls.find((c) => c.path === '/api/source-deliveries/claim');
  assert.ok(claimCall, 'should have called /api/source-deliveries/claim');
  assert.equal(claimCall.body.connector, 'email');
});

// ─── 9. processEmailSourceDeliveryOnce – successful send ──────────────────────
await test('processEmailSourceDeliveryOnce: single send attempt on success → complete', async () => {
  const calls = [];
  const sentMessages = [];

  const requestRemoteLab = async (path, opts) => {
    calls.push({ path, body: opts?.body });
    if (path === '/api/source-deliveries/claim') {
      return { response: { ok: true }, json: { claim: makeClaimPayload() } };
    }
    if (path.includes('/complete')) {
      return { response: { ok: true }, json: { delivery: { state: 'delivered' } } };
    }
    return { response: { ok: true }, json: {} };
  };

  const sendOutboundEmailImpl = async (params) => {
    sentMessages.push(params);
    return { id: 'ext_001' };
  };

  const receipts = makeReceipts();
  const result = await processEmailSourceDeliveryOnce({
    requestRemoteLab,
    sourceRouteId: buildEmailSourceRouteId(mailboxRoot),
    mailboxRoot,
    receipts,
    sendOutboundEmailImpl,
  });

  assert.ok(result !== null, 'should return a delivery result');
  assert.equal(sentMessages.length, 1, 'exactly ONE send call');
  assert.equal(sentMessages[0].to, 'user@example.com');
  assert.equal(sentMessages[0].subject, 'Re: hello');
  assert.equal(sentMessages[0].inReplyTo, '<msg@example.com>');
  const completeCall = calls.find((c) => c.path.includes('/complete'));
  assert.ok(completeCall, 'should have called /complete');
  assert.equal(completeCall.body.leaseId, 'lease_abc123');
});

// ─── 10. processEmailSourceDeliveryOnce – network error → unknown, exactly 1 send
await test('processEmailSourceDeliveryOnce: network error → exactly ONE send attempt → unknown state (no safeToRetry)', async () => {
  const calls = [];
  let sendCallCount = 0;

  const requestRemoteLab = async (path, opts) => {
    calls.push({ path, body: opts?.body });
    if (path === '/api/source-deliveries/claim') {
      return { response: { ok: true }, json: { claim: makeClaimPayload() } };
    }
    return { response: { ok: true }, json: {} };
  };

  // Simulate a network-level error that the transport marks as retryable
  const sendOutboundEmailImpl = async () => {
    sendCallCount++;
    const err = new Error('connect ECONNRESET');
    err.code = 'ECONNRESET';
    err.retryable = true; // transport flag for network errors
    throw err;
  };

  const result = await processEmailSourceDeliveryOnce({
    requestRemoteLab,
    sourceRouteId: buildEmailSourceRouteId(mailboxRoot),
    mailboxRoot,
    receipts: makeReceipts(),
    sendOutboundEmailImpl,
  });

  // Exactly one send attempt — no internal retries
  assert.equal(sendCallCount, 1, 'exactly ONE send attempt for network error');
  assert.equal(result, null);

  const failCall = calls.find((c) => c.path.includes('/fail'));
  assert.ok(failCall, 'should have called /fail endpoint');
  assert.equal(failCall.body.leaseId, 'lease_abc123');
  // Must NOT set safeToRetry or definiteFailure — omitting both yields 'unknown' state
  assert.notEqual(failCall.body.safeToRetry, true,
    'network-ambiguous failure must NOT set safeToRetry (would cause duplicate send)');
  assert.notEqual(failCall.body.definiteFailure, true,
    'network-ambiguous failure must NOT set definiteFailure');

  // Confirm no /complete call was made
  const completeCall = calls.find((c) => c.path.includes('/complete'));
  assert.ok(!completeCall, 'should NOT have called /complete for a failed send');
});

// ─── 11. processEmailSourceDeliveryOnce – definite rejection → safeToRetry
await test('processEmailSourceDeliveryOnce: definite server rejection → safeToRetry=true', async () => {
  const calls = [];

  const requestRemoteLab = async (path, opts) => {
    calls.push({ path, body: opts?.body });
    if (path === '/api/source-deliveries/claim') {
      return { response: { ok: true }, json: { claim: makeClaimPayload() } };
    }
    return { response: { ok: true }, json: {} };
  };

  // HTTP-level rejection: server responded with a status code.
  // createOutboundError (in agent-mail-outbound.mjs) sets retryable=false
  // when statusCode is an integer, so normalizeConnectorSendResult sees
  // retryable=false → definite rejection.
  const sendOutboundEmailImpl = async () => {
    const err = new Error('422 Unprocessable Entity: invalid recipient address');
    err.statusCode = 422; // marks this as an HTTP-level (non-ambiguous) rejection
    err.retryable = false; // set explicitly, matching createOutboundError behaviour
    throw err;
  };

  const result = await processEmailSourceDeliveryOnce({
    requestRemoteLab,
    sourceRouteId: buildEmailSourceRouteId(mailboxRoot),
    mailboxRoot,
    receipts: makeReceipts(),
    sendOutboundEmailImpl,
  });

  assert.equal(result, null);
  const failCall = calls.find((c) => c.path.includes('/fail'));
  assert.ok(failCall, 'should have called /fail endpoint');
  // Definite rejection: server confirmed it did NOT accept the message → safe to retry
  assert.equal(failCall.body.safeToRetry, true,
    'definite server rejection should set safeToRetry=true');
  assert.ok(failCall.body.maxAttempts > 0, 'should specify maxAttempts');
});

// ─── 12. processEmailSourceDeliveryOnce – durable receipt recovery ─────────────
await test('processEmailSourceDeliveryOnce: flushes pending receipts before claiming', async () => {
  const calls = [];
  let flushedCount = 0;

  const requestRemoteLab = async (path, opts) => {
    calls.push({ path, body: opts?.body });
    if (path === '/api/source-deliveries/claim') {
      return { response: { ok: true }, json: { claim: null } };
    }
    if (path.includes('/complete')) {
      flushedCount++;
      return { response: { ok: true }, json: { delivery: { state: 'delivered' } } };
    }
    return { response: { ok: true }, json: {} };
  };

  const oldReceipt = { deliveryId: 'srcd_old_delivery', leaseId: 'lease_old', externalId: 'ext_prev' };
  const receipts = {
    pending: [oldReceipt],
    flush: async (fn) => { for (const r of receipts.pending.splice(0)) await fn(r); },
    record: async (receipt) => receipts.pending.push(receipt),
  };

  await processEmailSourceDeliveryOnce({
    requestRemoteLab,
    sourceRouteId: 'route_test',
    mailboxRoot,
    receipts,
    sendOutboundEmailImpl: async () => ({ id: 'ok' }),
  });

  assert.equal(flushedCount, 1, 'should have flushed the pending receipt');
  const completeCall = calls.find((c) => c.path.includes('/complete'));
  assert.ok(completeCall, 'should have called /complete for pending receipt');
  assert.equal(completeCall.body.leaseId, 'lease_old');
  assert.equal(completeCall.body.externalId, 'ext_prev');
});

// ─── 13. startEmailSourceDeliveryPoller – stop works ─────────────────────────
await test('startEmailSourceDeliveryPoller: stop clears interval', async () => {
  let callCount = 0;
  const requestRemoteLab = async (path) => {
    callCount++;
    if (path === '/api/source-deliveries/claim') return { response: { ok: true }, json: { claim: null } };
    return { response: { ok: true }, json: {} };
  };

  const poller = startEmailSourceDeliveryPoller({
    requestRemoteLab,
    sourceRouteId: 'route_test',
    mailboxRoot,
    receipts: makeReceipts(),
    sendOutboundEmailImpl: async () => ({ id: 'ok' }),
    pollMs: 50,
  });
  await new Promise((r) => setTimeout(r, 130));
  poller.stop();
  const countAtStop = callCount;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(countAtStop > 0, 'should have polled at least once');
  assert.equal(callCount, countAtStop, 'should not poll after stop');
});

// ─── 14. agent-mail-worker: sourceDelivery in message, NOT session completionTargets
await test('agent-mail-worker: new submissions use sourceDelivery in message payload, not session completionTargets', async () => {
  const workerMailboxRoot = join(mkdtempSync(join(tmpdir(), 'remotelab-sd-worker-')), 'mailbox');
  mkdirSync(workerMailboxRoot, { recursive: true });

  await initializeMailbox({
    rootDir: workerMailboxRoot,
    name: 'Bot',
    localPart: 'bot',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
  });

  const sessionCreates = [];
  const messageSubmissions = [];
  const deliveryClaims = [];

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    if (req.method === 'GET' && req.url?.startsWith('/?token=')) {
      res.writeHead(302, { Location: '/', 'Set-Cookie': 'session_token=test; Path=/' });
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sessions') {
      sessionCreates.push(JSON.parse(body || '{}'));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: { id: 'sess_sd_1' } }));
      return;
    }
    if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/messages$/.test(req.url || '')) {
      messageSubmissions.push(JSON.parse(body || '{}'));
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ run: { id: 'run_sd_1' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/source-deliveries/claim') {
      deliveryClaims.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ claim: null }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    await saveMailboxAutomation(workerMailboxRoot, {
      allowlistAutoApprove: true,
      chatBaseUrl: `http://127.0.0.1:${port}`,
      session: { folder: '~', tool: 'claude', description: 'Test', systemPrompt: 'Reply.' },
    });
    await ingestRawMessage(
      ['From: owner@example.com', 'To: bot@example.com', 'Subject: test sd', 'Message-ID: <sd-test@example.com>', 'Content-Type: text/plain', '', 'test source delivery'].join('\n'),
      'sd.eml', workerMailboxRoot, { text: 'test source delivery' },
    );

    const runtime = createRemoteLabRuntime(`http://127.0.0.1:${port}`, {});
    runtime.readOwnerToken = async () => 'test-token-1234567890abcdef1234567890abcdef12345678';
    await runSweep({ rootDir: workerMailboxRoot, baseUrl: `http://127.0.0.1:${port}`, runtime });

    assert.equal(sessionCreates.length, 1);
    // Session must NOT have worker-added email completionTargets
    const emailCTs = (sessionCreates[0].completionTargets || []).filter((t) => t.type === 'email' || t.kind === 'email');
    assert.equal(emailCTs.length, 0, 'session should NOT have email completionTargets from worker');

    assert.equal(messageSubmissions.length, 1);
    const sd = messageSubmissions[0].sourceDelivery;
    assert.ok(sd, 'message should include sourceDelivery');
    assert.equal(sd.connector, 'email');
    assert.ok(sd.sourceRouteId, 'sourceDelivery must have sourceRouteId');
    assert.equal(sd.target.to, 'owner@example.com');
    assert.equal(sd.target.subject, 'Re: test sd');
    assert.equal(sd.target.inReplyTo, '<sd-test@example.com>');
    assert(Array.isArray(sd.target.references), 'references must be an array');

    assert.ok(deliveryClaims.length > 0, 'delivery sender must poll /api/source-deliveries/claim');
    assert.equal(deliveryClaims[0].connector, 'email');
  } finally {
    server.close();
  }
});

// ─── 15. agent-mail-worker: explicit automation completionTargets forwarded ────
await test('agent-mail-worker: explicit legacy completionTargets in automation are forwarded to session', async () => {
  const workerMR2 = join(mkdtempSync(join(tmpdir(), 'remotelab-sd-legacy-')), 'mailbox');
  mkdirSync(workerMR2, { recursive: true });
  await initializeMailbox({ rootDir: workerMR2, name: 'Bot2', localPart: 'bot2', domain: 'example.com', allowEmails: ['owner@example.com'] });

  const sessionCreates2 = [];
  const server2 = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    if (req.method === 'GET' && req.url?.startsWith('/?token=')) { res.writeHead(302, { Location: '/', 'Set-Cookie': 'session_token=t; Path=/' }); res.end(); return; }
    if (req.method === 'POST' && req.url === '/api/sessions') { sessionCreates2.push(JSON.parse(body || '{}')); res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ session: { id: 'sess_l_1' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ run: { id: 'r1' }, claim: null }));
  });
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  const { port: port2 } = server2.address();
  try {
    await saveMailboxAutomation(workerMR2, {
      allowlistAutoApprove: true, chatBaseUrl: `http://127.0.0.1:${port2}`,
      session: {
        folder: '~', tool: 'claude', description: 'Test', systemPrompt: '.',
        // Explicit legacy completionTargets (e.g. calendar)
        completionTargets: [{ type: 'calendar', title: 'Meeting', id: 'cal_1', enabled: true }],
      },
    });
    await ingestRawMessage(
      ['From: owner@example.com', 'To: bot2@example.com', 'Subject: legacy ct', 'Message-ID: <lct@example.com>', 'Content-Type: text/plain', '', 'legacy ct test'].join('\n'),
      'lct.eml', workerMR2, { text: 'legacy ct test' },
    );
    const runtime2 = createRemoteLabRuntime(`http://127.0.0.1:${port2}`, {});
    runtime2.readOwnerToken = async () => 'test-token-1234567890abcdef1234567890abcdef12345678';
    await runSweep({ rootDir: workerMR2, baseUrl: `http://127.0.0.1:${port2}`, runtime: runtime2 });
    assert.equal(sessionCreates2.length, 1);
    const calCT = (sessionCreates2[0].completionTargets || []).find((t) => t.type === 'calendar');
    assert.ok(calCT, 'explicit calendar completionTarget should be forwarded to session');
  } finally {
    server2.close();
  }
});

// ─── 16. dispatchSessionEmailCompletionTargets: skipped when sourceDelivery exists
await test('dispatchSessionEmailCompletionTargets: skipped when run has durable email sourceDelivery', async () => {
  // Set up a minimal test env with isolated CONFIG_DIR for requests store
  const sdEnvHome = mkdtempSync(join(tmpdir(), 'remotelab-sd-ct-skip-'));
  process.env.REMOTELAB_CONFIG_DIR = join(sdEnvHome, 'config');
  mkdirSync(process.env.REMOTELAB_CONFIG_DIR, { recursive: true });

  const { enqueueSourceDelivery, normalizeSourceDeliveryPlan: normPlan } = await import(
    pathToFileURL(join(repoRoot, 'chat', 'source-deliveries.mjs')).href + `?t=${Date.now()}`
  );
  const { dispatchSessionEmailCompletionTargets } = await import(
    pathToFileURL(join(repoRoot, 'lib', 'agent-mail-completion-targets.mjs')).href + `?t=${Date.now()}`
  );

  // Create a source-delivery record that links to a fake run/response.
  const responseId = 'resp_sd_skip_001';
  const plan = normPlan({ connector: 'email', sourceRouteId: 'route_skip', target: { to: 'user@example.com', subject: 'Re: skip', inReplyTo: '<x@x.com>', references: ['<x@x.com>'] } });
  await enqueueSourceDelivery({ responseId, sessionId: 'sess_skip', text: 'AI reply', sourceDelivery: plan });

  const dispatchCalls = [];
  // dispatchSessionEmailCompletionTargets needs a session and run with matching responseId.
  // We build a fake run record. Since byRunId won't find it in this isolated store,
  // pass a run whose requestId is used to look up deliveries.
  // Actually the skip is based on requests.byRunId returning deliveries.
  // In this isolated env, the request store is empty, so byRunId returns null →
  // requestDeliveries = [] → completionTarget FIRES (this is the normal-no-sourceDelivery path).
  //
  // To test the SKIP path, we need a request record that has email deliveries.
  // Use requests.accept to create one.
  const { requests } = await import(pathToFileURL(join(repoRoot, 'chat', 'requests.mjs')).href + `?t=${Date.now()}`);
  await requests.accept({
    sessionId: 'sess_skip2',
    requestId: 'req_sd_skip_002',
    text: 'hi',
    options: { sourceDelivery: { connector: 'email', sourceRouteId: 'route_skip', target: { to: 'user@example.com' } } },
    result: { state: 'completed', payload: { text: 'AI reply', attachments: [] } },
    plans: [{ connector: 'email', sourceRouteId: 'route_skip', kind: 'content', text: 'AI reply', attachments: [], target: { to: 'user@example.com' } }],
  });

  const records = await requests.active();
  const r = records.find((rec) => rec.requestId === 'req_sd_skip_002');
  assert.ok(r, 'request record should have been created');
  assert.ok(r.deliveries?.some((d) => d.connector === 'email'), 'request should have email delivery');

  // Now simulate dispatchSessionEmailCompletionTargets for that run
  const fakeRun = { id: r.runId, requestId: r.requestId, responseId: r.responseId, state: 'completed', completionTargets: {} };
  const fakeSession = {
    id: 'sess_skip2',
    completionTargets: [{
      id: 'ct_email_01', type: 'email', enabled: true,
      requestId: r.requestId, responseId: r.responseId,
      to: 'user@example.com', subject: 'Re: skip', inReplyTo: '<x@x.com>', references: '<x@x.com>',
      bindingId: '', mailboxRoot: '', mailboxItemId: '',
    }],
  };

  const results = await dispatchSessionEmailCompletionTargets(fakeSession, fakeRun, {
    sendOutboundEmailImpl: async () => { dispatchCalls.push('sent'); return { id: 'ext' }; },
  });

  assert.equal(dispatchCalls.length, 0,
    'completionTarget dispatch should be SKIPPED when run has a durable email sourceDelivery');
  assert.equal(results.length, 0,
    'dispatchSessionEmailCompletionTargets should return empty results when skipped');

  delete process.env.REMOTELAB_CONFIG_DIR;
});

// ─── 17. dispatchSessionEmailCompletionTargets: fires normally without sourceDelivery
await test('dispatchSessionEmailCompletionTargets: fires when run has NO durable email sourceDelivery', async () => {
  const noSdHome = mkdtempSync(join(tmpdir(), 'remotelab-sd-ct-fire-'));
  process.env.REMOTELAB_CONFIG_DIR = join(noSdHome, 'config');
  mkdirSync(process.env.REMOTELAB_CONFIG_DIR, { recursive: true });

  const noSdMailboxRoot = join(noSdHome, 'mailbox');
  mkdirSync(noSdMailboxRoot, { recursive: true });

  const { dispatchSessionEmailCompletionTargets: dispatchFire } = await import(
    pathToFileURL(join(repoRoot, 'lib', 'agent-mail-completion-targets.mjs')).href + `?t=${Date.now()}`
  );
  const { requests: reqsFire } = await import(
    pathToFileURL(join(repoRoot, 'chat', 'requests.mjs')).href + `?t=${Date.now()}`
  );

  // Accept a request with NO email source-delivery plans
  await reqsFire.accept({
    sessionId: 'sess_fire',
    requestId: 'req_fire_001',
    text: 'hi',
    options: {},
    result: { state: 'completed', payload: { text: 'reply', attachments: [] } },
    plans: [],
  });
  const records = await reqsFire.active();
  const rFire = records.find((rec) => rec.requestId === 'req_fire_001');
  assert.ok(rFire);

  // Initialize a minimal mailbox so the binding resolves
  await initializeMailbox({ rootDir: noSdMailboxRoot, name: 'FireBot', localPart: 'firebot', domain: 'example.com', allowEmails: ['user@example.com'] });
  const { ensureEmailConnectorBinding: ensureB } = await import(
    pathToFileURL(join(repoRoot, 'lib', 'connector-bindings.mjs')).href + `?t=${Date.now()}`
  );
  await ensureB({ rootDir: noSdMailboxRoot });

  const dispatchCalls2 = [];
  const fakeRun2 = { id: rFire.runId, requestId: rFire.requestId, responseId: rFire.responseId, state: 'completed', completionTargets: {} };
  const fakeSession2 = {
    id: 'sess_fire',
    completionTargets: [{
      id: 'ct_fire_email', type: 'email', enabled: true,
      requestId: rFire.requestId, responseId: rFire.responseId,
      to: 'user@example.com', subject: 'Re: fire', inReplyTo: '<f@example.com>', references: '<f@example.com>',
      bindingId: buildEmailBindingId(noSdMailboxRoot),
      mailboxRoot: noSdMailboxRoot, mailboxItemId: '',
    }],
  };

  // We need a real session and run in history for resolveAssistantReply.
  // Use a minimal stub that returns content without hitting the full history stack.
  const { createSession } = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href + `?t=${Date.now()}`);
  const { appendEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href + `?t=${Date.now()}`);
  const { messageEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href + `?t=${Date.now()}`);

  const sess2 = await createSession(noSdHome, 'claude', 'fire-test', {});
  fakeSession2.id = sess2.id;
  fakeRun2.requestId = rFire.requestId;
  fakeRun2.responseId = rFire.responseId;

  // Append an assistant message the completion target will find
  await appendEvent(sess2.id, {
    ...messageEvent('assistant', 'Fire reply'),
    runId: fakeRun2.id,
    requestId: fakeRun2.requestId,
  });

  const results2 = await dispatchFire(fakeSession2, fakeRun2, {
    sendOutboundEmailImpl: async (params) => { dispatchCalls2.push(params); return { id: 'ext_fire' }; },
    connectorDriverMaxAttempts: 1,
  });

  // The completionTarget should have fired (no durable email delivery to block it)
  // It may succeed or fail (binding may not have outbound config), but it should NOT be skipped.
  // The key assertion: it was attempted, not silently skipped.
  const wasAttempted = dispatchCalls2.length > 0 || results2.length > 0;
  assert.ok(wasAttempted, 'completionTarget should be attempted when no durable sourceDelivery exists');

  delete process.env.REMOTELAB_CONFIG_DIR;
});

// ─── 18. durable prepared session: HTTP-loss / crash recovery ─────────────────
await test('agent-mail-worker: preparedSessionId persisted; crash-after-session does not duplicate session', async () => {
  const durHome = mkdtempSync(join(tmpdir(), 'remotelab-durable-submit-'));
  const durMailboxRoot = join(durHome, 'mailbox');
  mkdirSync(durMailboxRoot, { recursive: true });
  mkdirSync(join(durHome, '.config', 'remotelab'), { recursive: true });
  writeFileSync(join(durHome, '.config', 'remotelab', 'auth.json'), JSON.stringify({ token: 'tok-durable-1234567890abcdef1234567890abcdef1234' }));

  await initializeMailbox({ rootDir: durMailboxRoot, name: 'Dur', localPart: 'dur', domain: 'example.com', allowEmails: ['user@example.com'] });

  const sessionCreates18 = [];
  const messageSubmits18 = [];
  let failFirst18 = true;

  const server18 = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    if (req.method === 'GET' && req.url?.startsWith('/?token=')) {
      res.writeHead(302, { Location: '/', 'Set-Cookie': 'session_token=t; Path=/' });
      res.end(); return;
    }
    if (req.method === 'POST' && req.url === '/api/sessions') {
      sessionCreates18.push(JSON.parse(body || '{}'));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: { id: 'dur_session_1' } })); return;
    }
    if (req.method === 'POST' && /\/messages$/.test(req.url || '')) {
      messageSubmits18.push(JSON.parse(body || '{}'));
      if (failFirst18) {
        failFirst18 = false;
        res.destroy(); return; // simulate connection loss (no response)
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ run: { id: 'dur_run_1' } })); return;
    }
    // Recovery lookup: GET /api/sessions/:id/responses/:requestId
    // Return 404 = request not yet accepted (safe to re-submit)
    if (req.method === 'GET' && /\/responses\//.test(req.url || '')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ claim: null }));
  });
  await new Promise((r) => server18.listen(0, '127.0.0.1', r));
  const { port: p18 } = server18.address();

  try {
    await saveMailboxAutomation(durMailboxRoot, {
      allowlistAutoApprove: true,
      chatBaseUrl: `http://127.0.0.1:${p18}`,
      session: { folder: '~', tool: 'claude', description: 'Dur', systemPrompt: '.' },
    });
    await ingestRawMessage(
      ['From: user@example.com','To: dur@example.com','Subject: durable test',
       'Message-ID: <dur-test@example.com>','Content-Type: text/plain','','dur test'].join('\n'),
      'dur.eml', durMailboxRoot, { text: 'dur test' },
    );

    const durRuntime = createRemoteLabRuntime(`http://127.0.0.1:${p18}`, {});
    durRuntime.readOwnerToken = async () => 'tok-durable-1234567890abcdef1234567890abcdef1234';

    // First sweep: session created, message submit destroyed (connection loss)
    const sweep1 = await runSweep({ rootDir: durMailboxRoot, baseUrl: `http://127.0.0.1:${p18}`, runtime: durRuntime });
    assert.equal(sweep1.failures.length, 1, 'first sweep should report one failure');
    assert.equal(sweep1.failures[0].permanent, false, 'lost HTTP response must be non-permanent (retriable)');
    assert.equal(sessionCreates18.length, 1, 'exactly one session created in first sweep');

    // Verify preparedSessionId was persisted
    const { listQueue, APPROVED_QUEUE: AQ18 } = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href);
    const items18 = await listQueue(AQ18, durMailboxRoot);
    const durItem = items18[0];
    assert.equal(
      (typeof durItem?.automation?.preparedSessionId === 'string' ? durItem.automation.preparedSessionId : '').trim(),
      'dur_session_1',
      'preparedSessionId must be persisted so next sweep reuses the session',
    );

    // Second sweep: message submit succeeds
    const sweep2 = await runSweep({ rootDir: durMailboxRoot, baseUrl: `http://127.0.0.1:${p18}`, runtime: durRuntime });
    assert.equal(sweep2.processed, 1, 'second sweep should succeed');
    assert.equal(sweep2.failures.length, 0);
    assert.equal(sessionCreates18.length, 1, 'no duplicate session created on retry');
    assert.equal(messageSubmits18.length, 2, 'message submitted twice (once per sweep)');
    assert.equal(messageSubmits18[0].requestId, messageSubmits18[1].requestId,
      'same requestId on both attempts enables server-side deduplication');
  } finally {
    server18.close();
  }
});

// ─── 19. cross-instance email delivery sweep reaches guest outbox ─────────────
await test('runEmailSourceDeliverySweep: claims email deliveries from guest instance outbox', async () => {
  const guestHome = mkdtempSync(join(tmpdir(), 'remotelab-guest-sweep-'));
  const guestMailboxRoot19 = join(guestHome, 'mailbox');
  mkdirSync(guestMailboxRoot19, { recursive: true });
  mkdirSync(join(guestHome, '.config', 'remotelab'), { recursive: true });
  const guestAuthFile19 = join(guestHome, '.config', 'remotelab', 'auth.json');
  writeFileSync(guestAuthFile19, JSON.stringify({ token: 'tok-guest-sweep-1234567890abcdef12345678' }));
  await initializeMailbox({ rootDir: guestMailboxRoot19, name: 'G', localPart: 'g', domain: 'example.com', allowEmails: ['u@e.com'] });

  const rootClaims19 = [];
  const guestClaims19 = [];

  const guestServer19 = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c.toString();
    if (req.method === 'GET' && req.url?.startsWith('/?token=')) {
      res.writeHead(302, { Location: '/', 'Set-Cookie': 'session_token=gs; Path=/' }); res.end(); return;
    }
    if (req.method === 'POST' && req.url === '/api/source-deliveries/claim') {
      guestClaims19.push(JSON.parse(b || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ claim: null })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => guestServer19.listen(0, '127.0.0.1', r));
  const { port: guestPort19 } = guestServer19.address();

  const rootServer19 = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c.toString();
    if (req.method === 'GET' && req.url?.startsWith('/?token=')) {
      res.writeHead(302, { Location: '/', 'Set-Cookie': 'session_token=rs; Path=/' }); res.end(); return;
    }
    if (req.method === 'POST' && req.url === '/api/source-deliveries/claim') {
      rootClaims19.push(JSON.parse(b || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ claim: null })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => rootServer19.listen(0, '127.0.0.1', r));
  const { port: rootPort19 } = rootServer19.address();

  const guestRegistryFile19 = join(guestHome, '.config', 'remotelab', 'guest-instances.json');
  writeFileSync(guestRegistryFile19, JSON.stringify([
    { name: 'guestinst', authFile: guestAuthFile19, localBaseUrl: `http://127.0.0.1:${guestPort19}` },
  ]));
  process.env.REMOTELAB_GUEST_REGISTRY_FILE = guestRegistryFile19;

  try {
    const { runEmailSourceDeliverySweep: sweepFn19 } = await import(
      pathToFileURL(join(repoRoot, 'scripts', 'agent-mail-worker.mjs')).href + `?t=${Date.now()}`
    );
    const rootRuntime19 = createRemoteLabRuntime(`http://127.0.0.1:${rootPort19}`, {});
    rootRuntime19.readOwnerToken = async () => 'tok-guest-sweep-1234567890abcdef12345678';

    await sweepFn19({ rootDir: guestMailboxRoot19, runtime: rootRuntime19 });

    assert.ok(rootClaims19.length > 0, 'root instance should have been swept');
    assert.equal(rootClaims19[0].connector, 'email');
    assert.ok(guestClaims19.length > 0, 'guest instance should have been swept');
    assert.equal(guestClaims19[0].connector, 'email');
    assert.equal(guestClaims19[0].sourceRouteId, buildEmailSourceRouteId(guestMailboxRoot19),
      'guest claim must use root mailbox sourceRouteId');
  } finally {
    guestServer19.close();
    rootServer19.close();
    delete process.env.REMOTELAB_GUEST_REGISTRY_FILE;
  }
});

// ─── 20. sendOutboundEmail: disableCurlFallback prevents internal retry ────────
await test('sendOutboundEmail: disableCurlFallback=true blocks fetch→curl retry (no duplicate send)', async () => {
  const { sendOutboundEmail: soe20 } = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mail-outbound.mjs')).href + `?t=${Date.now()}`);
  let fetchAttempts20 = 0;
  const fetchImpl20 = async () => {
    fetchAttempts20++;
    const err = new Error('fetch failed'); err.code = 'ECONNRESET'; throw err;
  };
  let threw20 = false;
  try {
    await soe20({ to: 'u@e.com', from: 'b@e.com', subject: 'T', text: 'hi' }, {
      provider: 'cloudflare_worker', workerToken: 'tok', workerBaseUrl: 'http://127.0.0.1:19999',
      from: 'b@e.com',
    }, {
      fetchImpl: fetchImpl20,
      disableCurlFallback: true,
      // forceFetchTransport ensures our mock fetchImpl is used even when a
      // proxy is configured in the environment (otherwise curl takes over).
      forceFetchTransport: true,
    });
  } catch { threw20 = true; }
  assert.ok(threw20, 'should throw on fetch failure');
  assert.equal(fetchAttempts20, 1, 'exactly one fetch attempt; no curl fallback');
});

// ─── 21. sendOutboundEmail: timeoutMs forwards AbortSignal to fetchImpl ────────
await test('sendOutboundEmail: timeoutMs forwards AbortSignal to fetchImpl', async () => {
  const { sendOutboundEmail: soe21 } = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mail-outbound.mjs')).href + `?t=${Date.now()}`);
  const config21 = { provider: 'resend_api', apiKey: 'test-key', apiBaseUrl: 'http://x.invalid', from: 'b@e.com' };
  let capturedSignal;
  const fetchImpl21 = (_url, opts) => {
    capturedSignal = opts?.signal;
    const err = new Error('stop'); err.code = 'ECONNRESET'; err.retryable = true; throw err;
  };
  try {
    await soe21({ to: 'u@e.com', subject: 'T', text: 'hi' }, config21,
      { fetchImpl: fetchImpl21, timeoutMs: 5000, disableCurlFallback: true, forceFetchTransport: true });
  } catch {}
  assert.ok(capturedSignal instanceof AbortSignal, 'AbortSignal forwarded when timeoutMs > 0');
  assert.ok(!capturedSignal.aborted, 'signal not yet aborted (5000ms has not elapsed)');
  // Without timeoutMs: no signal
  let noSignal;
  const fetchImpl21b = (_url, opts) => { noSignal = opts?.signal; throw new Error('stop'); };
  try {
    await soe21({ to: 'u@e.com', subject: 'T', text: 'hi' }, config21,
      { fetchImpl: fetchImpl21b, disableCurlFallback: true, forceFetchTransport: true });
  } catch {}
  assert.equal(noSignal, undefined, 'no AbortSignal without timeoutMs');
});

// ─── 22. processEmailSourceDeliveryInProcess: successful in-process send ──────
await test('processEmailSourceDeliveryInProcess: claim → send → complete in-process', async () => {
  const sentMessages22 = [];
  let claimCalled22 = false;
  let completedId22 = null;

  // Stub in-process source-delivery functions
  const claimFn22 = async ({ connector, sourceRouteId }) => {
    claimCalled22 = true;
    assert.equal(connector, 'email');
    return {
      leaseId: 'lease_ip_001',
      delivery: {
        id: 'srcd_inprocess00000000000_0',
        sessionId: 'sess_ip_1',
        responseId: 'resp_ip_001',
        text: 'In-process AI reply',
        attachments: [],
        target: { to: 'user@example.com', from: 'bot@example.com', subject: 'Re: ip test',
          inReplyTo: '<ip@example.com>', references: ['<ip@example.com>'], messageId: '<ip@example.com>', threadId: '<ip@example.com>' },
      },
    };
  };
  const completeFn22 = async (id, leaseId, input) => {
    completedId22 = id;
  };
  const failFn22 = async () => { throw new Error('should not fail'); };

  const sendImpl22 = async (params) => { sentMessages22.push(params); return { id: 'ext_ip_001' }; };

  const result22 = await processEmailSourceDeliveryInProcess({
    claimFn: claimFn22,
    completeFn: completeFn22,
    failFn: failFn22,
    sourceRouteId: buildEmailSourceRouteId(mailboxRoot),
    mailboxRoot,
    sendOutboundEmailImpl: sendImpl22,
  });

  assert.ok(claimCalled22, 'should have called claimFn');
  assert.equal(sentMessages22.length, 1, 'exactly one send call');
  assert.equal(sentMessages22[0].to, 'user@example.com');
  assert.equal(completedId22, 'srcd_inprocess00000000000_0', 'completeFn called with delivery ID');
  assert.ok(result22 !== null, 'should return the delivery');
});

// ─── 23. processEmailSourceDeliveryInProcess: no claim → null ─────────────────
await test('processEmailSourceDeliveryInProcess: returns null when no claim', async () => {
  const result23 = await processEmailSourceDeliveryInProcess({
    claimFn: async () => null,
    completeFn: async () => {},
    failFn: async () => {},
    sourceRouteId: 'route_test',
    mailboxRoot,
    sendOutboundEmailImpl: async () => ({ id: 'ok' }),
  });
  assert.equal(result23, null);
});

// ─── 24. processEmailSourceDeliveryInProcess: network error → failFn no safeToRetry
await test('processEmailSourceDeliveryInProcess: network error calls failFn without safeToRetry', async () => {
  let failArgs24 = null;
  const result24 = await processEmailSourceDeliveryInProcess({
    claimFn: async () => ({
      leaseId: 'lease_net_ip',
      delivery: { id: 'srcd_netiperr00000000000_0', sessionId: 'sess_net', responseId: 'r',
        text: 'hi', attachments: [],
        target: { to: 'u@e.com', subject: 'T', inReplyTo: '', references: [], messageId: '', threadId: '' } },
    }),
    completeFn: async () => {},
    failFn: async (id, leaseId, error, opts) => { failArgs24 = { id, leaseId, error, opts }; },
    sourceRouteId: 'route_test',
    mailboxRoot,
    sendOutboundEmailImpl: async () => {
      const err = new Error('ECONNRESET'); err.code = 'ECONNRESET'; err.retryable = true; throw err;
    },
  });
  assert.equal(result24, null);
  assert.ok(failArgs24, 'failFn should have been called');
  assert.notEqual(failArgs24.opts?.safeToRetry, true, 'network error must NOT set safeToRetry');
});

// ─── 25. updateMailboxItemForDelivery: updates matched item to reply_sent ──────
await test('updateMailboxItemForDelivery: updates matching mailbox item to reply_sent', async () => {
  // Create a separate mailbox for this test
  const replyHome25 = mkdtempSync(join(tmpdir(), 'remotelab-reply-status-'));
  const replyRoot25 = join(replyHome25, 'mailbox');
  mkdirSync(replyRoot25, { recursive: true });
  await initializeMailbox({ rootDir: replyRoot25, name: 'R', localPart: 'r', domain: 'e.com', allowEmails: ['u@e.com'] });

  const { ingestRawMessage: ingest25, findQueueItem: find25 } = await import(
    pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href
  );
  // updateMailboxItemForDelivery is imported at the top of this test file

  const ingested25 = await ingest25(
    ['From: u@e.com','To: r@e.com','Subject: reply status test',
     'Message-ID: <rsp-test@e.com>','Content-Type: text/plain','','msg'].join('\n'),
    'rsp.eml', replyRoot25, { text: 'msg' },
  );
  const item25 = (await find25(ingested25.id, replyRoot25))?.item;
  assert.equal(item25?.status, 'approved_for_ai');

  // Manually set automation.sessionId to simulate a submitted item
  const { updateQueueItem: uqi25, APPROVED_QUEUE: AQ25 } = await import(
    pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href
  );
  await uqi25(item25.id, replyRoot25, draft => {
    draft.automation = { ...(draft.automation || {}), sessionId: 'sess_reply_25' };
    return draft;
  });

  // Delivery with matching sessionId and inReplyTo
  const delivery25 = {
    sessionId: 'sess_reply_25',
    target: { inReplyTo: '<rsp-test@e.com>' },
  };

  await updateMailboxItemForDelivery(delivery25, replyRoot25);

  const updated25 = (await find25(item25.id, replyRoot25))?.item;
  assert.equal(updated25?.status, 'reply_sent', 'mailbox item should be updated to reply_sent');
  assert.equal(updated25?.automation?.status, 'reply_sent');
});

// ─── 26. embedded-mail-worker starts in-process delivery poller ───────────────
await test('embedded-mail-worker: startEmbeddedMailWorker starts in-process delivery poller', async () => {
  // Create an isolated mailbox with identity for the embedded worker to start
  const ewHome26 = mkdtempSync(join(tmpdir(), 'remotelab-ew-26-'));
  const ewConfig26 = join(ewHome26, '.config', 'remotelab');
  mkdirSync(ewConfig26, { recursive: true });

  process.env.REMOTELAB_CONFIG_DIR = ewConfig26;
  const ewMailboxRoot26 = join(ewConfig26, 'agent-mailbox');
  mkdirSync(ewMailboxRoot26, { recursive: true });

  const { initializeMailbox: initMb26, saveMailboxAutomation: saveMbAuto26 } = await import(
    pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href + `?t=${Date.now()}`
  );
  await initMb26({ rootDir: ewMailboxRoot26, name: 'EW', localPart: 'ew', domain: 'e.com', allowEmails: ['u@e.com'] });
  await saveMbAuto26(ewMailboxRoot26, { allowlistAutoApprove: true, chatBaseUrl: 'http://127.0.0.1:19999', session: { folder: '~', tool: 'claude', description: 'EW', systemPrompt: '.' } });

  const { startEmbeddedMailWorker } = await import(
    pathToFileURL(join(repoRoot, 'lib', 'embedded-mail-worker.mjs')).href + `?t=${Date.now()}`
  );

  // Clear disable flag if set by the test environment
  const prevDisable26 = process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER;
  delete process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER;

  const fakeCreateSession = async () => ({ id: 'ew_sess_26' });
  const fakeSubmitHttpMessage = async () => ({ runId: 'ew_run_26', duplicate: false, queued: false });

  const worker26 = await startEmbeddedMailWorker({
    createSession: fakeCreateSession,
    submitHttpMessage: fakeSubmitHttpMessage,
    intervalMs: 10000, // long so no actual sweeps during test
  });

  assert.ok(worker26 !== null, 'embedded worker should start');
  assert.ok(typeof worker26.stop === 'function', 'should have a stop() method');
  // stop() must clean up both the admission poller and the delivery sender poller
  worker26.stop();

  if (prevDisable26 !== undefined) process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER = prevDisable26;
  delete process.env.REMOTELAB_CONFIG_DIR;
});


// ─── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const { name, err } of errors) {
    console.error(`\nFAIL: ${name}`);
    console.error(err?.stack || err?.message || err);
  }
  process.exit(1);
}
