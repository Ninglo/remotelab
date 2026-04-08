#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function randomPort() {
  return 38000 + Math.floor(Math.random() * 6000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-instance-admin-'));
  const configDir = join(home, '.config', 'remotelab');
  const memoryTasksDir = join(home, '.remotelab', 'memory', 'tasks');
  const trialRoot = join(home, '.remotelab', 'instances', 'trial24');
  const trialConfigDir = join(trialRoot, 'config');
  const intakeRoot = join(home, '.remotelab', 'instances', 'intake1');
  const intakeConfigDir = join(intakeRoot, 'config');

  mkdirSync(configDir, { recursive: true });
  mkdirSync(memoryTasksDir, { recursive: true });
  mkdirSync(join(trialConfigDir, 'usage-ledger'), { recursive: true });
  mkdirSync(join(intakeConfigDir, 'usage-ledger'), { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'guest-instances.json'),
    JSON.stringify([
      {
        name: 'trial24',
        label: 'com.chatserver.trial24',
        port: 7711,
        hostname: 'trial24.example.com',
        instanceRoot: trialRoot,
        configDir: trialConfigDir,
        memoryDir: join(trialRoot, 'memory'),
        authFile: join(trialConfigDir, 'auth.json'),
        publicBaseUrl: 'https://trial24.example.com',
        localBaseUrl: 'http://127.0.0.1:7711',
        createdAt: '2026-03-26T14:56:25.700Z',
      },
      {
        name: 'intake1',
        label: 'com.chatserver.intake1',
        port: 7703,
        hostname: 'intake1.example.com',
        instanceRoot: intakeRoot,
        configDir: intakeConfigDir,
        memoryDir: join(intakeRoot, 'memory'),
        authFile: join(intakeConfigDir, 'auth.json'),
        publicBaseUrl: 'https://intake1.example.com',
        localBaseUrl: 'http://127.0.0.1:7703',
        createdAt: '2026-03-25T10:00:00.000Z',
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'user-instance-bindings.json'),
    JSON.stringify({
      bindings: [
        {
          instanceName: 'trial24',
          userName: 'Trial User',
          aliases: ['trial-user'],
          source: 'weixin',
          assignedAt: '2026-03-20T10:00:00.000Z',
          notes: '短视频团队',
        },
      ],
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(memoryTasksDir, 'remotelab-user-relationship-ledger.md'),
    [
      '# User Relationship Ledger',
      '',
      '### Trial User',
      '- canonical name: `Trial User`',
      '- aliases: `trial-user`',
      '- source: `weixin`',
      '- instance history: `trial24`',
      '- current stage: `active trial`',
      '- latest signal: `已经开始使用，希望继续跟进效果`',
      '- latest update: `2026-03-28 10:30`',
      '- next follow-up: `了解短视频团队的真实使用场景`',
      '- notes: `短视频团队`',
      '',
      '### Pending User',
      '- canonical name: `Pending User`',
      '- aliases: `pending-user`',
      '- source: `weixin`',
      '- current stage: `waiting for binding`',
      '- latest signal: `已经沟通过需求，但还没绑定实例`',
      '- latest update: `2026-03-29 09:00`',
      '- next follow-up: `决定是否分配实例`',
      '- notes: `还没绑定实例`',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(memoryTasksDir, 'remotelab-user-event-log.md'),
    [
      '# Event Log',
      '',
      '- `2026-03-29 08:45` `UTC+8` — user `Trial User` — source `weixin` — event `feedback`',
      '  - instance: `trial24`',
      '  - summary: 用户反馈希望更顺畅地交付视频脚本',
      '  - operator action: 稍后继续跟进',
      '',
      '- `2026-03-29 09:00` `UTC+8` — user `Pending User` — source `weixin` — event `intake noted`',
      '  - summary: 用户已经表达试用意向，但尚未绑定实例',
      '  - operator action: 判断是否需要立即分配',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(memoryTasksDir, 'remotelab-trial-user-ledger.md'),
    [
      '# RemoteLab trial instance occupancy ledger',
      '',
      '## Active assignments',
      '',
      '- `intake1`',
      '  - user: `朋友分发预留`',
      '  - source: `operator note`',
      '  - assigned at: `2026-04-06 11:26` `UTC+8`',
      '  - handoff note: reserved for friend distribution; do not hand out to other people',
      '  - status: reserved / do not reassign outside friend distribution',
      '  - recorded from: direct user note on `2026-04-06`',
      '',
      '## Historical assignments',
      '',
      '- None yet.',
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(join(trialConfigDir, 'auth.json'), JSON.stringify({ token: 'trial-token' }, null, 2), 'utf8');
  writeFileSync(join(intakeConfigDir, 'auth.json'), JSON.stringify({ token: 'intake-token' }, null, 2), 'utf8');
  writeFileSync(join(trialConfigDir, 'auth-sessions.json'), JSON.stringify({ a: {}, b: {} }, null, 2), 'utf8');
  writeFileSync(join(intakeConfigDir, 'auth-sessions.json'), JSON.stringify([{ id: 'auth1' }], null, 2), 'utf8');
  writeFileSync(join(trialConfigDir, 'chat-sessions.json'), JSON.stringify([
    { id: 'sess-trial-1', createdAt: '2026-03-26T15:00:00.000Z', updatedAt: '2026-03-27T12:00:00.000Z', name: 'Trial 24 session 1' },
    { id: 'sess-trial-2', createdAt: '2026-03-27T15:00:00.000Z', updatedAt: '2026-03-28T12:00:00.000Z', name: 'Trial 24 session 2' },
  ], null, 2), 'utf8');
  writeFileSync(join(intakeConfigDir, 'chat-sessions.json'), JSON.stringify([], null, 2), 'utf8');

  writeFileSync(join(trialConfigDir, 'usage-ledger', '2026-03-26.jsonl'), [
    JSON.stringify({
      ts: '2026-03-26T14:00:00.000Z',
      runId: 'run_trial24_1',
      sessionId: 'sess-trial-1',
      sessionName: 'Trial 24 session 1',
      principalType: 'owner',
      principalId: 'owner',
      principalName: 'Owner',
      tool: 'claude',
      model: 'claude-sonnet',
      state: 'completed',
      totalTokens: 150,
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.25,
      operation: 'user_turn',
    }),
    JSON.stringify({
      ts: '2026-03-27T14:00:00.000Z',
      runId: 'run_trial24_2',
      sessionId: 'sess-trial-2',
      sessionName: 'Trial 24 session 2',
      principalType: 'owner',
      principalId: 'owner',
      principalName: 'Owner',
      tool: 'micro-agent',
      model: 'gpt-5.4',
      state: 'completed',
      totalTokens: 240,
      inputTokens: 180,
      outputTokens: 60,
      cachedInputTokens: 90,
      estimatedCostUsd: 0.4,
      estimatedCostModel: 'gpt-5.4',
      costSource: 'estimated_gpt_5_4',
      operation: 'user_turn',
    }),
    JSON.stringify({
      ts: '2026-03-27T18:00:00.000Z',
      runId: 'run_trial24_3',
      sessionId: 'sess-trial-2',
      sessionName: 'Trial 24 session 2',
      principalType: 'owner',
      principalId: 'owner',
      principalName: 'Owner',
      tool: 'claude',
      model: 'claude-sonnet',
      state: 'completed',
      totalTokens: 80,
      inputTokens: 60,
      outputTokens: 20,
      estimatedCostUsd: 0.08,
      estimatedCostModel: 'claude-sonnet',
      costSource: 'estimated_background',
      operation: 'session_label_suggestion',
    }),
  ].join('\n') + '\n', 'utf8');

  writeFileSync(join(intakeConfigDir, 'usage-ledger', '2026-03-27.jsonl'), [
    JSON.stringify({
      ts: '2026-03-27T16:00:00.000Z',
      runId: 'run_intake1_1',
      sessionId: 'sess-intake-1',
      sessionName: 'Intake session',
      principalType: 'owner',
      principalId: 'owner',
      principalName: 'Owner',
      tool: 'codex',
      model: 'gpt-5.4',
      state: 'completed',
      totalTokens: 90,
      inputTokens: 70,
      outputTokens: 20,
      cachedInputTokens: 20,
      estimatedCostUsd: 0.12,
      estimatedCostModel: 'gpt-5.4',
      costSource: 'estimated_gpt_5_4',
      operation: 'user_turn',
    }),
  ].join('\n') + '\n', 'utf8');

  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['scripts/instance-admin.mjs', '--port', String(port)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      INSTANCE_ADMIN_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitFor(async () => {
    try {
      const res = await request(port, '/api/dashboard');
      return res.status === 200 && res.json && res.json.summary ? res : false;
    } catch {
      return false;
    }
  }, 'instance admin startup');

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGKILL');
  if (server.child.stdout) server.child.stdout.destroy();
  if (server.child.stderr) server.child.stderr.destroy();
  await sleep(150);
}

async function main() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });

  try {
    const templateSource = readFileSync(join(repoRoot, 'templates', 'instance-admin.html'), 'utf8');
    assert.doesNotMatch(templateSource, /queueSilentReload|dashboard\/refresh|setTimeout\(loadAll/, 'instance admin UI should not auto-refresh in the background');
    assert.doesNotMatch(templateSource, /async function createTrial[\s\S]*?await loadAll\(\);/, 'trial creation should not trigger a full reload');
    assert.doesNotMatch(templateSource, /async function confirmCreate[\s\S]*?await loadAll\(\);/, 'custom instance creation should not trigger a full reload');
    assert.match(templateSource, /label: '预留'/, 'instance admin UI should render reserved instances distinctly');
    assert.match(templateSource, /usage\.key === 'occupied' \|\| usage\.key === 'reserved'/, 'occupied filter should include reserved instances');
    assert.match(templateSource, /data-view="billing"/, 'instance admin UI should expose the billing monitoring view');

    const pageRes = await request(port, '/');
    assert.equal(pageRes.status, 200, pageRes.text);
    assert.match(pageRes.text, /RemoteLab Admin/, 'admin root page should render the dashboard shell');

    const billingPageRes = await request(port, '/?view=billing');
    assert.equal(billingPageRes.status, 200, billingPageRes.text);
    assert.match(billingPageRes.text, /data-view="billing"/, 'billing view should remain reachable from the admin shell route');

    const res = await request(port, '/api/dashboard');
    assert.equal(res.status, 200, res.text);

    const data = res.json || {};
    assert.ok(data.summary, res.text);
    assert.equal(data.summary.usage.totalTokens, 560, 'dashboard summary should include fleet token totals');
    assert.equal(data.summary.usage.costUsd, 0.25, 'dashboard summary should include exact fleet cost totals');
    assert.equal(data.summary.usage.estimatedCostUsd, 0.6, 'dashboard summary should include estimated fleet cost totals');
    assert.equal(data.summary.usage.byTool[0].key, 'micro-agent', 'dashboard summary should expose tool breakdowns');

    const trial24 = data.instances.find((entry) => entry.name === 'trial24');
    const intake1 = data.instances.find((entry) => entry.name === 'intake1');
    assert.equal(trial24.usage.usageSummary.totals.totalTokens, 470, 'instance payload should include per-instance usage totals');
    assert.equal(trial24.usage.usageSummary.totals.estimatedCostUsd, 0.48);
    assert.equal(trial24.usage.usageSummary.byTool[0].key, 'micro-agent');
    assert.equal(intake1.usage.usageSummary.totals.totalTokens, 90);
    assert.equal(intake1.usage.usageSummary.totals.estimatedCostUsd, 0.12);
    assert.equal(intake1.usage.usageSummary.byTool[0].key, 'codex');
    assert.equal(intake1.usage.usageStatus, 'reserved', 'reserved ledger entry should keep the instance out of the available pool');
    assert.equal(intake1.usage.usageBrief, '已预留，暂不外发', 'reserved instance should expose an explicit non-shareable usage brief');
    assert.equal(intake1.occupancy?.userName, '朋友分发预留', 'reserved instance should expose occupancy metadata for the UI');
    assert.equal(data.summary.openedCount, 0, 'reserved instances should not count as available');
    assert.equal(data.summary.occupiedCount, 2, 'reserved instances should count as unavailable');

    const workbenchRes = await request(port, '/api/workbench');
    assert.equal(workbenchRes.status, 200, workbenchRes.text);

    const workbench = workbenchRes.json || {};
    assert.equal(workbench.summary.totalUsers, 2, 'workbench should merge bound and unbound users');
    assert.equal(workbench.summary.unboundUsers, 1, 'workbench should surface users without instance binding');
    assert.equal(workbench.summary.feedbackUsers, 1, 'workbench should detect feedback signals');
    assert.equal(workbench.instanceSummary.open, 0, 'workbench summary should exclude reserved instances from the available count');
    assert.equal(workbench.instanceSummary.occupied, 2, 'workbench summary should treat reserved instances as unavailable');

    const billingRes = await request(port, '/api/billing');
    assert.equal(billingRes.status, 200, billingRes.text);
    const billing = billingRes.json || {};
    assert.equal(billing.summary.totalTokens, 560, 'billing summary should aggregate fleet tokens');
    assert.equal(billing.summary.backgroundTokens, 80, 'billing summary should separate background token usage');
    assert.equal(billing.summary.usersWithUsage, 1, 'billing summary should attribute usage to bound users when possible');
    assert.equal(billing.byUser[0]?.userName, 'Trial User', 'billing view should attribute bound instance usage to the user');
    assert.equal(billing.byUser[0]?.totalTokens, 470, 'billing view should roll up user usage by bound instance');
    const backgroundGroup = (billing.byOperationGroup || []).find((entry) => entry.key === 'background');
    assert.equal(backgroundGroup?.totalTokens, 80, 'billing view should aggregate background operation groups');
    const sessionManagementBucket = (billing.byOperationCategory || []).find((entry) => entry.key === 'session_management');
    assert.equal(sessionManagementBucket?.totalTokens, 80, 'billing view should expose session-management background costs');

    const pendingBinding = workbench.pending?.queues?.needsBinding || [];
    const feedbackQueue = workbench.pending?.queues?.feedback || [];
    assert.equal(pendingBinding[0]?.userName, 'Pending User', 'pending queue should prioritize unbound users');
    assert.equal(feedbackQueue[0]?.userName, 'Trial User', 'feedback queue should include users with feedback events');

    const trialUser = (workbench.users?.rows || []).find((entry) => entry.userName === 'Trial User');
    assert.equal(trialUser?.instanceName, 'trial24');
    assert.equal(trialUser?.openFeedback, true);
    assert.equal(trialUser?.quickLinks?.publicAccessUrl, 'https://trial24.example.com/?token=trial-token');

    const deleteRes = await request(port, '/api/instances/trial24/delete', { method: 'POST' });
    assert.equal(deleteRes.status, 200, deleteRes.text);

    const [deletedWorkbenchRes, deletedDashboardRes] = await Promise.all([
      request(port, '/api/workbench'),
      request(port, '/api/dashboard'),
    ]);
    assert.equal(deletedWorkbenchRes.status, 200, deletedWorkbenchRes.text);
    assert.equal(deletedDashboardRes.status, 200, deletedDashboardRes.text);

    const deletedWorkbench = deletedWorkbenchRes.json || {};
    const deletedDashboard = deletedDashboardRes.json || {};
    assert.equal(
      Array.isArray(deletedDashboard.instances),
      true,
      'dashboard should still return instances while a concurrent refresh is in flight',
    );
    assert.deepEqual(
      (deletedDashboard.instances || []).map((entry) => entry.name),
      ['intake1'],
      'dashboard should return the surviving instances after delete',
    );
    assert.equal(
      deletedWorkbench.instanceSummary?.total,
      1,
      'workbench should recompute instance totals after delete',
    );

    console.log('test-instance-admin-dashboard: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
