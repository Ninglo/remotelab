import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, access } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeAuthManager } from '../chat/claude-auth.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-claude-auth-'));
const command = join(home, 'fake-claude');
const credential = join(home, 'claude-auth-fixture-credential');
await copyFile(new URL('./fixtures/claude-auth.cjs', import.meta.url), command);
await chmod(command, 0o755);

const manager = createClaudeAuthManager({
  resolveCommand: async () => command,
  buildEnv: () => ({ ...process.env, ANTHROPIC_API_KEY: 'fixture-api-key' }),
  resolveHome: () => home,
});

const initial = await manager.getStatus();
assert.equal(initial.loggedIn, false);
assert.equal(initial.apiKeyOverride, true);
assert.equal(initial.effectiveAuthMethod, 'api_key');

const started = await manager.startLogin();
assert.equal(started.loginActive, true);
assert.equal(started.phase, 'awaiting');
assert.equal(started.verificationUri, 'https://claude.com/cai/oauth/authorize?state=fixture');

const credentialWritten = new Promise((resolve, reject) => {
  const watcher = watch(home, async (_event, filename) => {
    if (filename !== 'claude-auth-fixture-credential') return;
    try { await access(credential); } catch { return; }
    clearTimeout(timer);
    watcher.close();
    resolve();
  });
  const timer = setTimeout(() => {
    watcher.close();
    reject(new Error('Claude login fixture did not receive the submitted code'));
  }, 5000);
});
await manager.submitCode('fixture-code');
await credentialWritten;
const completed = await manager.getStatus();
assert.equal(completed.loggedIn, true);
assert.equal(completed.authMethod, 'claude_ai');
assert.equal(completed.apiKeyOverride, true, 'login must not silently switch the existing API key runtime');
assert.equal(completed.effectiveAuthMethod, 'api_key');

const loggedOut = await manager.logout();
assert.equal(loggedOut.loggedIn, false);
assert.equal(loggedOut.apiKeyOverride, true);
await assert.rejects(access(credential));
await assert.rejects(manager.submitCode('fixture-code'), /No Claude login/);

console.log('Claude auth manager tests passed');
