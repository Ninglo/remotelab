#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-email-admission-recovery-'));
setIsolatedTestHome(home);
const rootDir = join(home, '.config/remotelab/agent-mailbox');
const mail = await import('../lib/agent-mailbox.mjs');
const { saveUiRuntimeSelection } = await import('../lib/runtime-selection.mjs');
const { createRemoteLabRuntime, runSweep } = await import('../scripts/agent-mail-worker.mjs');
const accepted = new Map();
const posts = [];
let creates = 0;
let loseResponse = true;
let rejectAdmission = false;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/sessions') { creates++; res.statusCode = 201; res.end(JSON.stringify({ session: { id: `fixture-${creates}` } })); return; }
  if (req.url.endsWith('/messages')) {
    posts.push(body);
    if (rejectAdmission) { res.statusCode = 503; res.end(JSON.stringify({ error: 'not admitted' })); return; }
    const id = `run-${body.requestId}`; accepted.set(body.requestId, id);
    if (loseResponse) { res.destroy(); return; }
    res.statusCode = 202; res.end(JSON.stringify({ run: { id }, queued: false })); return;
  }
  if (req.url.includes('/responses/')) {
    const requestId = decodeURIComponent(req.url.split('/responses/')[1]);
    const rootRunId = accepted.get(requestId);
    res.statusCode = rootRunId ? 200 : 404;
    res.end(JSON.stringify(rootRunId ? { replyPublication: { rootRunId, state: 'running' } } : { error: 'not found' })); return;
  }
  if (req.url === '/api/source-deliveries/claim') { res.end(JSON.stringify({ claim: null })); return; }
  if (req.url === '/api/notifications') { res.end('{}'); return; }
  res.statusCode = 404; res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const runtime = createRemoteLabRuntime(baseUrl); runtime.authCookie = 'session_token=fixture';
try {
  await mail.initializeMailbox({ rootDir, name: 'Fixture', localPart: 'agent', domain: 'example.test', allowEmails: ['owner@example.test'] });
  await mail.saveMailboxAutomation(rootDir, { enabled: true, allowlistAutoApprove: true, chatBaseUrl: baseUrl, session: { folder: home } });
  await saveUiRuntimeSelection({ selectedTool: 'codex', selectedModel: 'first-model' });
  const ingest = async id => mail.ingestRawMessage(['From: owner@example.test', 'To: agent@example.test', `Subject: ${id}`,
    `Message-ID: <${id}@example.test>`, 'Content-Type: text/plain; charset=UTF-8', '', 'Original email body'].join('\n'), `${id}.eml`, rootDir, { text: 'Original email body' });
  const item = await ingest('lost-response');
  await runSweep({ rootDir, baseUrl, runtime });
  let saved = (await mail.findQueueItem(item.id, rootDir)).item;
  assert(saved.automation.preparedSubmission, 'exact payload must be durable before sending');
  assert.notEqual(saved.status, 'reply_failed', 'lost admission response is not permanent AI failure');
  assert.deepEqual(saved.automation.preparedSubmission.payload, posts[0]);
  await saveUiRuntimeSelection({ selectedTool: 'pi', selectedModel: 'changed-model' });
  await writeFile(saved.storage.rawPath, 'Changed source after admission');
  loseResponse = false;
  await runSweep({ rootDir, baseUrl, runtime });
  saved = (await mail.findQueueItem(item.id, rootDir)).item;
  assert.equal(creates, 1);
  assert.equal(posts.length, 1, 'accepted request is reconciled without uploading/submitting its attachments again');
  assert.equal(saved.automation.duplicate, true);
  assert.equal(saved.status, 'processing_for_reply');

  const retryItem = await ingest('not-yet-admitted');
  rejectAdmission = true;
  await runSweep({ rootDir, baseUrl, runtime });
  const firstAttempt = posts.at(-1);
  const retrySaved = (await mail.findQueueItem(retryItem.id, rootDir)).item;
  await writeFile(retrySaved.storage.rawPath, 'Changed before retry');
  await saveUiRuntimeSelection({ selectedTool: 'codex', selectedModel: 'third-model' });
  rejectAdmission = false;
  await runSweep({ rootDir, baseUrl, runtime });
  assert.equal(creates, 2, 'failed submission reuses its already persisted session');
  assert.deepEqual(posts.at(-1), firstAttempt, '404 recovery resubmits the exact persisted payload, not changed config/body');
  assert.equal((await mail.findQueueItem(retryItem.id, rootDir)).item.status, 'processing_for_reply');
  console.log('email admission: lost HTTP receipt recovery, durable exact payload/runtime, no attachment re-upload and retry after pre-admission failure passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
