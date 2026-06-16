#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-gmail-oauth-state-'));
const configDir = join(tempHome, '.config', 'remotelab');

process.env.HOME = tempHome;
process.env.REMOTELAB_CONFIG_DIR = configDir;
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://auth.example.com';

mkdirSync(configDir, { recursive: true });

const gmailModule = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-gmail.mjs')).href);
const routerModule = await import(pathToFileURL(join(repoRoot, 'chat', 'router-connector-routes.mjs')).href);
const { __testing } = routerModule;

try {
  const callbackUriA = await __testing.resolveGmailAuthRedirectUri({
    headers: {
      host: 'tenant-a.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  const callbackUriB = await __testing.resolveGmailAuthRedirectUri({
    headers: {
      host: 'tenant-b.example.com',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(
    callbackUriA,
    'https://auth.example.com/api/connectors/gmail/google/callback',
    'public base url should force a single fixed Gmail callback URI',
  );
  assert.equal(
    callbackUriB,
    callbackUriA,
    'callback URI should remain fixed regardless of request host',
  );

  mkdirSync(dirname(gmailModule.GOOGLE_GMAIL_CREDENTIALS_PATH), { recursive: true });
  writeFileSync(
    gmailModule.GOOGLE_GMAIL_CREDENTIALS_PATH,
    JSON.stringify({
      installed: {
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        redirect_uris: [callbackUriA],
      },
    }, null, 2),
    'utf8',
  );
  const authUrlA = await gmailModule.generateGmailAuthUrl({
    state: 'state-user-a',
    redirectUri: callbackUriA,
  });
  const authUrlB = await gmailModule.generateGmailAuthUrl({
    state: 'state-user-b',
    redirectUri: callbackUriA,
  });
  const parsedAuthUrlA = new URL(authUrlA);
  const parsedAuthUrlB = new URL(authUrlB);
  assert.equal(
    parsedAuthUrlA.searchParams.get('redirect_uri'),
    callbackUriA,
    'generated auth url should keep redirect_uri fixed',
  );
  assert.equal(
    parsedAuthUrlB.searchParams.get('redirect_uri'),
    callbackUriA,
    'generated auth url should keep redirect_uri fixed for different users',
  );
  assert.equal(parsedAuthUrlA.searchParams.get('state'), 'state-user-a');
  assert.equal(parsedAuthUrlB.searchParams.get('state'), 'state-user-b');

  // Legacy single-entry format should still be readable.
  writeFileSync(
    gmailModule.GOOGLE_GMAIL_AUTH_STATE_PATH,
    JSON.stringify({
      state: 'legacy-state',
      bindingId: 'binding_gmail_default',
      redirectUri: callbackUriA,
      tokenPath: '/tmp/token-legacy.json',
      createdAt: new Date().toISOString(),
    }, null, 2),
    'utf8',
  );
  const legacyEntry = await __testing.getGmailAuthStateEntry('legacy-state');
  assert.equal(legacyEntry?.state, 'legacy-state', 'legacy auth state should be readable');

  await __testing.putGmailAuthStateEntry('state-a', {
    bindingId: 'binding_gmail_default',
    title: 'user-a',
    credentialsPath: gmailModule.GOOGLE_GMAIL_CREDENTIALS_PATH,
    tokenPath: '/tmp/token-a.json',
    redirectUri: callbackUriA,
    connectPath: '/connectors/gmail',
    createdAt: new Date().toISOString(),
  });
  await __testing.putGmailAuthStateEntry('state-b', {
    bindingId: 'binding_gmail_default',
    title: 'user-b',
    credentialsPath: gmailModule.GOOGLE_GMAIL_CREDENTIALS_PATH,
    tokenPath: '/tmp/token-b.json',
    redirectUri: callbackUriA,
    connectPath: '/connectors/gmail',
    createdAt: new Date().toISOString(),
  });

  const entryA = await __testing.getGmailAuthStateEntry('state-a');
  const entryB = await __testing.getGmailAuthStateEntry('state-b');
  assert.equal(entryA?.state, 'state-a');
  assert.equal(entryB?.state, 'state-b');

  const rawStoreBeforeClear = JSON.parse(readFileSync(gmailModule.GOOGLE_GMAIL_AUTH_STATE_PATH, 'utf8'));
  assert.ok(rawStoreBeforeClear.entries?.['legacy-state']);
  assert.ok(rawStoreBeforeClear.entries?.['state-a']);
  assert.ok(rawStoreBeforeClear.entries?.['state-b']);

  await __testing.clearGmailAuthStateEntry('state-a');
  const rawStoreAfterClear = JSON.parse(readFileSync(gmailModule.GOOGLE_GMAIL_AUTH_STATE_PATH, 'utf8'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(rawStoreAfterClear.entries || {}, 'state-a'),
    false,
    'clearing a state should remove only the target state',
  );
  assert.ok(rawStoreAfterClear.entries?.['state-b'], 'clearing one state should preserve other states');
  assert.ok(rawStoreAfterClear.entries?.['legacy-state'], 'clearing one state should not wipe the whole state file');

  console.log('test-gmail-oauth-state-routing: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
