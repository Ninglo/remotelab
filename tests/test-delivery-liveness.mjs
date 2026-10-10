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
  } else if (mode === 'observer') {
    const { createSourceDeliveryIssueObserver } = await import('../chat/source-delivery-issue-observer.mjs');
    await outbox.enqueueSourceDelivery({ sessionId: 'offline-observer', responseId: 'offline-observer', text: 'waiting',
      sourceDelivery: { connector: 'feishu', sourceRouteId: 'offline-observer', target: { chatId: 'chat' } } });
    let clock = Date.now();
    const notified = [];
    const observer = createSourceDeliveryIssueObserver({
      loadIssues: () => outbox.listSourceDeliveryIssues({ now: clock }),
      notify: sessionId => notified.push(sessionId), intervalMs: 10,
    });
    observer.start();
    try {
      await observer.tick();
      assert.deepEqual(notified, []);
      clock += 180_000;
      for (let n = 0; n < 100 && !notified.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(notified, ['offline-observer'], 'elapsed delay notifies the open page without sender activity or a reload');
      await observer.tick();
      assert.equal(notified.length, 1, 'unchanged errors do not repeatedly notify');
      clock -= 180_000;
      await observer.tick();
      assert.equal(notified.length, 2, 'cleared issue also invalidates the page');
    } finally { observer.stop(); }
  } else if (mode === 'projection') {
    const { createSession, getSession, listSessions } = await import('../chat/session-manager.mjs');
    const session = await createSession(home, 'codex', 'Delivery visibility');
    const entry = await outbox.enqueueSourceDelivery({ sessionId: session.id, responseId: 'visible', text: 'bad',
      sourceDelivery: { connector: 'feishu', sourceRouteId: 'visible', target: { chatId: 'chat' } } });
    const claim = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'visible' });
    await outbox.failSourceDelivery(entry.id, claim.leaseId, 'Feishu 230002: permission denied', { definiteFailure: true });
    assert.equal((await getSession(session.id)).deliveryIssues?.[0]?.id, entry.id, 'session API must expose the error');
    assert.equal((await listSessions()).find(s => s.id === session.id)?.deliveryIssueCount, 1, 'sidebar must expose an issue count');
    const issue = (await getSession(session.id)).deliveryIssues[0];
    const before = await outbox.getSourceDelivery(entry.id);
    const dismissed = await outbox.dismissSourceDeliveryIssue(entry.id, { issueVersion: issue.issueVersion, personId: 'reader' });
    assert.equal((await getSession(session.id)).deliveryIssues.length, 0);
    assert.equal((await listSessions()).find(s => s.id === session.id)?.deliveryIssueCount, 0, 'dismissal clears the sidebar count');
    const { dismissedIssue, ...unchanged } = dismissed;
    assert.deepEqual(unchanged, before, 'dismissal cannot alter failure, lease, attempts or original content');
    assert.equal(dismissedIssue.personId, 'reader');
    assert.equal((await outbox.dismissSourceDeliveryIssue(entry.id, { issueVersion: issue.issueVersion })).dismissedIssue.at,
      dismissedIssue.at, 'duplicate acknowledgment retains its original timestamp');
    const { createRequestStore } = await import('../chat/requests.mjs');
    const { deliveryIssue } = await import('../chat/source-delivery-issues.mjs');
    const disk = createRequestStore(join(home, '.config/remotelab/requests'));
    const restored = await disk.get(entry.id.split('_')[1]);
    assert.equal(deliveryIssue(restored.deliveries[0]), null, 'a fresh store retains the dismissed warning');

    // Retrying explicitly creates a new issue; an old page cannot dismiss it.
    await outbox.resolveSourceDelivery(entry.id, { state: 'pending', reason: 'retry requested' });
    const retry = await outbox.claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'visible' });
    await outbox.failSourceDelivery(entry.id, retry.leaseId, 'new error', { definiteFailure: true });
    assert.equal((await getSession(session.id)).deliveryIssues.length, 1, 'a new failed attempt is visible again');
    await assert.rejects(outbox.dismissSourceDeliveryIssue(entry.id, { issueVersion: issue.issueVersion }),
      error => error.status === 409, 'stale acknowledgment must not hide a new error');

    const delayed = await outbox.enqueueSourceDelivery({ sessionId: session.id, responseId: 'delayed', text: 'waiting',
      sourceDelivery: { connector: 'email', sourceRouteId: 'delayed', target: { to: 'fixture@example.test' } } });
    await requests.mutate(delayed.id.split('_')[1], current => ({ ...current, deliveries: current.deliveries.map(part => ({
      ...part, createdAt: new Date(Date.now() - 180_000).toISOString(),
    })) }));
    const delayedIssue = (await getSession(session.id)).deliveryIssues.find(part => part.id === delayed.id);
    assert.equal(delayedIssue.state, 'delayed');
    await outbox.dismissSourceDeliveryIssue(delayed.id, { issueVersion: delayedIssue.issueVersion });
    const delayedClaim = await outbox.claimSourceDelivery({ connector: 'email', sourceRouteId: 'delayed' });
    assert.equal(delayedClaim.delivery.id, delayed.id, 'dismissed delayed delivery remains claimable');
    await outbox.failSourceDelivery(delayed.id, delayedClaim.leaseId, 'receipt unknown');
    const unknownIssue = (await getSession(session.id)).deliveryIssues.find(part => part.id === delayed.id);
    await outbox.dismissSourceDeliveryIssue(delayed.id, { issueVersion: unknownIssue.issueVersion });
    assert.equal((await outbox.getSourceDelivery(delayed.id)).leaseId, delayedClaim.leaseId, 'unknown delivery retains its lease');
    await outbox.completeSourceDelivery(delayed.id, delayedClaim.leaseId, { externalId: 'late-receipt' });
    assert.equal((await outbox.getSourceDelivery(delayed.id)).state, 'delivered', 'late receipt remains accepted after dismissal');
    await outbox.dismissSourceDeliveryIssue(delayed.id, { issueVersion: unknownIssue.issueVersion });
    assert.equal((await outbox.getSourceDelivery(delayed.id)).state, 'delivered', 'late acknowledgment cannot change completed delivery');
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
