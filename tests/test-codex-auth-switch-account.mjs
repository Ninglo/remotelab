#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { handleCodexAuthRoutes } from '../chat/router-codex-auth-routes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function createResponseCapture() {
  const capture = { status: 0, payload: null };
  return {
    capture,
    res: {},
    writeJson(_res, status, payload) {
      capture.status = status;
      capture.payload = payload;
    },
  };
}

let logoutCalls = 0;
const ownerResponse = createResponseCapture();
const ownerHandled = await handleCodexAuthRoutes({
  req: { method: 'POST' },
  res: ownerResponse.res,
  pathname: '/api/codex-auth/logout',
  authSession: { role: 'owner' },
  writeJson: ownerResponse.writeJson,
  authManager: {
    async logout() {
      logoutCalls += 1;
      return { available: true, loggedIn: false, phase: 'idle' };
    },
  },
});

assert.equal(ownerHandled, true);
assert.equal(ownerResponse.capture.status, 200);
assert.equal(ownerResponse.capture.payload?.codexAuth?.loggedIn, false);
assert.equal(logoutCalls, 1, 'owner logout should clear only the manager bound to this instance');

const visitorResponse = createResponseCapture();
await handleCodexAuthRoutes({
  req: { method: 'POST' },
  res: visitorResponse.res,
  pathname: '/api/codex-auth/logout',
  authSession: { role: 'visitor' },
  writeJson: visitorResponse.writeJson,
  authManager: {
    async logout() {
      logoutCalls += 1;
      return {};
    },
  },
});
assert.equal(visitorResponse.capture.status, 403);
assert.equal(logoutCalls, 1, 'visitor logout must not reach the instance auth manager');

const settingsSource = readFileSync(join(repoRoot, 'static', 'chat', 'settings-ui.js'), 'utf8');
assert.match(settingsSource, /id="settingsCodexAuthSwitchBtn"/);
assert.match(settingsSource, /window\.confirm\(copy\.switchConfirm\)/);
assert.match(settingsSource, /fetchJsonOrRedirect\("\/api\/codex-auth\/logout"/);
assert.match(settingsSource, /await startCodexDeviceLogin\(\)/);

console.log('test-codex-auth-switch-account: ok');
