#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  findQueueItem,
  getMailboxStatus,
  initializeMailbox,
  ingestRawMessage,
  mailboxPaths,
  saveMailboxAutomation,
} from './lib/agent-mailbox.mjs';

function testCloudflareWebhookHealthy() {
  const rootDir = mkdtempSync(join(tmpdir(), 'remotelab-agent-mailbox-healthy-'));
  try {
    initializeMailbox({
      rootDir,
      name: 'Rowan',
      localPart: 'rowan',
      domain: 'example.com',
      allowEmails: ['owner@example.com'],
    });
    writeFileSync(
      mailboxPaths(rootDir).bridgeFile,
      `${JSON.stringify({
        provider: 'cloudflare_email_worker',
        emailAddress: 'rowan@example.com',
        validation: {
          publicHealth: 'pass',
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const status = getMailboxStatus(rootDir);
    assert.equal(status.effectiveStatus, 'public_webhook_healthy');
    assert.equal(status.publicIngress, 'public_webhook_healthy');
    assert.equal(status.diagnostics.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function testCloudflareQueueReady() {
  const rootDir = mkdtempSync(join(tmpdir(), 'remotelab-agent-mailbox-ready-'));
  try {
    initializeMailbox({
      rootDir,
      name: 'Rowan',
      localPart: 'rowan',
      domain: 'example.com',
      allowEmails: ['owner@example.com'],
    });
    writeFileSync(
      mailboxPaths(rootDir).bridgeFile,
      `${JSON.stringify({
        provider: 'cloudflare_email_worker',
        emailAddress: 'rowan@example.com',
        validation: {
          publicHealth: 'pass',
          queueReadyForRealMail: true,
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const status = getMailboxStatus(rootDir);
    assert.equal(status.effectiveStatus, 'ready_for_external_mail');
    assert.equal(status.publicIngress, 'ready_for_external_mail');
    assert.equal(status.diagnostics.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function testCloudflareValidatedDelivery() {
  const rootDir = mkdtempSync(join(tmpdir(), 'remotelab-agent-mailbox-validated-'));
  try {
    initializeMailbox({
      rootDir,
      name: 'Rowan',
      localPart: 'rowan',
      domain: 'example.com',
      allowEmails: ['owner@example.com'],
    });
    writeFileSync(
      mailboxPaths(rootDir).bridgeFile,
      `${JSON.stringify({
        provider: 'cloudflare_email_worker',
        emailAddress: 'rowan@example.com',
        validation: {
          publicHealth: 'pass',
          queueReadyForRealMail: true,
          realExternalMailValidated: true,
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const status = getMailboxStatus(rootDir);
    assert.equal(status.effectiveStatus, 'external_mail_validated');
    assert.equal(status.publicIngress, 'external_mail_validated');
    assert.equal(status.diagnostics.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function testAllowlistAutoApprove() {
  const rootDir = mkdtempSync(join(tmpdir(), 'remotelab-agent-mailbox-auto-approve-'));
  try {
    initializeMailbox({
      rootDir,
      name: 'Rowan',
      localPart: 'rowan',
      domain: 'example.com',
      allowEmails: ['owner@example.com'],
    });
    saveMailboxAutomation(rootDir, {
      allowlistAutoApprove: true,
      autoApproveReviewer: 'auto-test',
    });

    const ingested = ingestRawMessage(
      [
        'From: owner@example.com',
        'To: rowan@example.com',
        'Subject: hello!',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'please take a response to test!',
      ].join('\n'),
      'test.eml',
      rootDir,
      { text: 'please take a response to test!' },
    );

    const located = findQueueItem(ingested.id, rootDir);
    assert.equal(located?.queueName, 'approved');
    assert.equal(located?.item?.status, 'approved_for_ai');
    assert.equal(located?.item?.review?.status, 'auto_approved');
    assert.equal(located?.item?.review?.reviewer, 'auto-test');
    assert.equal(located?.item?.security?.aiEligible, true);
    assert.equal(located?.item?.security?.manualReviewRequired, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function testStripsQuotedReplyContent() {
  const rootDir = mkdtempSync(join(tmpdir(), 'remotelab-agent-mailbox-quoted-reply-'));
  try {
    initializeMailbox({
      rootDir,
      name: 'Rowan',
      localPart: 'rowan',
      domain: 'jiujianian.dev',
      allowEmails: ['jiujianian@gmail.com'],
    });

    const ingested = ingestRawMessage(
      [
        'From: jiujianian@gmail.com',
        'To: rowan@jiujianian.dev',
        'Subject: Re: hello!',
        'Message-ID: <reply-message@example.com>',
        'In-Reply-To: <root-thread@example.com>',
        'References: <root-thread@example.com>',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'email test turn2, did you continue use the same remotelab chat session ?',
        '',
        'On Tue, Mar 10, 2026 at 9:56 PM <rowan@jiujianian.dev> wrote:',
        '> Hi! Got your test email successfully — everything looks good on my end.',
        '>',
        '> Best,',
        '> Rowan',
      ].join('\n'),
      'quoted-reply.eml',
      rootDir,
      {
        text: [
          'email test turn2, did you continue use the same remotelab chat session ?',
          '',
          'On Tue, Mar 10, 2026 at 9:56 PM <rowan@jiujianian.dev> wrote:',
          '> Hi! Got your test email successfully — everything looks good on my end.',
          '>',
          '> Best,',
          '> Rowan',
        ].join('\n'),
      },
    );

    assert.equal(ingested.content.extractedText, 'email test turn2, did you continue use the same remotelab chat session ?');
    assert.equal(ingested.content.preview, 'email test turn2, did you continue use the same remotelab chat session ?');
    assert.doesNotMatch(ingested.content.extractedText, /wrote:/i);
    assert.doesNotMatch(ingested.content.extractedText, /^>/m);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function testStripsUniformQuotedReplyContent() {
  const rootDir = mkdtempSync(join(tmpdir(), 'remotelab-agent-mailbox-uniform-quoted-reply-'));
  try {
    initializeMailbox({
      rootDir,
      name: 'Rowan',
      localPart: 'rowan',
      domain: 'jiujianian.dev',
      allowEmails: ['jiujianian@gmail.com'],
    });

    const ingested = ingestRawMessage(
      [
        'From: jiujianian@gmail.com',
        'To: rowan@jiujianian.dev',
        'Subject: Re: hello!',
        'Message-ID: <reply-message-quoted@example.com>',
        'In-Reply-To: <root-thread@example.com>',
        'References: <root-thread@example.com>',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        '> email trim test turn2, did you continue use the same remotelab chat session ?',
        '>',
        '> On Tue, Mar 10, 2026 at 9:56 PM <rowan@jiujianian.dev> wrote:',
        '> > Hi! Got your test email successfully - everything looks good on my end.',
        '> >',
        '> > Best,',
        '> > Rowan',
      ].join('\n'),
      'uniform-quoted-reply.eml',
      rootDir,
      {
        text: [
          '> email trim test turn2, did you continue use the same remotelab chat session ?',
          '>',
          '> On Tue, Mar 10, 2026 at 9:56 PM <rowan@jiujianian.dev> wrote:',
          '> > Hi! Got your test email successfully - everything looks good on my end.',
          '> >',
          '> > Best,',
          '> > Rowan',
        ].join('\n'),
      },
    );

    assert.equal(ingested.content.extractedText, 'email trim test turn2, did you continue use the same remotelab chat session ?');
    assert.equal(ingested.content.preview, 'email trim test turn2, did you continue use the same remotelab chat session ?');
    assert.doesNotMatch(ingested.content.extractedText, /wrote:/i);
    assert.doesNotMatch(ingested.content.extractedText, /^>/m);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function testDecodesBase64BodyText() {
  const rootDir = mkdtempSync(join(tmpdir(), 'remotelab-agent-mailbox-base64-body-'));
  try {
    initializeMailbox({
      rootDir,
      name: 'Rowan',
      localPart: 'rowan',
      domain: 'jiujianian.dev',
      allowEmails: ['jiujianian@gmail.com'],
    });

    const decodedBody = '这一次请完整的回复我这一轮对话给你发送的消息，不要带其他内容。';
    const encodedBody = Buffer.from(decodedBody, 'utf8').toString('base64');

    const ingested = ingestRawMessage(
      [
        'From: jiujianian@gmail.com',
        'To: rowan@jiujianian.dev',
        'Subject: Re: test',
        'Message-ID: <base64-message@example.com>',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        encodedBody,
      ].join('\n'),
      'base64-body.eml',
      rootDir,
    );

    assert.equal(ingested.content.extractedText, decodedBody);
    assert.equal(ingested.content.preview, decodedBody);
    assert.ok(ingested.message.headers['content-transfer-encoding'], 'content-transfer-encoding should be preserved for debugging');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function testDecodesNestedMultipartBodyText() {
  const rootDir = mkdtempSync(join(tmpdir(), 'remotelab-agent-mailbox-nested-multipart-'));
  try {
    initializeMailbox({
      rootDir,
      name: 'Rowan',
      localPart: 'rowan',
      domain: 'jiujianian.dev',
      allowEmails: ['jiujianian@gmail.com'],
    });

    const decodedBody = '请先把邮件入口的正文解码后，再发起会话。';
    const encodedBody = Buffer.from(decodedBody, 'utf8').toString('base64');

    const ingested = ingestRawMessage(
      [
        'From: jiujianian@gmail.com',
        'To: rowan@jiujianian.dev',
        'Subject: Nested MIME test',
        'Message-ID: <nested-mime-message@example.com>',
        'Content-Type: multipart/mixed; boundary="mixed-boundary"',
        '',
        '--mixed-boundary',
        'Content-Type: multipart/alternative; boundary="alt-boundary"',
        '',
        '--alt-boundary',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        encodedBody,
        '--alt-boundary',
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        '<div>=E8=AF=B7=E5=85=88=E6=8A=8A=E9=82=AE=E4=BB=B6=E5=85=A5=E5=8F=A3=E7=9A=84=E6=AD=A3=E6=96=87=E8=A7=A3=E7=A0=81=E5=90=8E=EF=BC=8C=E5=86=8D=E5=8F=91=E8=B5=B7=E4=BC=9A=E8=AF=9D=E3=80=82</div>',
        '--alt-boundary--',
        '--mixed-boundary',
        'Content-Type: application/octet-stream; name="ignored.bin"',
        'Content-Disposition: attachment; filename="ignored.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('ignored attachment', 'utf8').toString('base64'),
        '--mixed-boundary--',
      ].join('\n'),
      'nested-multipart.eml',
      rootDir,
    );

    assert.equal(ingested.content.extractedText, decodedBody);
    assert.equal(ingested.content.preview, decodedBody);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

testCloudflareWebhookHealthy();
testCloudflareQueueReady();
testCloudflareValidatedDelivery();
testAllowlistAutoApprove();
testStripsQuotedReplyContent();
testStripsUniformQuotedReplyContent();
testDecodesBase64BodyText();
testDecodesNestedMultipartBodyText();
console.log('agent mailbox tests passed');
