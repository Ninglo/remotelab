import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = await mkdtemp(join(tmpdir(), 'remotelab-account-failover-'));
const home = join(root, 'legacy'); const config = join(root, 'config');
await mkdir(home); await mkdir(config);
process.env.REMOTELAB_CONFIG_DIR = config; process.env.REMOTELAB_MACHINE_CODEX_HOME = home;
const command = join(root, 'codex-fixture');
await copyFile(new URL('./fixtures/codex-account-failover.cjs', import.meta.url), command); await chmod(command, 0o755);
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'quota-fixture', name: 'Quota fixture', command, runtimeFamily: 'codex-json' }]));
const { codexAccounts: pool } = await import('../lib/codex-accounts.mjs');
const { createRun, getRun } = await import('../chat/runs.mjs');
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const seed = async (directory, id, fail, tool = false) => {
  await writeFile(join(directory, 'auth.json'), '{"tokens":{}}');
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ id, fail, tool }));
};
try {
  const backup = await pool.add('backup'); await seed(backup.home, 'backup', null);
  await pool.refresh(backup.id, command); await pool.policy(true);
  const run = async (native = false) => {
    const record = await createRun({ status: { sessionId: 'quota-session', requestId: 'quota-request', tool: 'quota-fixture' },
      manifest: { sessionId: 'quota-session', requestId: 'quota-request', tool: 'quota-fixture', folder: root,
        inputMode: native ? 'native' : 'batch', prompt: 'Perform one synthetic action then complete.',
        options: { model: 'fixture', skipSessionStartPreflight: true } } });
    const child = spawn(process.execPath, ['chat/runner-sidecar.mjs', record.id], { cwd: repo, env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); clearTimeout(timer);
    return { exit, record: await getRun(record.id), output };
  };
  await seed(home, 'initial', 'usage_limit_reached', true);
  const success = await run(); assert.equal(success.exit, 0, success.output);
  assert.equal(success.record.state, 'completed'); assert.equal(success.record.codexAccount.id, backup.id);
  const calls = (await readFile(join(config, 'failover-invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c => c.account), ['initial', 'backup']);
  assert.ok(calls[1].args.includes('00000000-0000-4000-8000-000000000001'));
  assert.equal(await readFile(join(config, 'external-effect.txt'), 'utf8'), 'once\n', 'completed actions are not replayed on another account');
  await pool.mutate(data => { data.activeId = 'default'; delete data.accounts[0].blockedUntil; });
  const native = await run(true); assert.equal(native.exit, 0, native.output);
  assert.equal(native.record.codexAccount.id, backup.id);
  const nativeCalls = (await readFile(join(config, 'failover-invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(nativeCalls[3].resumeId, '00000000-0000-4000-8000-000000000001');
  assert.equal(await readFile(join(config, 'external-effect.txt'), 'utf8'), 'once\nonce\n');
  await pool.mutate(data => { data.activeId = 'default'; delete data.accounts[0].blockedUntil; });
  await seed(home, 'initial', '401 Unauthorized');
  const failed = await run(); assert.notEqual(failed.exit, 0);
  const after = (await readFile(join(config, 'failover-invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(after.length, 5, 'authentication failures must not rotate through subscriptions');
  console.log('Batch and native Codex exhaustion failover, saved-thread continuation, single external effect and non-quota failures passed');
} finally { await rm(root, { recursive: true, force: true }); }
