import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'delivery-liveness-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://owner.example.test';
const outbox = await import('../chat/source-deliveries.mjs');
const { requests } = await import('../chat/requests.mjs');
const { createDeliveryReceipts } = await import('../lib/delivery-receipts.mjs');
const { createFeishuHttpInstance } = await import('../lib/feishu-http-client.mjs');
const { loadRemoteLabReplyAttachment } = await import('../connectors/feishu/reply-attachments.mjs');
const { createServer } = await import('node:http');
const mode = process.argv[2] || 'queue';
try {
  if (mode === 'queue') {
    const plan = { connector: 'feishu', sourceRouteId: 'liveness', target: { chatId: 'chat', messageId: 'anchor', threadId: 'thread' } };
    const first = await outbox.enqueueSourceDelivery({ sessionId: 'session', responseId: 'first', text: 'first', sourceDelivery: plan });
    const claim = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'liveness' });
    const later = await outbox.enqueueSourceDelivery({ sessionId: 'session', responseId: 'later', text: 'later', sourceDelivery: plan });
    await outbox.failSourceDelivery(first.id, claim.leaseId, 'socket timeout');
    const next = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'liveness' });
    assert(next, 'an uncertain send must not freeze the topic');
    assert.equal(next.delivery.kind, 'delivery_notice', 'one durable notice precedes later replies');
    assert.match(next.delivery.text, /owner\.example\.test/);
    // A notice that fails must not recursively create another notice.
    await outbox.failSourceDelivery(next.delivery.id, next.leaseId, 'no permission', { definiteFailure: true });
    const continued = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'liveness' });
    assert.equal(continued.delivery.id, later.id);
    await outbox.completeSourceDelivery(later.id, continued.leaseId, { externalId: 'later-receipt' });
    const record = await requests.byRunId(first.runId);
    assert.equal(record.deliveries.length, 2, 'notification failure cannot recurse');
    assert.equal((await outbox.getSourceDelivery(first.id)).attempts, 1, 'uncertain original is never resent');
    const issues = await outbox.listSourceDeliveryIssues({ sessionId: 'session' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].state, 'unknown');
    assert.match(issues[0].lastError, /socket timeout/);
    await outbox.completeSourceDelivery(first.id, claim.leaseId, { externalId: 'late-receipt' });
    assert.equal((await outbox.listSourceDeliveryIssues({ sessionId: 'session' })).length, 0, 'late receipts clear visible uncertainty');

    const rejected = await outbox.enqueueSourceDelivery({ sessionId: 'rejected', responseId: 'rejected', text: 'bad', sourceDelivery: plan });
    const rejectedClaim = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'liveness' });
    await outbox.failSourceDelivery(rejected.id, rejectedClaim.leaseId, 'permission denied', { definiteFailure: true });
    assert((await requests.active()).some(r => r.runId === rejected.runId), 'unresolved failures remain visible after result archival');
    assert.equal((await outbox.listSourceDeliveryIssues({ sessionId: 'rejected' }))[0].state, 'delivery_failed');
    await outbox.resolveSourceDelivery(rejected.id, { state: 'cancelled', reason: 'user acknowledged' });
    assert.equal((await outbox.listSourceDeliveryIssues({ sessionId: 'rejected' })).length, 0);

    const retryPlan = { ...plan, sourceRouteId: 'bounded' };
    const bounded = await outbox.enqueueSourceDelivery({ sessionId: 'bounded', responseId: 'bounded', text: 'retry me', sourceDelivery: retryPlan });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const retry = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bounded' });
      assert.equal(retry.delivery.id, bounded.id);
      await outbox.failSourceDelivery(bounded.id, retry.leaseId, 'rate limited', { safeToRetry: true, retryDelayMs: 0 });
      assert.equal((await outbox.getSourceDelivery(bounded.id)).state, attempt < 5 ? 'pending' : 'delivery_failed');
    }
    const notice = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bounded' });
    assert.equal(notice.delivery.kind, 'delivery_notice', 'retry exhaustion produces a visible terminal failure and notice');
    assert.equal((await outbox.getSourceDelivery(bounded.id)).attempts, 5);
    const offline = await outbox.enqueueSourceDelivery({ sessionId: 'offline', responseId: 'offline', text: 'offline', sourceDelivery: plan });
    const delayed = await outbox.listSourceDeliveryIssues({ sessionId: 'offline', now: Date.now() + 180_000 });
    assert.equal(delayed[0].state, 'delayed', 'a stopped connector is visible even without a sender polling');
    assert.equal(delayed[0].id, offline.id);
    const recovered = await outbox.enqueueSourceDelivery({ sessionId: 'recovered', responseId: 'recovered', text: 'late success',
      sourceDelivery: { ...plan, sourceRouteId: 'recovered' } });
    const expired = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'recovered' });
    await outbox.failSourceDelivery(recovered.id, expired.leaseId, 'lost acknowledgement');
    await outbox.completeSourceDelivery(recovered.id, expired.leaseId, { externalId: 'known-success' });
    assert.equal(await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'recovered' }), null,
      'a resolved issue must not send a stale warning');
  } else if (mode === 'projection') {
    const { createSession, getSession, listSessions } = await import('../chat/session-manager.mjs');
    const session = await createSession(home, 'codex', 'Delivery visibility');
    const entry = await outbox.enqueueSourceDelivery({ sessionId: session.id, responseId: 'visible', text: 'bad',
      sourceDelivery: { connector: 'feishu', sourceRouteId: 'visible', target: { chatId: 'chat' } } });
    const claim = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'visible' });
    await outbox.failSourceDelivery(entry.id, claim.leaseId, 'Feishu 230002: permission denied', { definiteFailure: true });
    assert.equal((await getSession(session.id)).deliveryIssues?.[0]?.id, entry.id, 'session API must expose the error');
    assert.equal((await listSessions()).find(s => s.id === session.id)?.deliveryIssueCount, 1, 'sidebar must expose an issue count');
    await outbox.resolveSourceDelivery(entry.id, { state: 'cancelled', reason: 'owner acknowledged' });
    assert.equal((await getSession(session.id)).deliveryIssues.length, 0);
  } else if (mode === 'receipts') {
    const receipts = createDeliveryReceipts(join(home, 'receipts'));
    await receipts.record({ deliveryId: 'poison', leaseId: 'old' });
    await receipts.record({ deliveryId: 'healthy', leaseId: 'current' });
    const seen = [];
    const errors = [];
    const acknowledge = async r => { seen.push(r.deliveryId); if (r.deliveryId === 'poison') throw new Error('stale lease'); };
    await receipts.flush(acknowledge, { continueOnError: true, onError: e => errors.push(e.message) });
    assert.deepEqual([...seen].sort(), ['healthy', 'poison'], 'bad receipt cannot block a healthy acknowledgement');
    await receipts.flush(acknowledge, { continueOnError: true });
    assert.equal(seen.length, 2, 'bad receipt backs off and successful receipt is archived');
    assert.deepEqual(errors, ['stale lease']);
    const restored = createDeliveryReceipts(join(home, 'receipts'));
    await restored.flush(r => assert.equal(r.deliveryId, 'poison'), { now: Date.now() + 60000 });
  } else if (mode === 'deadline') {
    const http = createFeishuHttpInstance({ request: () => new Promise(() => {}) }, 20);
    // The fake transport ignores abort; the adapter itself must still settle.
    let timer;
    const outcome = await Promise.race([
      http.get('/stalled').then(() => 'resolved', () => 'rejected'),
      new Promise(resolve => { timer = setTimeout(() => resolve('hung'), 250); }),
    ]);
    clearTimeout(timer);
    assert.equal(outcome, 'rejected', 'a transport ignoring AbortSignal must not freeze the sender');
  } else if (mode === 'download') {
    const server = createServer((req, res) => {
      if (req.url !== '/body') { res.writeHead(302, { Location: '/body' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.write('partial');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let timer;
    try {
      const outcome = await Promise.race([
        loadRemoteLabReplyAttachment({ config: { chatBaseUrl: `http://127.0.0.1:${server.address().port}`, apiTimeoutMs: 20 } },
          { assetId: 'stalled' }, { ensureAuthCookie: async () => 'fixture' }).then(() => 'resolved', () => 'rejected'),
        new Promise(resolve => { timer = setTimeout(() => resolve('hung'), 250); }),
      ]);
      assert.equal(outcome, 'rejected', 'headers arriving must not disable the download body deadline');
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log(`delivery liveness ${mode}: passed`);
} finally { await rm(home, { recursive: true, force: true }); }
