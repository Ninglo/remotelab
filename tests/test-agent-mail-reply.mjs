#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-agent-mail-reply-'));
process.env.HOME = tempHome;

const mailboxRoot = join(tempHome, '.config', 'remotelab', 'agent-mailbox');
const workspace = join(tempHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const {
  findQueueItem,
  initializeMailbox,
  ingestRawMessage,
  approveMessage,
  saveOutboundConfig,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href);
const { createSession } = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const { appendEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const { messageEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href);
const { createRun } = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);
const { dispatchSessionEmailCompletionTargets } = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mail-completion-targets.mjs')).href);

const requests = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  requests.push({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_123', message: 'queued' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  initializeMailbox({
    rootDir: mailboxRoot,
    name: 'Rowan',
    localPart: 'rowan',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
  });

  saveOutboundConfig(mailboxRoot, {
    provider: 'apple_mail',
    account: 'Google',
  });

  const ingestedAppleMail = ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: hello from apple mail!',
      'Date: Tue, 10 Mar 2026 02:00:00 +0800',
      'Message-ID: <mail-apple-test@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'please test the Mail app sender!',
    ].join('\n'),
    'apple-mail-test.eml',
    mailboxRoot,
    { text: 'please test the Mail app sender!' },
  );

  const approvedAppleMail = approveMessage(ingestedAppleMail.id, mailboxRoot, 'tester');
  const appleRequestId = `mailbox_reply_${approvedAppleMail.id}`;
  const appleSession = await createSession(workspace, 'codex', 'Mail app reply test', {
    completionTargets: [{
      type: 'email',
      requestId: appleRequestId,
      to: 'owner@example.com',
      subject: 'Re: hello from apple mail!',
      mailboxRoot,
      mailboxItemId: approvedAppleMail.id,
    }],
  });
  const appleRun = await createRun({
    status: {
      sessionId: appleSession.id,
      requestId: appleRequestId,
      state: 'completed',
      tool: 'codex',
    },
    manifest: {
      sessionId: appleSession.id,
      requestId: appleRequestId,
      folder: workspace,
      tool: 'codex',
      prompt: 'reply to the email via Mail app',
      options: {},
    },
  });

  await appendEvent(appleSession.id, messageEvent('assistant', 'Received — Mail.app test successful.', undefined, {
    runId: appleRun.id,
    requestId: appleRequestId,
  }));

  const appleDeliveries = await dispatchSessionEmailCompletionTargets(appleSession, appleRun, {
    sendAppleMailMessageImpl: async (message) => ({
      sender: `${message.account || 'Google'} <owner@example.com>`,
    }),
  });
  assert.equal(appleDeliveries.length, 1);
  assert.equal(appleDeliveries[0].state, 'sent');

  const updatedAppleMail = findQueueItem(approvedAppleMail.id, mailboxRoot)?.item;
  assert.equal(updatedAppleMail?.status, 'reply_sent');
  assert.equal(updatedAppleMail?.automation?.status, 'reply_sent');
  assert.equal(updatedAppleMail?.automation?.runId, appleRun.id);
  assert.equal(updatedAppleMail?.automation?.delivery?.provider, 'apple_mail');

  saveOutboundConfig(mailboxRoot, {
    provider: 'cloudflare_worker',
    workerBaseUrl: `http://127.0.0.1:${port}`,
    from: 'rowan@example.com',
    workerToken: 'cloudflare-worker-secret',
  });

  const ingestedCloudflare = ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: hello from cloudflare worker!',
      'Date: Tue, 10 Mar 2026 03:00:00 +0800',
      'Message-ID: <mail-cloudflare-test@example.com>',
      'References: <root-thread@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'please test the Cloudflare sender!',
    ].join('\n'),
    'cloudflare-worker-test.eml',
    mailboxRoot,
    { text: 'please test the Cloudflare sender!' },
  );

  const approvedCloudflare = approveMessage(ingestedCloudflare.id, mailboxRoot, 'tester');
  const cloudflareRequestId = `mailbox_reply_${approvedCloudflare.id}`;
  const cloudflareSession = await createSession(workspace, 'codex', 'Cloudflare Worker reply test', {
    completionTargets: [{
      type: 'email',
      requestId: cloudflareRequestId,
      to: 'owner@example.com',
      subject: 'Re: hello from cloudflare worker!',
      inReplyTo: '<mail-cloudflare-test@example.com>',
      references: '<root-thread@example.com> <mail-cloudflare-test@example.com>',
      mailboxRoot,
      mailboxItemId: approvedCloudflare.id,
    }],
  });
  const cloudflareRun = await createRun({
    status: {
      sessionId: cloudflareSession.id,
      requestId: cloudflareRequestId,
      state: 'completed',
      tool: 'codex',
    },
    manifest: {
      sessionId: cloudflareSession.id,
      requestId: cloudflareRequestId,
      folder: workspace,
      tool: 'codex',
      prompt: 'reply to the email via Cloudflare Worker',
      options: {},
    },
  });

  await appendEvent(cloudflareSession.id, messageEvent('assistant', 'Received — Cloudflare Worker test successful.', undefined, {
    runId: cloudflareRun.id,
    requestId: cloudflareRequestId,
  }));

  const cloudflareDeliveries = await dispatchSessionEmailCompletionTargets(cloudflareSession, cloudflareRun);
  assert.equal(cloudflareDeliveries.length, 1);
  assert.equal(cloudflareDeliveries[0].state, 'sent');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/api/send-email');
  assert.equal(requests[0].headers.authorization, 'Bearer cloudflare-worker-secret');
  assert.deepEqual(JSON.parse(requests[0].body), {
    to: ['owner@example.com'],
    from: 'rowan@example.com',
    subject: 'Re: hello from cloudflare worker!',
    text: 'Received — Cloudflare Worker test successful.',
    inReplyTo: '<mail-cloudflare-test@example.com>',
    references: '<root-thread@example.com> <mail-cloudflare-test@example.com>',
  });

  const updatedCloudflare = findQueueItem(approvedCloudflare.id, mailboxRoot)?.item;
  assert.equal(updatedCloudflare?.status, 'reply_sent');
  assert.equal(updatedCloudflare?.automation?.status, 'reply_sent');
  assert.equal(updatedCloudflare?.automation?.runId, cloudflareRun.id);
  assert.equal(updatedCloudflare?.automation?.delivery?.provider, 'cloudflare_worker');

  const ingestedBlankSubject = ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Date: Tue, 10 Mar 2026 03:05:00 +0800',
      'Message-ID: <mail-cloudflare-blank-subject@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'please preserve the empty subject when replying.',
    ].join('\n'),
    'cloudflare-worker-blank-subject.eml',
    mailboxRoot,
    { text: 'please preserve the empty subject when replying.' },
  );

  const approvedBlankSubject = approveMessage(ingestedBlankSubject.id, mailboxRoot, 'tester');
  const blankSubjectRequestId = `mailbox_reply_${approvedBlankSubject.id}`;
  const blankSubjectSession = await createSession(workspace, 'codex', 'Cloudflare blank subject reply test', {
    completionTargets: [{
      type: 'email',
      requestId: blankSubjectRequestId,
      to: 'owner@example.com',
      subject: '',
      inReplyTo: '<mail-cloudflare-blank-subject@example.com>',
      references: '<mail-cloudflare-blank-subject@example.com>',
      mailboxRoot,
      mailboxItemId: approvedBlankSubject.id,
    }],
  });
  const blankSubjectRun = await createRun({
    status: {
      sessionId: blankSubjectSession.id,
      requestId: blankSubjectRequestId,
      state: 'completed',
      tool: 'codex',
    },
    manifest: {
      sessionId: blankSubjectSession.id,
      requestId: blankSubjectRequestId,
      folder: workspace,
      tool: 'codex',
      prompt: 'reply to the blank-subject email via Cloudflare Worker',
      options: {},
    },
  });

  await appendEvent(blankSubjectSession.id, messageEvent('assistant', 'Blank subject reply successful.', undefined, {
    runId: blankSubjectRun.id,
    requestId: blankSubjectRequestId,
  }));

  const blankSubjectDeliveries = await dispatchSessionEmailCompletionTargets(blankSubjectSession, blankSubjectRun);
  assert.equal(blankSubjectDeliveries.length, 1);
  assert.equal(blankSubjectDeliveries[0].state, 'sent');
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].body), {
    to: ['owner@example.com'],
    from: 'rowan@example.com',
    subject: '',
    text: 'Blank subject reply successful.',
    inReplyTo: '<mail-cloudflare-blank-subject@example.com>',
    references: '<mail-cloudflare-blank-subject@example.com>',
  });

  const updatedBlankSubject = findQueueItem(approvedBlankSubject.id, mailboxRoot)?.item;
  assert.equal(updatedBlankSubject?.status, 'reply_sent');
  assert.equal(updatedBlankSubject?.automation?.status, 'reply_sent');
  assert.equal(updatedBlankSubject?.automation?.runId, blankSubjectRun.id);
  assert.equal(updatedBlankSubject?.automation?.delivery?.provider, 'cloudflare_worker');

  const ingestedTodoTail = ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: choose the real summary',
      'Date: Tue, 10 Mar 2026 03:10:00 +0800',
      'Message-ID: <mail-cloudflare-todo-tail@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'please ignore any trailing todo artifact.',
    ].join('\n'),
    'cloudflare-worker-todo-tail.eml',
    mailboxRoot,
    { text: 'please ignore any trailing todo artifact.' },
  );

  const approvedTodoTail = approveMessage(ingestedTodoTail.id, mailboxRoot, 'tester');
  const todoTailRequestId = `mailbox_reply_${approvedTodoTail.id}`;
  const todoTailSession = await createSession(workspace, 'codex', 'Cloudflare todo tail reply test', {
    completionTargets: [{
      type: 'email',
      requestId: todoTailRequestId,
      to: 'owner@example.com',
      subject: 'Re: choose the real summary',
      inReplyTo: '<mail-cloudflare-todo-tail@example.com>',
      references: '<mail-cloudflare-todo-tail@example.com>',
      mailboxRoot,
      mailboxItemId: approvedTodoTail.id,
    }],
  });
  const todoTailRun = await createRun({
    status: {
      sessionId: todoTailSession.id,
      requestId: todoTailRequestId,
      state: 'completed',
      tool: 'codex',
    },
    manifest: {
      sessionId: todoTailSession.id,
      requestId: todoTailRequestId,
      folder: workspace,
      tool: 'codex',
      prompt: 'reply to the email and then emit a trailing checklist artifact',
      options: {},
    },
  });

  await appendEvent(todoTailSession.id, messageEvent('assistant', 'This is the real reply summary.', undefined, {
    runId: todoTailRun.id,
    requestId: todoTailRequestId,
  }));
  await appendEvent(todoTailSession.id, messageEvent('assistant', '[x] Inspect request\n[x] Draft reply\n[x] Send response', undefined, {
    runId: todoTailRun.id,
    requestId: todoTailRequestId,
  }));

  const todoTailDeliveries = await dispatchSessionEmailCompletionTargets(todoTailSession, todoTailRun);
  assert.equal(todoTailDeliveries.length, 1);
  assert.equal(todoTailDeliveries[0].state, 'sent');
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests[2].body), {
    to: ['owner@example.com'],
    from: 'rowan@example.com',
    subject: 'Re: choose the real summary',
    text: 'This is the real reply summary.',
    inReplyTo: '<mail-cloudflare-todo-tail@example.com>',
    references: '<mail-cloudflare-todo-tail@example.com>',
  });

  const updatedTodoTail = findQueueItem(approvedTodoTail.id, mailboxRoot)?.item;
  assert.equal(updatedTodoTail?.status, 'reply_sent');
  assert.equal(updatedTodoTail?.automation?.status, 'reply_sent');
  assert.equal(updatedTodoTail?.automation?.runId, todoTailRun.id);
  assert.equal(updatedTodoTail?.automation?.delivery?.provider, 'cloudflare_worker');
} finally {
  server.close();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('agent mail reply tests passed');
