#!/usr/bin/env node
// Exercise the shipped embedded worker, real request outbox and real email
// serialization together. The only network destination is this test's loopback
// server; no real account, model, or upstream API is used.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-embedded-email-outbox-'));
setIsolatedTestHome(home);
delete process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER;
const mailboxRoot = join(home, '.config/remotelab/agent-mailbox');
const mailbox = await import('../lib/agent-mailbox.mjs');
const { requests } = await import('../chat/requests.mjs');
const { buildReplyDeliveries, normalizeSourceDeliveryPlan } = await import('../chat/source-deliveries.mjs');
const { buildEmailSourceRouteId } = await import('../lib/agent-mail-source-delivery.mjs');
const { startEmbeddedMailWorker } = await import('../lib/embedded-mail-worker.mjs');
const { saveUiRuntimeSelection } = await import('../lib/runtime-selection.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const sent = [];
const transport = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  assert.equal(req.url, '/api/send-email');
  sent.push(JSON.parse(body));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: `fixture-mail-${sent.length}` }));
});
await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve));
let worker;
let releaseAdmission;
const admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
try {
  await mailbox.initializeMailbox({ rootDir: mailboxRoot, name: 'Fixture', localPart: 'agent', domain: 'example.test', allowEmails: ['owner@example.test'] });
  await mailbox.saveMailboxAutomation(mailboxRoot, { enabled: true, allowlistAutoApprove: true, session: { folder: home, tool: 'fake-codex' } });
  await mailbox.saveOutboundConfig(mailboxRoot, { provider: 'cloudflare_worker', workerBaseUrl: `http://127.0.0.1:${transport.address().port}`, workerToken: 'fixture-only', from: 'agent@example.test' });
  const item = await mailbox.ingestRawMessage([
    'From: owner@example.test', 'To: agent+alias@example.test', 'Subject: embedded result',
    'Message-ID: <embedded@example.test>', 'Content-Type: text/plain; charset=UTF-8', '', 'Please reply.',
  ].join('\n'), 'fixture.eml', mailboxRoot, { text: 'Please reply.' });

  // A result completed while no sender was running. Give it an old timestamp;
  // it must remain deliverable beyond the former connector wait deadline.
  const offlinePlan = { connector: 'email', sourceRouteId: buildEmailSourceRouteId(mailboxRoot), target: {
    to: 'owner@example.test', from: 'agent@example.test', subject: 'Offline result', inReplyTo: '<offline@example.test>',
  } };
  const offline = await requests.accept({ sessionId: 'offline-session', requestId: 'offline-request', text: 'Offline task', options: { sourceDelivery: offlinePlan } });
  await requests.mutate(offline.record.key, current => ({ ...current, acceptedAt: new Date(Date.now() - 3600000).toISOString() }));
  await requests.settle(offline.record.key, { state: 'completed' }, buildReplyDeliveries(offlinePlan, { text: 'Result completed while sender was offline.', attachments: [] }));

  const filePath = join(home, 'result.txt');
  await writeFile(filePath, 'fixture attachment bytes');
  let admissions = 0;
  worker = await startEmbeddedMailWorker({
    createSession: async () => { await admissionGate; return { id: 'embedded-session' }; },
    saveAttachments: async () => [],
    submitHttpMessage: async (sessionId, text, images, options) => {
      admissions++;
      const plan = normalizeSourceDeliveryPlan(options.sourceDelivery);
      assert(plan, 'embedded admission must persist its final reply destination');
      const { record, duplicate } = await requests.accept({ sessionId, text, images, requestId: options.requestId, options });
      if (admissions === 1) {
        const queuedItem = (await mailbox.findQueueItem(item.id, mailboxRoot)).item;
        assert.deepEqual(queuedItem.automation.preparedSubmission.options, JSON.parse(JSON.stringify(options)));
        await writeFile(queuedItem.storage.rawPath, 'Changed email content after admission');
        await saveUiRuntimeSelection({ selectedTool: 'pi', selectedModel: 'changed-model' });
        throw new Error('Simulated crash after durable admission');
      }
      assert.equal(duplicate, true, 'restart retries exact text/options and the existing request, not new AI work');
      const payload = { text: 'Embedded final reply.', attachments: [{ savedPath: filePath, originalName: 'result.txt', mimeType: 'text/plain' }] };
      await requests.settle(record.key, { state: 'completed', payload }, buildReplyDeliveries(plan, payload));
      return { requestId: record.requestId, run: { id: record.runId }, response: { id: record.responseId }, queued: false, duplicate: false };
    },
  });
  assert(worker, 'default embedded worker must start for a configured mailbox');
  await waitFor(() => sent.find(mail => mail.subject === 'Offline result'), 'sender runs independently while new admission is blocked');
  assert.equal(admissions, 0);
  releaseAdmission();
  const finalMail = await waitFor(() => sent.find(mail => mail.text === 'Embedded final reply.'), 'embedded final result reaches the configured email transport');
  assert.equal(finalMail.inReplyTo, '<embedded@example.test>');
  assert.equal(finalMail.from, 'agent+alias@example.test');
  assert.equal(finalMail.attachments.length, 1, 'text and attachment are one email, not separate sends');
  assert.equal(Buffer.from(finalMail.attachments[0].contentBase64, 'base64').toString(), 'fixture attachment bytes');
  await waitFor(async () => (await mailbox.findQueueItem(item.id, mailboxRoot))?.item?.status === 'reply_sent', 'mailbox item records final delivery');
  assert.equal(admissions, 2, 'one interrupted admission call plus its idempotent recovery');
  assert.equal(sent.length, 2, 'one offline result plus one final email; no duplicate creation notice');
  console.log('embedded email outbox: independent admission/sender, old offline result, alias, attachment, item status and no duplicate mail passed');
} finally {
  releaseAdmission();
  await worker?.stop();
  await pause(100);
  await new Promise(resolve => transport.close(resolve));
  await rm(home, { recursive: true, force: true });
}
