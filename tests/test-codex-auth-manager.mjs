import assert from 'assert/strict';
import { access, copyFile, chmod, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createCodexAuthManager } from '../chat/codex-auth.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-codex-auth-'));
const codexHome = join(tempRoot, 'codex-home');
const fakeCodex = join(tempRoot, 'fake-codex');

await copyFile(new URL('./fixtures/codex-account.cjs', import.meta.url), fakeCodex);
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
