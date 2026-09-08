#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-email-send-uncertainty-'));
setIsolatedTestHome(home);
const mailboxRoot = join(home, '.config/remotelab/agent-mailbox');
const mailbox = await import('../lib/agent-mailbox.mjs');
const outbox = await import('../chat/source-deliveries.mjs');
const { buildEmailSourceRouteId } = await import('../lib/agent-mail-source-delivery.mjs');
const { processEmailSourceDeliveryOnce, processEmailSourceDeliveryInProcess } = await import('../lib/agent-mail-source-delivery-sender.mjs');
let mode = 'reset';
let sends = 0;
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* consume full send before dropping/rejecting */ }
  sends++;
  if (mode === 'reset') { res.destroy(); return; }
  const status = mode === 'gateway' ? 502 : mode === 'limited' ? 429 : 200;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status === 200 ? { id: 'fixture-id' } : { error: mode }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sourceRouteId = buildEmailSourceRouteId(mailboxRoot);
const requestRemoteLab = async (path, options = {}) => {
  const body = options.body || {};
  let json;
  if (path.endsWith('/claim')) json = { claim: await outbox.claimSourceDelivery(body) };
  else {
    const [, id, action] = /\/api\/source-deliveries\/([^/]+)\/(complete|fail)/.exec(path) || [];
    assert(id, `unexpected control-plane request ${path}`);
    json = { delivery: action === 'complete'
      ? await outbox.completeSourceDelivery(id, body.leaseId, body)
      : await outbox.failSourceDelivery(id, body.leaseId, body.error, body) };
  }
  return { response: { ok: true, status: 200 }, json };
};
try {
  await mailbox.initializeMailbox({ rootDir: mailboxRoot, name: 'Fixture', localPart: 'agent', domain: 'example.test' });
  await mailbox.saveOutboundConfig(mailboxRoot, { provider: 'cloudflare_worker', workerBaseUrl: `http://127.0.0.1:${server.address().port}`, workerToken: 'fixture-only', from: 'agent@example.test' });
  for (const scenario of ['reset', 'gateway', 'limited', 'success']) {
    mode = scenario;
    const record = await outbox.enqueueSourceDelivery({ responseId: `uncertainty-${scenario}`, text: `Fixture ${scenario}`,
      sourceDelivery: { connector: 'email', sourceRouteId, target: { to: 'owner@example.test', subject: scenario, inReplyTo: `<${scenario}@example.test>` } } });
    const before = sends;
    await processEmailSourceDeliveryOnce({ requestRemoteLab, sourceRouteId, mailboxRoot });
    assert.equal(sends - before, 1, `${scenario}: no automatic second external send, including fetch→curl fallback`);
    const saved = await outbox.getSourceDelivery(record.id);
    const expected = scenario === 'success' ? 'delivered' : scenario === 'limited' ? 'pending' : 'unknown';
    assert.equal(saved.state, expected, `${scenario}: only proven rejection is retry-safe; gateway errors may hide an accepted send`);
    assert.equal(saved.attempts, 1);
    if (scenario !== 'limited') {
      await processEmailSourceDeliveryOnce({ requestRemoteLab, sourceRouteId, mailboxRoot });
      assert.equal(sends - before, 1, `${scenario}: polling must not repeat ambiguous or delivered sends`);
    }
  }
  mode = 'success';
  const local = await outbox.enqueueSourceDelivery({ responseId: 'local-ack-loss', text: 'Local receipt fixture',
    sourceDelivery: { connector: 'email', sourceRouteId, target: { to: 'owner@example.test', subject: 'local ack', inReplyTo: '<local-ack@example.test>' } } });
  let failAck = true;
  const localOptions = { sourceRouteId, mailboxRoot, claimFn: outbox.claimSourceDelivery, failFn: outbox.failSourceDelivery,
    completeFn: async (...args) => {
      if (failAck) { failAck = false; throw new Error('local acknowledgement write failed'); }
      return outbox.completeSourceDelivery(...args);
    },
  };
  await assert.rejects(processEmailSourceDeliveryInProcess(localOptions), /local acknowledgement write failed/);
  const afterSend = sends;
  await processEmailSourceDeliveryInProcess(localOptions);
  assert.equal(sends, afterSend, 'embedded receipt repair must not resend externally');
  assert.equal((await outbox.getSourceDelivery(local.id)).state, 'delivered');

  const missing = await outbox.enqueueSourceDelivery({ responseId: 'missing-attachment', text: 'Do not send incomplete mail',
    attachments: [{ savedPath: join(home, 'does-not-exist.txt'), originalName: 'missing.txt' }],
    sourceDelivery: { connector: 'email', sourceRouteId, target: { to: 'owner@example.test', subject: 'missing file', inReplyTo: '<missing@example.test>' } } });
  await processEmailSourceDeliveryOnce({ requestRemoteLab, sourceRouteId, mailboxRoot });
  assert.equal(sends, afterSend, 'missing attachment cannot silently degrade to text-only email');
  assert.equal((await outbox.getSourceDelivery(missing.id)).state, 'delivery_failed');
  console.log('email real transport: response loss/502 unknown, 429 retry-safe, embedded receipt repair without resend, and no dropped attachments passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
