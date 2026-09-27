#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-auth-persistence-'));
const configDir = join(tempHome, '.config', 'remotelab');
const sessionsPath = join(configDir, 'auth-sessions.json');
const now = Date.now();

try {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0'.repeat(64),
    username: 'owner',
    passwordHash: '',
  }));
  writeFileSync(sessionsPath, JSON.stringify({
    'web-session': { expiry: now + 60_000, personId: 'person_default', personName: 'owner', identityId: 'identity_web_default' },
    'old-service': { expiry: now + 60_000, personId: 'person_default', personName: 'owner', identityId: 'identity_web_default', authKind: 'service' },
    'new-service': { expiry: now + 120_000, personId: 'person_default', personName: 'owner', identityId: 'identity_web_default', authKind: 'service' },
  }));
  process.env.HOME = tempHome;
  process.env.REMOTELAB_CONFIG_DIR = configDir;

  const auth = await import(pathToFileURL(join(repoRoot, 'lib', 'auth.mjs')).href);
  assert.deepEqual([...auth.sessions.keys()], ['web-session', 'new-service']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(sessionsPath, 'utf8'))), ['web-session', 'new-service']);
  assert.equal(statSync(sessionsPath).mode & 0o777, 0o600);
  assert.deepEqual(
    auth.getOrCreateAuthenticatedSessionToken({ authKind: 'service' }),
    { token: 'new-service', created: false },
  );

  const stableSnapshot = readFileSync(sessionsPath, 'utf8');
  auth.sessions.set('added-web', auth.createAuthenticatedSession());
  chmodSync(configDir, 0o500);
  await auth.saveAuthSessionsAsync();
  assert.equal(readFileSync(sessionsPath, 'utf8'), stableSnapshot, 'failed write must preserve the last complete file');
  chmodSync(configDir, 0o700);

  const firstSave = auth.saveAuthSessionsAsync();
  auth.sessions.set('later-web', auth.createAuthenticatedSession());
  const secondSave = auth.saveAuthSessionsAsync();
  await Promise.all([firstSave, secondSave]);
  const persisted = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  assert.deepEqual(Object.keys(persisted), ['web-session', 'new-service', 'added-web', 'later-web']);
  assert.equal(readdirSync(configDir).some((name) => name.startsWith('auth-sessions.json.') && name.endsWith('.tmp')), false);
  console.log('test-auth-session-persistence: ok');
} finally {
  chmodSync(configDir, 0o700);
  rmSync(tempHome, { recursive: true, force: true });
}
