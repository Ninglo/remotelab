import assert from 'assert/strict';
import { access, chmod, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createPiAuthManager } from '../chat/pi-auth.mjs';
import { handlePiAuthRoutes } from '../chat/router-pi-auth-routes.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-pi-auth-'));
const piAgentDir = join(tempRoot, 'pi-agent');
const loginHome = join(tempRoot, 'pi-codex-login');
const fakePi = join(tempRoot, 'fake-pi');
const fakeCodex = join(tempRoot, 'fake-codex');
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
await writeFile(fakeCodex, `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  echo "Open https://auth.openai.com/codex/device"
  echo "Enter code 8XYZ-2ABCD"
  sleep 0.2
  cat > "$CODEX_HOME/auth.json" <<'JSON'
{"auth_mode":"chatgpt","tokens":{"access_token":"${accessToken}","refresh_token":"refresh-test","account_id":"account-test"}}
JSON
  exit 0
fi
exit 2
`);
await Promise.all([chmod(fakePi, 0o755), chmod(fakeCodex, 0o755)]);

const manager = createPiAuthManager({
  resolvePiCommand: async () => fakePi,
  resolveCodexCommand: async () => fakeCodex,
  resolveAgentDir: () => piAgentDir,
  resolveLoginHome: () => loginHome,
  baseEnv: () => process.env,
});

const initial = await manager.getStatus();
assert.equal(initial.available, true);
assert.equal(initial.loggedIn, false);

const started = await manager.startDeviceLogin();
assert.equal(started.deviceLoginActive, true);
assert.equal(started.userCode, '8XYZ-2ABCD');
assert.equal(started.verificationUri, 'https://auth.openai.com/codex/device');

await new Promise((resolve) => setTimeout(resolve, 400));
const completed = await manager.getStatus();
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
await access(join(loginHome, 'auth.json'));

const redundantLogin = await manager.startDeviceLogin({ restart: true });
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
