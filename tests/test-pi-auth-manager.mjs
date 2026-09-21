import assert from 'assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createPiAuthManager } from '../chat/pi-auth.mjs';
import { handlePiAuthRoutes } from '../chat/router-pi-auth-routes.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-pi-auth-'));
const piAgentDir = join(tempRoot, 'pi-agent');
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
  baseEnv: () => process.env,
});

const initial = await manager.getStatus();
assert.equal(initial.available, true);
assert.equal(initial.loggedIn, false);

await mkdir(piAgentDir, { recursive: true });
await writeFile(join(piAgentDir, 'auth.json'), JSON.stringify({
  'openai-codex': {
    type: 'oauth',
    access: accessToken,
    refresh: 'pi-refresh-test',
    expires: expirySeconds * 1000,
    accountId: 'pi-account-test',
  },
}));
const independentlyLoggedIn = await manager.getStatus();
assert.equal(independentlyLoggedIn.loggedIn, true);
assert.equal(independentlyLoggedIn.phase, 'authenticated');
const stored = JSON.parse(await readFile(join(piAgentDir, 'auth.json'), 'utf8'));
assert.deepEqual(stored['openai-codex'], {
  type: 'oauth',
  access: accessToken,
  refresh: 'pi-refresh-test',
  expires: expirySeconds * 1000,
  accountId: 'pi-account-test',
});

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
  authSession: { personId: 'person_primary' },
  writeJson: syncResponse.writeJson,
  authManager: manager,
});
assert.equal(syncResponse.capture.status, 404);
assert.equal(syncResponse.capture.payload?.error, 'Pi login route not found');

const primaryResponse = createResponseCapture();
await handlePiAuthRoutes({
  req: { method: 'GET' },
  res: primaryResponse.res,
  pathname: '/api/pi-auth/status',
  authSession: { personId: 'person_primary' },
  writeJson: primaryResponse.writeJson,
  authManager: {
    async getStatus() {
      return { available: true, loggedIn: true, phase: 'authenticated' };
    },
  },
});
assert.equal(primaryResponse.capture.status, 200);
assert.equal(primaryResponse.capture.payload?.piAuth?.loggedIn, true);

const secondPersonResponse = createResponseCapture();
await handlePiAuthRoutes({
  req: { method: 'GET' },
  res: secondPersonResponse.res,
  pathname: '/api/pi-auth/status',
  authSession: { personId: 'person_second' },
  writeJson: secondPersonResponse.writeJson,
  authManager: manager,
});
assert.equal(secondPersonResponse.capture.status, 200);

console.log('Pi auth manager tests passed');
