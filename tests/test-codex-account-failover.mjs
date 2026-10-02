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
  const run = async (native = false, codexThreadId = null) => {
    const record = await createRun({ status: { sessionId: 'quota-session', requestId: 'quota-request', tool: 'quota-fixture' },
      manifest: { sessionId: 'quota-session', requestId: 'quota-request', tool: 'quota-fixture', folder: root,
        inputMode: native ? 'native' : 'batch', prompt: 'Perform one synthetic action then complete.',
        options: { model: 'fixture', codexThreadId, skipSessionStartPreflight: true } } });
    const child = spawn(process.execPath, ['chat/runner-sidecar.mjs', record.id], { cwd: repo, env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); clearTimeout(timer);
    return { exit, record: await getRun(record.id), output };
  };
  const calls = async () => (await readFile(join(config, 'failover-invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const native of [false, true]) {
    await seed(home, 'initial', 'usage_limit_reached', true);
    await pool.refresh('default', command); await pool.select('default');
    const before = native ? 2 : 0;
    const failed = await run(native); assert.notEqual(failed.exit, 0, failed.output);
    assert.equal(failed.record.codexAccount.id, 'default'); assert.equal(failed.record.state, 'failed');
    assert.equal((await calls()).length, before + 1, 'an exhausted run is never automatically restarted');
    assert.equal((await pool.read()).activeId, backup.id, 'the failure selects the default for the next request');
    const next = await run(native, failed.record.codexThreadId);
    assert.equal(next.exit, 0, next.output); assert.equal(next.record.state, 'completed');
    assert.equal(next.record.codexAccount.id, backup.id);
    const after = await calls(); assert.deepEqual(after.slice(before).map(c => c.account), ['initial', 'backup']);
    if (native) assert.equal(after.at(-1).resumeId, failed.record.codexThreadId);
    else assert.ok(after.at(-1).args.includes(failed.record.codexThreadId));
    assert.equal(await readFile(join(config, 'external-effect.txt'), 'utf8'), native ? 'once\nonce\n' : 'once\n', 'subsequent conversation preserves completed actions');
  }
  await seed(home, 'initial', '401 Unauthorized');
  await pool.refresh('default', command); await pool.select('default');
  const failed = await run(); assert.notEqual(failed.exit, 0);
  assert.equal((await calls()).length, 5, 'authentication errors are not retried on other accounts');
  assert.equal((await pool.read()).activeId, 'default', 'authentication errors never change the default');
  console.log('Batch and native requests keep their account, never replay after exhaustion, and resume subsequent requests on the background-selected default');

} finally { await rm(root, { recursive: true, force: true }); }
