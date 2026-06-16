#!/usr/bin/env node
import assert from 'assert/strict';
import { chownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  GUEST_CODEX_REDACTED_EMAIL,
  GUEST_CODEX_REDACTED_NAME,
  sanitizeGuestCodexAuthContent,
  writeGuestCodexAuthFile,
} from '../lib/codex-auth-redaction.mjs';

function encodeBase64Url(text) {
  return Buffer.from(String(text || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(segment) {
  const normalized = String(segment || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

const payload = {
  email: 'owner@example.com',
  email_verified: true,
  name: 'Owner Name',
  nested: {
    email: 'owner@example.com',
    name: 'Owner Name',
  },
};
const auth = {
  auth_mode: 'chatgpt',
  tokens: {
    id_token: `header.${encodeBase64Url(JSON.stringify(payload))}.signature`,
    access_token: 'access',
    refresh_token: 'refresh',
    account_id: 'acct',
  },
};

const sanitized = JSON.parse(sanitizeGuestCodexAuthContent(JSON.stringify(auth)));
const sanitizedPayload = JSON.parse(decodeBase64Url(sanitized.tokens.id_token.split('.')[1]));

assert.equal(sanitizedPayload.email, GUEST_CODEX_REDACTED_EMAIL);
assert.equal(sanitizedPayload.name, GUEST_CODEX_REDACTED_NAME);
assert.equal(sanitizedPayload.email_verified, false);
assert.equal(sanitizedPayload.nested.email, GUEST_CODEX_REDACTED_EMAIL);
assert.equal(sanitizedPayload.nested.name, GUEST_CODEX_REDACTED_NAME);
assert.equal(sanitized.tokens.access_token, 'access');
assert.equal(sanitized.tokens.refresh_token, 'refresh');

const scratchDir = mkdtempSync(join(tmpdir(), 'remotelab-codex-auth-redaction-'));
try {
  const ownerAuth = join(scratchDir, 'owner-auth.json');
  const guestDir = join(scratchDir, 'guest');
  const guestAuth = join(guestDir, 'auth.json');
  writeFileSync(ownerAuth, JSON.stringify(auth, null, 2), 'utf8');
  mkdirSync(guestDir, { recursive: true });
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    chownSync(guestDir, 65534, 65534);
  }
  symlinkSync(ownerAuth, guestAuth);
  await writeGuestCodexAuthFile({
    sourcePath: ownerAuth,
    targetPath: guestAuth,
  });
  const guestStat = lstatSync(guestAuth);
  const guestDirStat = lstatSync(guestDir);
  assert.equal(guestStat.isSymbolicLink(), false, 'guest auth rewrites should replace symlinks with regular files');
  assert.equal(guestStat.mode & 0o777, 0o600, 'guest auth rewrites should lock auth.json to owner-only access');
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    assert.equal(guestStat.uid, guestDirStat.uid, 'guest auth rewrites should inherit the directory owner');
    assert.equal(guestStat.gid, guestDirStat.gid, 'guest auth rewrites should inherit the directory group');
  }
  const guestPayload = JSON.parse(decodeBase64Url(JSON.parse(readFileSync(guestAuth, 'utf8')).tokens.id_token.split('.')[1]));
  const ownerPayload = JSON.parse(decodeBase64Url(JSON.parse(readFileSync(ownerAuth, 'utf8')).tokens.id_token.split('.')[1]));
  assert.equal(guestPayload.email, GUEST_CODEX_REDACTED_EMAIL);
  assert.equal(ownerPayload.email, 'owner@example.com', 'owner auth source should remain untouched');
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

console.log('test-codex-auth-redaction: ok');
