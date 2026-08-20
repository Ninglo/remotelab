import assert from 'assert/strict';
import { access, chmod, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createCodexAuthManager } from '../chat/codex-auth.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-codex-auth-'));
const codexHome = join(tempRoot, 'codex-home');
const fakeCodex = join(tempRoot, 'fake-codex');

await writeFile(fakeCodex, `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  if [ -f "$CODEX_HOME/auth.json" ]; then
    echo "Logged in using ChatGPT"
    exit 0
  fi
  echo "Not logged in"
  exit 1
fi
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  echo "Open https://auth.openai.com/codex/device"
  echo "Enter code 2ABC-4DEFG"
  sleep 0.2
  printf '{"tokens":{}}\\n' > "$CODEX_HOME/auth.json"
  echo "Successfully logged in"
  exit 0
fi
if [ "$1" = "logout" ]; then
  rm -f "$CODEX_HOME/auth.json"
  echo "Successfully logged out"
  exit 0
fi
exit 2
`);
await chmod(fakeCodex, 0o755);

const manager = createCodexAuthManager({
  resolveCommand: async () => fakeCodex,
  resolveHome: () => codexHome,
  baseEnv: () => process.env,
});

const initial = await manager.getStatus();
assert.equal(initial.available, true);
assert.equal(initial.loggedIn, false);

const started = await manager.startDeviceLogin();
assert.equal(started.deviceLoginActive, true);
assert.equal(started.userCode, '2ABC-4DEFG');
assert.equal(started.verificationUri, 'https://auth.openai.com/codex/device');

await new Promise((resolve) => setTimeout(resolve, 350));
const completed = await manager.getStatus();
assert.equal(completed.loggedIn, true);
assert.equal(completed.phase, 'authenticated');
assert.equal(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')).tokens != null, true);

const loggedOut = await manager.logout();
assert.equal(loggedOut.loggedIn, false);
assert.equal(loggedOut.phase, 'idle');
await assert.rejects(access(join(codexHome, 'auth.json')));

console.log('Codex auth manager tests passed');
