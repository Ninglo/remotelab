#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-gmail-auth-headers-'));

process.env.HOME = tempHome;
delete process.env.REMOTELAB_INSTANCE_ROOT;
delete process.env.REMOTELAB_CONFIG_DIR;

const gmailModule = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-gmail.mjs')).href);

try {
  const fallbackHeaders = await gmailModule.__testing.resolveAuthorizedRequestHeaders({
    async getRequestHeaders() {
      return {};
    },
    async getAccessToken() {
      return { token: 'fallback-access-token' };
    },
  }, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');

  assert.equal(
    fallbackHeaders.Authorization,
    'Bearer fallback-access-token',
    'gmail requests should synthesize an Authorization header when google-auth-library returns none',
  );

  const passthroughHeaders = await gmailModule.__testing.resolveAuthorizedRequestHeaders({
    async getRequestHeaders() {
      return { Authorization: 'Bearer existing-token' };
    },
    async getAccessToken() {
      throw new Error('should not be called when auth header already exists');
    },
  }, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');

  assert.equal(
    passthroughHeaders.Authorization,
    'Bearer existing-token',
    'existing Authorization headers should be preserved',
  );

  console.log('test-gmail-request-auth-headers: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
