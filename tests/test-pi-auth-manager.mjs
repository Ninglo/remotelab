import assert from 'assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createPiAuthManager } from '../chat/pi-auth.mjs';
import { handlePiAuthRoutes } from '../chat/router-pi-auth-routes.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-pi-auth-'));
const piAgentDir = join(tempRoot, 'pi-agent');
const codexHome = join(tempRoot, '.codex');
const fakePi = join(tempRoot, 'fake-pi');
const expirySeconds = Math.floor(Date.now() / 1000) + 3600;
const accessToken = `header.${Buffer.from(JSON.stringify({ exp: expirySeconds })).toString('base64url')}.signature`;

await writeFile(fakePi, `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "check" ]; then
  if [ -f "$PI_CODING_AGENT_DIR/auth.json" ] && grep -q '"openai-codex"' "$PI_CODING_AGENT_DIR/auth.json"; then
    echo '{"status":"ready","provider":"openai-codex","authType":"oauth"}'
    exit 0
  fi
  echo '{"status":"not_ready","provider":"openai-codex","reason":"credentials_not_configured"}'
  exit 0
fi
exit 2
`);
await chmod(fakePi, 0o755);

const manager = createPiAuthManager({
  resolvePiCommand: async () => fakePi,
  resolveAgentDir: () => piAgentDir,
  resolveCodexHome: () => codexHome,
  baseEnv: () => process.env,
});

const initial = await manager.getStatus();
assert.equal(initial.available, true);
assert.equal(initial.loggedIn, false);

const missingCodexLogin = await manager.syncCodexLogin();
assert.equal(missingCodexLogin.loggedIn, false);
assert.equal(missingCodexLogin.phase, 'failed');
assert.match(missingCodexLogin.error, /Sign in to Codex/);

await mkdir(codexHome, { recursive: true });
await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: {
    access_token: accessToken,
    refresh_token: 'refresh-test',
    account_id: 'account-test',
  },
}));
const completed = await manager.syncCodexLogin();
assert.equal(completed.loggedIn, true);
assert.equal(completed.phase, 'authenticated');
const stored = JSON.parse(await readFile(join(piAgentDir, 'auth.json'), 'utf8'));
assert.deepEqual(stored['openai-codex'], {
  type: 'oauth',
  access: accessToken,
  refresh: 'refresh-test',
  expires: expirySeconds * 1000,
  accountId: 'account-test',
});
await access(join(codexHome, 'auth.json'));

const redundantLogin = await manager.syncCodexLogin();
assert.equal(redundantLogin.loggedIn, true);
assert.equal(redundantLogin.phase, 'authenticated');
assert.equal(redundantLogin.deviceLoginActive, false);

const loggedOut = await manager.logout();
assert.equal(loggedOut.loggedIn, false);
assert.equal(loggedOut.phase, 'idle');
const afterLogout = JSON.parse(await readFile(join(piAgentDir, 'auth.json'), 'utf8'));
assert.equal(afterLogout['openai-codex'], undefined);

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

const syncResponse = createResponseCapture();
await handlePiAuthRoutes({
  req: { method: 'POST' },
  res: syncResponse.res,
  pathname: '/api/pi-auth/sync-codex',
  authSession: { role: 'owner' },
  writeJson: syncResponse.writeJson,
  authManager: manager,
});
assert.equal(syncResponse.capture.status, 200);
assert.equal(syncResponse.capture.payload?.piAuth?.loggedIn, true);

const ownerResponse = createResponseCapture();
await handlePiAuthRoutes({
  req: { method: 'GET' },
  res: ownerResponse.res,
  pathname: '/api/pi-auth/status',
  authSession: { role: 'owner' },
  writeJson: ownerResponse.writeJson,
  authManager: {
    async getStatus() {
      return { available: true, loggedIn: true, phase: 'authenticated' };
    },
  },
});
assert.equal(ownerResponse.capture.status, 200);
assert.equal(ownerResponse.capture.payload?.piAuth?.loggedIn, true);

const visitorResponse = createResponseCapture();
await handlePiAuthRoutes({
  req: { method: 'GET' },
  res: visitorResponse.res,
  pathname: '/api/pi-auth/status',
  authSession: { role: 'visitor' },
  writeJson: visitorResponse.writeJson,
  authManager: manager,
});
assert.equal(visitorResponse.capture.status, 403);

console.log('Pi auth manager tests passed');
