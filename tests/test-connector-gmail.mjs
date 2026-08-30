#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-connector-gmail-'));
process.env.HOME = tempHome;
process.env.REMOTELAB_SYSTEM_HOME = tempHome;
delete process.env.REMOTELAB_INSTANCE_ROOT;
delete process.env.REMOTELAB_CONFIG_DIR;
delete process.env.REMOTELAB_PUBLIC_BASE_URL;
process.env.REMOTELAB_GOOGLE_OAUTH_CLIENT_JSON = JSON.stringify({
  installed: {
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    redirect_uris: ['https://example.com/api/connectors/gmail/google/callback'],
  },
});

const fakeTokenPath = join(tempHome, 'google-gmail-token.json');
mkdirSync(join(tempHome, '.config', 'remotelab'), { recursive: true });
writeFileSync(fakeTokenPath, JSON.stringify({ access_token: 'test-token' }), 'utf8');

const {
  ensureGmailConnectorBinding,
  resolveGmailConnectorBinding,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-bindings.mjs')).href);

const {
  __testing,
  gmailCredentialsPresent,
  parseGmailWebUrl,
  resolveGmailCredentialsPath,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-gmail.mjs')).href);

try {
  const binding = await ensureGmailConnectorBinding({
    provider: 'google',
    title: 'Gmail',
    gmailScope: 'https://www.googleapis.com/auth/gmail.modify',
  });
  assert.equal(binding.connectorId, 'gmail');
  assert.equal(binding.provider, 'google');
  assert.equal(binding.capabilityState, 'authorization_required');

  const readyBinding = await ensureGmailConnectorBinding({
    bindingId: binding.id,
    provider: 'google',
    accountHint: 'user@gmail.com',
    tokenPath: fakeTokenPath,
    title: 'user@gmail.com',
    gmailScope: 'https://www.googleapis.com/auth/gmail.modify',
  });
  assert.equal(readyBinding.capabilityState, 'ready');
  assert.equal(readyBinding.accountHint, 'user@gmail.com');
  assert.equal(readyBinding.gmailScope, 'https://www.googleapis.com/auth/gmail.modify');

  const resolved = await resolveGmailConnectorBinding({ bindingId: binding.id });
  assert.equal(resolved?.connectorId, 'gmail');
  assert.equal(resolved?.capabilityState, 'ready');

  const credentialsPath = await resolveGmailCredentialsPath();
  assert.match(credentialsPath, /google-oauth-client\.json$/);
  assert.equal(await gmailCredentialsPresent(), true);
  delete process.env.REMOTELAB_GOOGLE_OAUTH_CLIENT_JSON;
  writeFileSync(join(tempHome, '.config', 'remotelab', 'instance-settings.json'), JSON.stringify({
    googleOAuth: {
      clientId: 'instance-client-id',
      clientSecret: 'instance-client-secret',
      redirectUri: 'https://example.com/api/connectors/gmail/google/callback',
    },
  }), 'utf8');
  const settingsCredentialsPath = await resolveGmailCredentialsPath();
  const settingsCredentials = JSON.parse(readFileSync(settingsCredentialsPath, 'utf8'));
  const normalizedSettingsCredentials = settingsCredentials?.installed || settingsCredentials?.web || settingsCredentials;
  assert.equal(normalizedSettingsCredentials?.client_id, 'test-client-id');
  assert.equal(normalizedSettingsCredentials?.client_secret, 'test-client-secret');
  assert.notEqual(settingsCredentials?.remotelabManaged?.source, 'instance_settings');

  const threadUrl = parseGmailWebUrl('https://mail.google.com/mail/u/0/popout?search=inbox&th=%23thread-f%3A1862488384038594552&cvid=1');
  assert.equal(threadUrl.kind, 'thread');
  assert.equal(threadUrl.rawId, '1862488384038594552');
  assert.ok(threadUrl.candidates.includes('1862488384038594552'));
  assert.ok(threadUrl.candidates.includes(BigInt('1862488384038594552').toString(16)));

  const messageUrl = parseGmailWebUrl('https://mail.google.com/mail/u/0/?permmsgid=msg-f:1862488384038594553');
  assert.equal(messageUrl.kind, 'message');
  assert.equal(messageUrl.rawId, '1862488384038594553');
  assert.ok(messageUrl.candidates.includes(BigInt('1862488384038594553').toString(16)));

  const mime = __testing.buildMimeMessage({
    from: 'creator@example.com',
    to: ['operator@example.com'],
    subject: 'Re: Contract test',
    text: 'First line\n\nSecond paragraph',
    inReplyTo: '<original@example.com>',
    references: '<original@example.com>',
  });
  assert.match(
    mime,
    /Content-Transfer-Encoding: 8bit\r\n\r\nFirst line\n\nSecond paragraph$/,
    'Gmail MIME must preserve the required blank line between headers and the body',
  );
  assert.match(mime, /Subject: Re: Contract test\r\n/);

  const unicodeSubject = 'RemoteLab AI 邮件监控与模型更新提醒';
  const unicodeMime = __testing.buildMimeMessage({
    from: 'creator@example.com',
    to: ['operator@example.com'],
    subject: unicodeSubject,
    text: '中文正文',
  });
  const encodedWords = [...unicodeMime.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/gi)];
  assert.ok(encodedWords.length > 0, 'non-ASCII Gmail subjects must use RFC 2047 encoded words');
  assert.equal(
    encodedWords.map((match) => Buffer.from(match[1], 'base64').toString('utf8')).join(''),
    unicodeSubject,
  );
  assert.doesNotMatch(unicodeMime.split('\r\n\r\n')[0], /邮件监控/);
  assert.ok(
    encodedWords.every((match) => match[0].length <= 75),
    'each RFC 2047 encoded word must stay within the 75-character limit',
  );
  assert.equal(__testing.encodeMimeHeader('Status\r\nBcc: injected@example.com'), 'Status Bcc: injected@example.com');

  const companyMessage = {
    id: 'company-message',
    from: '<operator@company.example>',
    to: '<creator@gmail.com>',
    messageIdHeader: '<company-message@example.com>',
  };
  const creatorMessage = {
    id: 'creator-message',
    from: 'creator@gmail.com',
    to: '<operator@company.example>',
    messageIdHeader: '<creator-message@example.com>',
  };
  assert.equal(
    __testing.replySourceMessage({ latestMessage: creatorMessage }, companyMessage),
    companyMessage,
    'an explicit --message-id must be the reply source even when a newer self-authored message exists',
  );
  assert.equal(__testing.replyRecipient(companyMessage, 'creator@gmail.com'), '<operator@company.example>');
  assert.equal(
    __testing.replyRecipient(creatorMessage, 'creator@gmail.com'),
    'operator@company.example',
    'replying from a thread whose latest message is self-authored must target the original recipient',
  );

  console.log('test-connector-gmail: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
