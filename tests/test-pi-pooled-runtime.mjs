import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { preparePooledPiRuntime } from '../chat/pi-pooled-runtime.mjs';

const accessToken = (expires, subject = 'fixture-subject') => 'header.'
  + Buffer.from(JSON.stringify({ sub: subject, exp: Math.floor(expires / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-workspace' } })).toString('base64url') + '.signature';

test('Pi sees only the leased access token, uses the existing session directory, and cleans its credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'test-pi-pool-'));
  const home = join(root, 'account');
  const agentDir = join(root, 'pi');
  const writeLogin = (access, refresh = 'synthetic-refresh-secret') => writeFile(join(home, 'auth.json'),
    JSON.stringify({ tokens: { access_token: access, refresh_token: refresh, account_id: 'fixture-workspace' } }), { mode: 0o600 });
  const account = { id: 'fixture', home, sqliteHome: home };
  const options = { env: { PI_CODING_AGENT_DIR: agentDir }, resolveCodexCommand: async () => 'codex-fixture' };
  try {
    await mkdir(home);
    await mkdir(join(agentDir, 'sessions'), { recursive: true });
    await writeFile(join(agentDir, 'sessions', 'saved.jsonl'), 'existing provider history');
    await writeFile(join(agentDir, 'auth.json'), '{"legacy":"untouched"}');
    await writeFile(join(agentDir, 'models.json'), '{"providers":{"openai-codex":{"baseUrl":"https://fixture.invalid"}}}');
    const expired = accessToken(Date.now() - 1000);
    const fresh = accessToken(Date.now() + 60000);
    await writeLogin(expired);
    let refreshes = 0;
    const runtime = await preparePooledPiRuntime(account, { ...options, query: async args => {
      refreshes++;
      assert.equal(args.refreshToken, true);
      assert.equal(args.env.CODEX_HOME, home);
      assert.equal(args.credentialStore, 'file');
      await writeLogin(fresh);
      return { account: { type: 'chatgpt' } };
    } });
    try {
      assert.equal(refreshes, 1);
      const auth = JSON.parse(await readFile(join(runtime.dir, 'auth.json'), 'utf8'));
      assert.equal(auth['openai-codex'].access, fresh);
      assert.equal(auth['openai-codex'].refresh, '');
      assert.equal((await stat(join(runtime.dir, 'auth.json'))).mode & 0o777, 0o600);
      assert.equal((await stat(runtime.dir)).mode & 0o777, 0o700);
      assert.equal(await readFile(join(runtime.dir, 'sessions', 'saved.jsonl'), 'utf8'), 'existing provider history');
      assert.equal(JSON.parse(await readFile(join(runtime.dir, 'models.json'), 'utf8')).providers['openai-codex'].baseUrl, undefined);
    } finally { await runtime.close(); }
    await assert.rejects(readFile(join(runtime.dir, 'auth.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(agentDir, 'auth.json'), 'utf8'), '{"legacy":"untouched"}');
    assert.equal(await readFile(join(agentDir, 'sessions', 'saved.jsonl'), 'utf8'), 'existing provider history');
    await writeLogin(expired);
    await assert.rejects(preparePooledPiRuntime(account, { ...options, query: async () => {
      await writeLogin(accessToken(Date.now() + 60000, 'different-subject'));
      return { account: { type: 'chatgpt' } };
    } }), /身份已变更/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
