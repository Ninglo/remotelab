import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { access, copyFile, chmod, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';

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

const raceHome = join(tempRoot, 'race-home');
let signedIn = true;
let rateCheckAborted = false;
let notifyRateCheckStarted;
const rateCheckStarted = new Promise((resolve) => { notifyRateCheckStarted = resolve; });
const raceManager = createCodexAuthManager({
  resolveCommand: async () => fakeCodex,
  resolveHome: () => raceHome,
  baseEnv: () => process.env,
  readAccountStatus: async ({ includeRateLimits, signal }) => {
    if (!includeRateLimits) {
      return {
        account: signedIn ? { type: 'chatgpt', email: 'test@example.com' } : null,
        accountRevision: signedIn ? 'account-revision' : '',
        credentialRevision: signedIn ? 'credential-revision' : '',
        checkedAt: new Date().toISOString(),
      };
    }
    notifyRateCheckStarted();
    return await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        rateCheckAborted = true;
        const error = new Error('Codex account check cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  },
  spawnProcess: (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => true;
    if (args[0] === 'logout') signedIn = false;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('close', 0);
    });
    return child;
  },
});

const pendingUsage = raceManager.getRateLimits({ force: true }).then(
  () => null,
  error => error,
);
await rateCheckStarted;
const raceLoggedOut = await raceManager.logout();
const usageCancellation = await pendingUsage;
assert.equal(rateCheckAborted, true, 'logout should cancel an in-flight Codex usage probe');
assert.equal(usageCancellation?.name, 'AbortError');
assert.equal(raceLoggedOut.loggedIn, false);

const switchHome = join(tempRoot, 'switch-home');
await mkdir(switchHome, { recursive: true });
await writeFile(join(switchHome, 'auth.json'), JSON.stringify({ tokens: { id_token: 'x.e30.x' } }));
const switchManager = createCodexAuthManager({
  resolveCommand: async () => fakeCodex,
  resolveHome: () => switchHome,
  baseEnv: () => process.env,
});
const switched = await switchManager.switchAccount();
assert.equal(switched.loggedIn, false);
assert.equal(switched.deviceLoginActive, true);
assert.equal(switched.phase, 'awaiting');
assert.equal(switched.userCode, '2ABC-4DEFG');

console.log('Codex auth manager tests passed');
