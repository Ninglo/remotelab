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
const { sendOutboundEmail } = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mail-outbound.mjs')).href);
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
  await initializeMailbox({
    rootDir: mailboxRoot,
    name: 'Rowan',
    localPart: 'rowan',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
  });

  await saveOutboundConfig(mailboxRoot, {
    provider: 'apple_mail',
    account: 'Google',
  });

  const ingestedAppleMail = await ingestRawMessage(
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

  const approvedAppleMail = await approveMessage(ingestedAppleMail.id, mailboxRoot, 'tester');
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

  const updatedAppleMail = (await findQueueItem(approvedAppleMail.id, mailboxRoot))?.item;
  assert.equal(updatedAppleMail?.status, 'reply_sent');
  assert.equal(updatedAppleMail?.automation?.status, 'reply_sent');
  assert.equal(updatedAppleMail?.automation?.runId, appleRun.id);
  assert.equal(updatedAppleMail?.automation?.delivery?.provider, 'apple_mail');

  await saveOutboundConfig(mailboxRoot, {
    provider: 'cloudflare_worker',
    workerBaseUrl: `http://127.0.0.1:${port}`,
    from: 'rowan@example.com',
    workerToken: 'cloudflare-worker-secret',
  });

  const ingestedCloudflare = await ingestRawMessage(
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

  const approvedCloudflare = await approveMessage(ingestedCloudflare.id, mailboxRoot, 'tester');
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

  const updatedCloudflare = (await findQueueItem(approvedCloudflare.id, mailboxRoot))?.item;
  assert.equal(updatedCloudflare?.status, 'reply_sent');
  assert.equal(updatedCloudflare?.automation?.status, 'reply_sent');
  assert.equal(updatedCloudflare?.automation?.runId, cloudflareRun.id);
  assert.equal(updatedCloudflare?.automation?.delivery?.provider, 'cloudflare_worker');

  await saveOutboundConfig(mailboxRoot, {
    provider: 'resend_api',
    apiBaseUrl: 'https://api.resend.test',
    from: 'rowan@example.com',
    apiKey: 'resend-api-secret',
  });

  const ingestedResend = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: hello from resend api!',
      'Date: Tue, 10 Mar 2026 03:02:00 +0800',
      'Message-ID: <mail-resend-test@example.com>',
      'References: <root-resend@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'please test the Resend sender!',
    ].join('\n'),
    'resend-api-test.eml',
    mailboxRoot,
    { text: 'please test the Resend sender!' },
  );

  const approvedResend = await approveMessage(ingestedResend.id, mailboxRoot, 'tester');
  const resendRequestId = `mailbox_reply_${approvedResend.id}`;
  const resendSession = await createSession(workspace, 'codex', 'Resend API reply test', {
    completionTargets: [{
      type: 'email',
      requestId: resendRequestId,
      to: 'owner@example.com',
      subject: 'Re: hello from resend api!',
      inReplyTo: '<mail-resend-test@example.com>',
      references: '<root-resend@example.com> <mail-resend-test@example.com>',
      mailboxRoot,
      mailboxItemId: approvedResend.id,
    }],
  });
  const resendRun = await createRun({
    status: {
      sessionId: resendSession.id,
      requestId: resendRequestId,
      state: 'completed',
      tool: 'codex',
    },
    manifest: {
      sessionId: resendSession.id,
      requestId: resendRequestId,
      folder: workspace,
      tool: 'codex',
      prompt: 'reply to the email via Resend API',
      options: {},
    },
  });

  await appendEvent(resendSession.id, messageEvent('assistant', 'Received — Resend API test successful.', undefined, {
    runId: resendRun.id,
    requestId: resendRequestId,
  }));

  const resendRequests = [];
  const resendDeliveries = await dispatchSessionEmailCompletionTargets(resendSession, resendRun, {
    fetchImpl: async (url, init) => {
      resendRequests.push({ url, init });
      return new Response(JSON.stringify({ id: 're_123' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.equal(resendDeliveries.length, 1);
  assert.equal(resendDeliveries[0].state, 'sent');
  assert.equal(resendDeliveries[0].delivery?.provider, 'resend_api');
  assert.equal(resendDeliveries[0].delivery?.responseId, 're_123');
  assert.equal(resendRequests.length, 1);
  assert.equal(resendRequests[0].url, 'https://api.resend.test/emails');
  assert.equal(resendRequests[0].init.method, 'POST');
  assert.equal(resendRequests[0].init.headers.Authorization, 'Bearer resend-api-secret');
  assert.deepEqual(JSON.parse(resendRequests[0].init.body), {
    from: 'rowan@example.com',
    to: 'owner@example.com',
    subject: 'Re: hello from resend api!',
    text: 'Received — Resend API test successful.',
    headers: {
      'In-Reply-To': '<mail-resend-test@example.com>',
      References: '<root-resend@example.com> <mail-resend-test@example.com>',
    },
  });

  const updatedResend = (await findQueueItem(approvedResend.id, mailboxRoot))?.item;
  assert.equal(updatedResend?.status, 'reply_sent');
  assert.equal(updatedResend?.automation?.status, 'reply_sent');
  assert.equal(updatedResend?.automation?.runId, resendRun.id);
  assert.equal(updatedResend?.automation?.delivery?.provider, 'resend_api');

  await saveOutboundConfig(mailboxRoot, {
    provider: 'cloudflare_worker',
    workerBaseUrl: `http://127.0.0.1:${port}`,
    from: 'rowan@example.com',
    workerToken: 'cloudflare-worker-secret',
  });

  const ingestedBlankSubject = await ingestRawMessage(
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

  const approvedBlankSubject = await approveMessage(ingestedBlankSubject.id, mailboxRoot, 'tester');
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

  const updatedBlankSubject = (await findQueueItem(approvedBlankSubject.id, mailboxRoot))?.item;
  assert.equal(updatedBlankSubject?.status, 'reply_sent');
  assert.equal(updatedBlankSubject?.automation?.status, 'reply_sent');
  assert.equal(updatedBlankSubject?.automation?.runId, blankSubjectRun.id);
  assert.equal(updatedBlankSubject?.automation?.delivery?.provider, 'cloudflare_worker');

  const ingestedTodoTail = await ingestRawMessage(
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

  const approvedTodoTail = await approveMessage(ingestedTodoTail.id, mailboxRoot, 'tester');
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

  const updatedTodoTail = (await findQueueItem(approvedTodoTail.id, mailboxRoot))?.item;
  assert.equal(updatedTodoTail?.status, 'reply_sent');
  assert.equal(updatedTodoTail?.automation?.status, 'reply_sent');
  assert.equal(updatedTodoTail?.automation?.runId, todoTailRun.id);
  assert.equal(updatedTodoTail?.automation?.delivery?.provider, 'cloudflare_worker');

  const ingestedRetry = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: clear retry error state',
      'Date: Tue, 10 Mar 2026 03:15:00 +0800',
      'Message-ID: <mail-cloudflare-retry-clear@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'please verify that a later success clears the prior failure state.',
    ].join('\n'),
    'cloudflare-worker-retry-clear.eml',
    mailboxRoot,
    { text: 'please verify that a later success clears the prior failure state.' },
  );

  const approvedRetry = await approveMessage(ingestedRetry.id, mailboxRoot, 'tester');
  const retryRequestId = `mailbox_reply_${approvedRetry.id}`;
  const retrySession = await createSession(workspace, 'codex', 'Cloudflare retry clear test', {
    completionTargets: [{
      type: 'email',
      requestId: retryRequestId,
      to: 'owner@example.com',
      subject: 'Re: clear retry error state',
      inReplyTo: '<mail-cloudflare-retry-clear@example.com>',
      references: '<mail-cloudflare-retry-clear@example.com>',
      mailboxRoot,
      mailboxItemId: approvedRetry.id,
    }],
  });
  const retryRun = await createRun({
    status: {
      sessionId: retrySession.id,
      requestId: retryRequestId,
      state: 'completed',
      tool: 'codex',
    },
    manifest: {
      sessionId: retrySession.id,
      requestId: retryRequestId,
      folder: workspace,
      tool: 'codex',
      prompt: 'reply to the email, fail once, then succeed',
      options: {},
    },
  });

  await appendEvent(retrySession.id, messageEvent('assistant', 'Retry-success reply body.', undefined, {
    runId: retryRun.id,
    requestId: retryRequestId,
  }));

  const retryCurlRequests = [];
  const forcedFailureDeliveries = await dispatchSessionEmailCompletionTargets(retrySession, retryRun, {
    fetchImpl: async () => {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
      throw error;
    },
    sendCloudflareWorkerViaCurlImpl: async (request, prepared) => {
      retryCurlRequests.push({ request, prepared });
      return {
        provider: prepared.provider,
        authMode: 'bearer_token',
        statusCode: 202,
        response: { id: 'msg_retry_123', message: 'queued' },
        summary: { id: 'msg_retry_123', message: 'queued' },
      };
    },
  });
  assert.equal(forcedFailureDeliveries.length, 1);
  assert.equal(forcedFailureDeliveries[0].state, 'sent');
  assert.equal(retryCurlRequests.length, 1);

  const updatedRetryItem = (await findQueueItem(approvedRetry.id, mailboxRoot))?.item;
  assert.equal(updatedRetryItem?.status, 'reply_sent');
  assert.equal(updatedRetryItem?.automation?.status, 'reply_sent');
  assert.equal(updatedRetryItem?.automation?.lastError, null);
  assert.equal(updatedRetryItem?.automation?.delivery?.provider, 'cloudflare_worker');

  await saveOutboundConfig(mailboxRoot, {
    provider: 'cloudflare_worker',
    workerBaseUrl: `http://127.0.0.1:${port}`,
    from: 'rowan@example.com',
    workerToken: 'cloudflare-worker-secret',
    fallback: {
      provider: 'apple_mail',
      account: 'Google',
    },
  });

  const ingestedFallback = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: hello from fallback routing!',
      'Date: Tue, 10 Mar 2026 05:00:00 +0800',
      'Message-ID: <mail-fallback-test@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'please test fallback routing for non-verified recipients!',
    ].join('\n'),
    'fallback-routing-test.eml',
    mailboxRoot,
    { text: 'please test fallback routing for non-verified recipients!' },
  );

  const approvedFallback = await approveMessage(ingestedFallback.id, mailboxRoot, 'tester');
  const fallbackRequestId = `mailbox_reply_${approvedFallback.id}`;
  const fallbackSession = await createSession(workspace, 'codex', 'Fallback outbound reply test', {
    completionTargets: [{
      type: 'email',
      requestId: fallbackRequestId,
      to: 'outside@example.net',
      subject: 'Re: hello from fallback routing!',
      mailboxRoot,
      mailboxItemId: approvedFallback.id,
    }],
  });
  const fallbackRun = await createRun({
    status: {
      sessionId: fallbackSession.id,
      requestId: fallbackRequestId,
      state: 'completed',
      tool: 'codex',
    },
    manifest: {
      sessionId: fallbackSession.id,
      requestId: fallbackRequestId,
      folder: workspace,
      tool: 'codex',
      prompt: 'reply using cloudflare first, then fallback if needed',
      options: {},
    },
  });

  await appendEvent(fallbackSession.id, messageEvent('assistant', 'Fallback reply body.', undefined, {
    runId: fallbackRun.id,
    requestId: fallbackRequestId,
  }));

  const fallbackAppleMailMessages = [];
  const fallbackDeliveries = await dispatchSessionEmailCompletionTargets(fallbackSession, fallbackRun, {
    fetchImpl: async () => ({
      status: 502,
      text: async () => JSON.stringify({
        error: 'Failed to send email',
        details: {
          message: 'destination address is not a verified address',
        },
      }),
    }),
    sendAppleMailMessageImpl: async (message) => {
      fallbackAppleMailMessages.push(message);
      return {
        sender: 'Google <owner@example.com>',
      };
    },
  });
  assert.equal(fallbackDeliveries.length, 1);
  assert.equal(fallbackDeliveries[0].state, 'sent');
  assert.equal(fallbackDeliveries[0].delivery?.provider, 'apple_mail');
  assert.equal(fallbackDeliveries[0].delivery?.requestedProvider, 'cloudflare_worker');
  assert.equal(fallbackDeliveries[0].delivery?.fallbackFromProvider, 'cloudflare_worker');
  assert.equal(fallbackDeliveries[0].delivery?.fallbackReason, 'cloudflare_verified_destination_only');
  assert.equal(fallbackAppleMailMessages.length, 1);
  assert.deepEqual(fallbackAppleMailMessages[0], {
    provider: 'apple_mail',
    account: 'Google',
    from: '',
    to: ['outside@example.net'],
    subject: 'Re: hello from fallback routing!',
    text: 'Fallback reply body.',
  });

  const updatedFallbackItem = (await findQueueItem(approvedFallback.id, mailboxRoot))?.item;
  assert.equal(updatedFallbackItem?.status, 'reply_sent');
  assert.equal(updatedFallbackItem?.automation?.status, 'reply_sent');
  assert.equal(updatedFallbackItem?.automation?.delivery?.provider, 'apple_mail');
  assert.equal(updatedFallbackItem?.automation?.delivery?.requestedProvider, 'cloudflare_worker');
  assert.equal(updatedFallbackItem?.automation?.delivery?.fallbackFromProvider, 'cloudflare_worker');
  assert.equal(updatedFallbackItem?.automation?.delivery?.fallbackReason, 'cloudflare_verified_destination_only');

  const requestedRecipientIndex = requests.length;
  const requestedRecipientResult = await sendOutboundEmail({
    to: 'recipient@outside.test',
    from: 'rowan@example.com',
    subject: 'Direct external recipient test',
    text: 'Cloudflare outbound client should preserve the requested recipient.',
  }, {
    provider: 'cloudflare_worker',
    workerBaseUrl: `http://127.0.0.1:${port}`,
    workerToken: 'cloudflare-worker-secret',
  });
  assert.equal(requestedRecipientResult.statusCode, 200);
  assert.equal(requests.length, requestedRecipientIndex + 1);
  assert.deepEqual(JSON.parse(requests[requestedRecipientIndex].body), {
    to: ['recipient@outside.test'],
    from: 'rowan@example.com',
    subject: 'Direct external recipient test',
    text: 'Cloudflare outbound client should preserve the requested recipient.',
    inReplyTo: '',
    references: '',
  });

  const curlRequests = [];
  const curlTransportResult = await sendOutboundEmail({
    to: 'owner@example.com',
    from: 'rowan@example.com',
    subject: 'Proxy-aware Cloudflare worker send',
    text: 'Curl transport success.',
  }, {
    provider: 'cloudflare_worker',
    workerBaseUrl: `http://127.0.0.1:${port}`,
    workerToken: 'cloudflare-worker-secret',
  }, {
    forceCurlTransport: true,
    sendCloudflareWorkerViaCurlImpl: async (request, prepared) => {
      curlRequests.push({ request, prepared });
      return {
        provider: prepared.provider,
        authMode: 'bearer_token',
        statusCode: 202,
        response: { id: 'msg_curl_123', message: 'queued' },
        summary: { id: 'msg_curl_123', message: 'queued' },
      };
    },
  });
  assert.equal(curlTransportResult.statusCode, 202);
  assert.equal(curlTransportResult.provider, 'cloudflare_worker');
  assert.equal(curlRequests.length, 1);
  assert.equal(curlRequests[0].request.url, `http://127.0.0.1:${port}/api/send-email`);
  assert.deepEqual(JSON.parse(curlRequests[0].request.body), {
    to: ['owner@example.com'],
    from: 'rowan@example.com',
    subject: 'Proxy-aware Cloudflare worker send',
    text: 'Curl transport success.',
    inReplyTo: '',
    references: '',
  });
} finally {
  server.close();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('agent mail reply tests passed');
