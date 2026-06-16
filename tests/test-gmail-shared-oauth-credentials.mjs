#!/usr/bin/env node
import assert from 'assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempSystemHome = mkdtempSync(join(tmpdir(), 'remotelab-gmail-shared-home-'));
const guestRoot = join(tempSystemHome, 'guests', 'trial8');
const ownerInstanceCredentialsPath = join(
  tempSystemHome,
  '.remotelab',
  'instances',
  'owner',
  'config',
  'gmail-connector',
  'google-oauth-client.json',
);
const sharedCredentialsPath = join(
  tempSystemHome,
  '.config',
  'remotelab',
  'gmail-connector',
  'google-oauth-client.json',
);

process.env.HOME = guestRoot;
process.env.REMOTELAB_INSTANCE_ROOT = guestRoot;
process.env.REMOTELAB_SYSTEM_HOME = tempSystemHome;
delete process.env.REMOTELAB_CONFIG_DIR;
delete process.env.REMOTELAB_PUBLIC_BASE_URL;
delete process.env.REMOTELAB_GOOGLE_OAUTH_CLIENT_PATH;
delete process.env.REMOTELAB_GMAIL_OAUTH_CLIENT_PATH;
delete process.env.REMOTELAB_GOOGLE_OAUTH_CLIENT_JSON;
delete process.env.REMOTELAB_GMAIL_OAUTH_CLIENT_JSON;

mkdirSync(join(guestRoot, 'config'), { recursive: true });
mkdirSync(join(ownerInstanceCredentialsPath, '..'), { recursive: true });
writeFileSync(ownerInstanceCredentialsPath, JSON.stringify({
  installed: {
    client_id: 'owner-client-id',
    client_secret: 'owner-client-secret',
    redirect_uris: ['https://example.com/api/connectors/gmail/google/callback'],
  },
}), 'utf8');

const {
  gmailCredentialsPresent,
  resolveGmailCredentialsPath,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-gmail.mjs')).href);

try {
  const fallbackPath = await resolveGmailCredentialsPath();
  assert.equal(
    fallbackPath,
    ownerInstanceCredentialsPath,
    'guest instances should inherit the owner instance Gmail OAuth client when no shared config file exists',
  );
  assert.equal(await gmailCredentialsPresent(), true);

  unlinkSync(ownerInstanceCredentialsPath);
  process.env.REMOTELAB_GOOGLE_OAUTH_CLIENT_JSON = JSON.stringify({
    installed: {
      client_id: 'shared-client-id',
      client_secret: 'shared-client-secret',
      redirect_uris: ['https://example.com/api/connectors/gmail/google/callback'],
    },
  });
  const resolvedSharedPath = await resolveGmailCredentialsPath();
  assert.equal(
    resolvedSharedPath,
    sharedCredentialsPath,
    'env-provided Gmail OAuth JSON should materialize into the shared backend config path',
  );
  assert.equal(existsSync(sharedCredentialsPath), true);
  assert.equal(
    existsSync(join(guestRoot, 'config', 'gmail-connector', 'google-oauth-client.json')),
    false,
    'guest instances should not persist shared Gmail OAuth client credentials into instance-local config',
  );
  const written = JSON.parse(readFileSync(sharedCredentialsPath, 'utf8'));
  const normalized = written?.installed || written?.web || written;
  assert.equal(normalized?.client_id, 'shared-client-id');
  assert.equal(normalized?.client_secret, 'shared-client-secret');

  console.log('test-gmail-shared-oauth-credentials: ok');
} finally {
  rmSync(tempSystemHome, { recursive: true, force: true });
}
