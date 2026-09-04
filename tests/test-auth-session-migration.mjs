#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-auth-session-migration-'));
const configDir = join(tempHome, '.config', 'remotelab');
const authSessionsPath = join(configDir, 'auth-sessions.json');
const now = Date.now();

try {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0'.repeat(64),
    username: 'owner',
    passwordHash: '',
  }), 'utf8');
  writeFileSync(authSessionsPath, JSON.stringify({
    'legacy-owner': {
      expiry: now + 60_000,
      role: 'owner',
      accountId: 'owner',
      accountName: 'Owner',
      accountUsername: 'owner',
      accountKind: 'admin',
    },
    'legacy-member': {
      expiry: now + 60_000,
      role: 'owner',
      accountId: 'user_old',
      accountName: 'Old member',
      accountUsername: 'old-member',
      accountKind: 'member',
    },
    visitor: {
      expiry: now + 60_000,
      role: 'visitor',
      sessionId: 'visitor-session',
      visitorId: 'visitor-1',
    },
    expired: {
      expiry: now - 1,
      role: 'owner',
    },
  }), 'utf8');

  process.env.HOME = tempHome;
  process.env.REMOTELAB_CONFIG_DIR = configDir;

  const authModule = await import(pathToFileURL(join(repoRoot, 'lib', 'auth.mjs')).href);
  assert.equal(authModule.sessions.has('legacy-owner'), true, 'legacy owner sessions should remain valid');
  assert.equal(authModule.sessions.has('legacy-member'), false, 'legacy member cookies must not become owner sessions');
  assert.equal(authModule.sessions.has('visitor'), true, 'visitor sessions should remain valid');
  assert.equal(authModule.sessions.has('expired'), false, 'expired sessions should be removed');
  assert.deepEqual(
    authModule.sessions.get('legacy-owner'),
    { expiry: now + 60_000, role: 'owner' },
    'retained owner sessions should drop retired account metadata',
  );

  const persisted = JSON.parse(readFileSync(authSessionsPath, 'utf8'));
  assert.deepEqual(Object.keys(persisted).sort(), ['legacy-owner', 'visitor']);
  assert.equal(Object.hasOwn(persisted['legacy-owner'], 'accountKind'), false);

  console.log('test-auth-session-migration: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
