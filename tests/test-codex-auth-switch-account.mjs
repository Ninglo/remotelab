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
const primaryResponse = createResponseCapture();
const primaryHandled = await handleCodexAuthRoutes({
  req: { method: 'POST' },
  res: primaryResponse.res,
  pathname: '/api/codex-auth/logout',
  authSession: { personId: 'person_primary' },
  writeJson: primaryResponse.writeJson,
  authManager: {
    async logout() {
      logoutCalls += 1;
      return { available: true, loggedIn: false, phase: 'idle' };
    },
  },
});

assert.equal(primaryHandled, true);
assert.equal(primaryResponse.capture.status, 200);
assert.equal(primaryResponse.capture.payload?.codexAuth?.loggedIn, false);
assert.equal(logoutCalls, 1, 'authenticated logout should clear only the manager bound to this instance');

const secondPersonResponse = createResponseCapture();
await handleCodexAuthRoutes({
  req: { method: 'POST' },
  res: secondPersonResponse.res,
  pathname: '/api/codex-auth/logout',
  authSession: { personId: 'person_second' },
  writeJson: secondPersonResponse.writeJson,
  authManager: {
    async logout() {
      logoutCalls += 1;
      return {};
    },
  },
});
assert.equal(secondPersonResponse.capture.status, 200);
assert.equal(logoutCalls, 2, 'every authenticated person has full instance controls');

let switchCalls = 0;
const switchResponse = createResponseCapture();
await handleCodexAuthRoutes({
  req: { method: 'POST' },
  res: switchResponse.res,
  pathname: '/api/codex-auth/switch-account',
  authSession: { personId: 'person_primary' },
  writeJson: switchResponse.writeJson,
  authManager: {
    async switchAccount() {
      switchCalls += 1;
      return { available: true, loggedIn: false, phase: 'awaiting', deviceLoginActive: true, userCode: 'redacted' };
    },
  },
});
assert.equal(switchResponse.capture.status, 200);
assert.equal(switchResponse.capture.payload?.codexAuth?.phase, 'awaiting');
assert.equal(switchCalls, 1, 'account switch should be one server-side auth transaction');

let switchCalls = 0;
const switchResponse = createResponseCapture();
await handleCodexAuthRoutes({
  req: { method: 'POST' },
  res: switchResponse.res,
  pathname: '/api/codex-auth/switch-account',
  authSession: { role: 'owner' },
  writeJson: switchResponse.writeJson,
  authManager: {
    async switchAccount() {
      switchCalls += 1;
      return { available: true, loggedIn: false, phase: 'awaiting', deviceLoginActive: true, userCode: 'redacted' };
    },
  },
});
assert.equal(switchResponse.capture.status, 200);
assert.equal(switchResponse.capture.payload?.codexAuth?.phase, 'awaiting');
assert.equal(switchCalls, 1, 'owner switch should be one server-side auth transaction');

const settingsSource = readFileSync(join(repoRoot, 'static', 'chat', 'settings-ui.js'), 'utf8');
assert.match(settingsSource, /id="settingsCodexAuthSwitchBtn"/);
assert.match(settingsSource, /window\.confirm\(copy\.switchConfirm\)/);
assert.match(settingsSource, /fetchJsonOrRedirect\("\/api\/codex-auth\/switch-account"/);
assert.match(settingsSource, /CODEX_AUTH_MUTATION_TIMEOUT_MS/);
assert.match(settingsSource, /refreshCodexAuthStatus\(\{ force: true, includeUsage: false \}\)/);

console.log('test-codex-auth-switch-account: ok');
