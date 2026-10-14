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
const { createRun, getRun, getRunManifest, readRunSpoolRecords } = await import('../chat/runs.mjs');
const { createRunProjectionService } = await import('../chat/run-projection.mjs');
const { createToolInvocation } = await import('../chat/process-runner.mjs');
const { codexUsageUpdates } = await import('../lib/codex-usage-updates.mjs');
const projection = createRunProjectionService({ createToolInvocation,
  readRunSpoolRecords, materializeRunSpoolLine: async (_, record) => record.line,
  normalizeRunEvents: (_, events) => events, clipPreview: text => text,
  readLatestCodexSessionMetrics: async () => null, buildCodexContextMetricsPayload: () => null });
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const seed = async (directory, id, fail, tool = false, noThread = false) => {
  await writeFile(join(directory, 'auth.json'), '{"tokens":{}}');
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ id, fail, tool, noThread }));
};
try {
  const backup = await pool.add('backup'); await seed(backup.home, 'backup', null);
  await pool.refresh(backup.id, command); await pool.policy(true);
  let sessionId = 'quota-session';
  const run = async (native = false, codexThreadId = null) => {
    const record = await createRun({ status: { sessionId, requestId: 'quota-request', tool: 'quota-fixture' },
      manifest: { sessionId, requestId: 'quota-request', tool: 'quota-fixture', folder: root,
        inputMode: native ? 'native' : 'batch', prompt: 'Perform one synthetic action then complete.',
        options: { model: 'fixture', codexThreadId, skipSessionStartPreflight: true } } });
    const child = spawn(process.execPath, ['chat/runner-sidecar.mjs', record.id], { cwd: repo, env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); clearTimeout(timer);
    const finished = await getRun(record.id);
    await projection.collectNormalizedRunEvents(finished, await getRunManifest(record.id));
    await codexUsageUpdates.flush();
    return { exit, record: finished, output };
  };
  const calls = async () => (await readFile(join(config, 'failover-invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const native of [false, true]) {
    sessionId = 'automatic-' + native;
    await seed(home, 'initial', 'usage_limit_reached', true);
    await pool.refresh('default', command); await pool.refresh(backup.id, command); await pool.select('default');
    const before = (await calls().catch(() => [])).length;
    const completed = await run(native);
    assert.equal(completed.exit, 0, completed.output); assert.equal(completed.record.state, 'completed');
    assert.equal(completed.record.codexAccount.id, backup.id);
    assert.equal(completed.record.codexFailover.attempts.length, 1);
    const after = await calls(); assert.deepEqual(after.slice(before).map(c => c.account), ['initial', 'backup']);
    if (native) assert.equal(after.at(-1).resumeId, completed.record.codexThreadId);
    else assert.ok(after.at(-1).args.includes(completed.record.codexThreadId));
    assert.equal(await readFile(join(config, 'external-effect.txt'), 'utf8'), native ? 'once\nonce\n' : 'once\n',
      'automatic continuation preserves completed actions');
    assert((await pool.account('default')).blockedUntil > Date.now(), 'quota failure is attributed to original account');
    assert.equal((await pool.account(backup.id)).blockedUntil, undefined, 'successful replacement is not marked exhausted');
    const next = await run(native, completed.record.codexThreadId);
    assert.equal(next.exit, 0, next.output); assert.equal(next.record.codexAccount.id, backup.id);
  }
  sessionId = 'all-exhausted';
  await seed(backup.home, 'backup', 'usage_limit_reached');
  await seed(home, 'initial', 'usage_limit_reached');
  await pool.refresh('default', command); await pool.refresh(backup.id, command); await pool.select('default');
  const beforeAll = (await calls()).length;
  const all = await run(); assert.notEqual(all.exit, 0);
  assert.equal((await calls()).length, beforeAll + 2, 'each exhausted account attempted once with finite termination');
  assert.match(all.record.codexFailover.stoppedReason, /暂无可用/);
  sessionId = 'missing-thread-after-effect';
  await seed(home, 'initial', 'usage_limit_reached', true, true);
  await seed(backup.home, 'backup', null);
  await pool.refresh('default', command); await pool.refresh(backup.id, command); await pool.select('default');
  const beforeMissing = (await calls()).length;
  assert.notEqual((await run()).exit, 0);
  assert.equal((await calls()).length, beforeMissing + 1, 'never replay a task with completed effects and no saved thread');
  sessionId = 'auth-error';
  await seed(home, 'initial', '401 Unauthorized');
  await pool.refresh('default', command); await pool.select('default');
  const beforeAuth = (await calls()).length;
  const failed = await run(); assert.notEqual(failed.exit, 0);
  assert.equal((await calls()).length, beforeAuth + 1, 'authentication errors are not blindly retried');
  sessionId = 'switch-disabled';
  await pool.policy(false); await seed(home, 'initial', 'usage_limit_reached');
  await pool.refresh('default', command); await pool.select('default');
  const beforeDisabled = (await calls()).length;
  assert.notEqual((await run()).exit, 0);
  assert.equal((await calls()).length, beforeDisabled + 1, 'disabled policy performs no automatic continuation');
  console.log('Batch/native automatic account migration preserves thread/actions; per-attempt quota attribution, bounded exhaustion and disabled policy passed');

} finally { await rm(root, { recursive: true, force: true }); }
