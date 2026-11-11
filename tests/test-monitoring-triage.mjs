import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyFailure, probeService, probeLocalHealth, triageMonitoringIncident as triage } from '../chat/monitoring-triage.mjs';

const now = Date.parse('2026-11-09T00:10:00Z');
const fixture = () => ({ now, item: { key: 'incident', kind: 'service', id: 'hub.service', attempts: [], createdAt: '2026-11-09T00:00:00Z' },
  snapshot: { services: [{ unit: 'hub.service', status: 'failed' }] },
  config: { services: [{ unit: 'hub.service', scope: 'system' }] },
  inspectService: async () => ({ state: { ActiveState: 'failed', LoadState: 'loaded', Type: 'simple', Result: 'exit-code', ExecMainStatus: '1' } }) });

test('known external blockers are precise and private error strings never become the public result', () => {
  const d = dependencyFailure('private-user@private-host: Permission denied (publickey,password).');
  assert.equal(d.code, 'ssh_authentication_failed'); assert.doesNotMatch(JSON.stringify(d), /private/);
  assert.equal(dependencyFailure('Permission denied while opening a local file'), null);
  assert.equal(dependencyFailure('SSH timed out'), null);
  assert.equal(dependencyFailure('provider error 99991672').agent, true, 'permission setup may use existing authorized self-service');
});

test('service logs are bounded and restricted to the current invocation', async () => {
  const calls = [], invocation = 'a'.repeat(32);
  const result = await probeService({ unit: 'hub.service', scope: 'system' }, { now, execute: async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: file === 'systemctl' ? `LoadState=loaded\nInvocationID=${invocation}\nResult=exit-code` : 'secret-user: Permission denied (publickey).' };
  } });
  assert.equal(result.dependency.code, 'ssh_authentication_failed');
  assert.ok(calls[1].args.includes(`_SYSTEMD_INVOCATION_ID=${invocation}`));
  assert.equal(calls[1].options.maxBuffer, 32768);
  assert.doesNotMatch(JSON.stringify(result), /secret-user/);
  await assert.rejects(probeService({ unit: 'x; reboot', scope: 'system' }), /UNREGISTERED/);
});

test('registered recovery saves intent before one action; an uncertain action is never replayed', async () => {
  const f = fixture(); let calls = 0;
  f.config.serviceActions = { 'hub.service': { action: 'restart', healthUrl: 'http://127.0.0.1:1/healthz' } };
  f.beforeAction = async intent => { f.item.triageAction = intent; };
  f.execute = async (file, args) => { calls++; assert.ok(f.item.triageAction); assert.equal(file, 'sudo');
    assert.deepEqual(args, ['-n', 'systemctl', '--no-block', 'restart', 'hub.service']); throw Object.assign(Error('lost ack'), { code: 'ETIMEDOUT' }); };
  assert.equal((await triage(f)).code, 'service_restart_unverified');
  assert.equal((await triage(f)).disposition, 'agent'); assert.equal(calls, 1);
  delete f.item.triageAction; f.config.services[0].maintenance = { reason: 'explicit stop' };
  await triage(f); assert.equal(calls, 1);
  delete f.config.services[0].maintenance;
  f.inspectService = async () => ({ state: { ActiveState: 'inactive', LoadState: 'loaded', Type: 'simple', Result: 'success' } });
  await triage(f); assert.equal(calls, 1, 'a clean manual stop is not an automatic restart target');
});

test('SSH blocker never restarts; native recovery gets a finite window before diagnosis', async () => {
  const f = fixture();
  f.config.serviceActions = { 'hub.service': { action: 'restart' } };
  f.inspectService = async () => ({ state: { ActiveState: 'failed' }, dependency: dependencyFailure('Permission denied (publickey).') });
  assert.equal((await triage(f)).disposition, 'blocked');
  f.inspectService = async () => ({ state: { ActiveState: 'activating', SubState: 'auto-restart' } });
  f.item.createdAt = new Date(now - 60_000).toISOString(); assert.equal((await triage(f)).disposition, 'wait');
  f.item.createdAt = new Date(now - 180_000).toISOString(); assert.equal((await triage(f)).disposition, 'agent');
});

test('process availability alone cannot pass the business health check or stabilization window', async () => {
  const f = fixture(); f.snapshot.services[0] = { unit: 'hub.service', status: 'healthy', recoveryReady: false };
  f.config.serviceActions = { 'hub.service': { action: 'restart', healthUrl: 'http://127.0.0.1:1/healthz' } };
  f.health = async () => ({ healthy: false }); assert.equal((await triage(f)).disposition, 'wait');
  f.snapshot.services[0].recoveryReady = true; assert.equal((await triage(f)).code, 'business_health_failed');
  f.health = async () => ({ healthy: true }); assert.equal((await triage(f)).disposition, 'resolved');
});

test('health probes stay local, do not follow redirects, and require positive business health', async () => {
  await assert.rejects(probeLocalHealth('https://example.com'), /INVALID_LOCAL/);
  const good = await probeLocalHealth('http://127.0.0.1:1/healthz', { fetcher: async (_u, options) => {
    assert.equal(options.redirect, 'error'); return new Response('{"ok":true}'); } });
  assert.equal(good.healthy, true);
  assert.equal((await probeLocalHealth('http://127.0.0.1:1', { fetcher: async () => new Response('{"ok":false}') })).healthy, false);
});

test('automation outcome and every required delivery need matching evidence; provider completion is insufficient', async () => {
  const f = fixture(); f.item = { key: 'i', kind: 'automation', id: 'task', originRunId: 'origin', attempts: [] };
  f.task = { state: 'active', lastExecution: { runId: 'origin', state: 'failed' } };
  f.origin = { id: 'origin', state: 'completed' }; f.requestRecord = { result: { state: 'completed' } };
  assert.equal((await triage(f)).disposition, 'agent');
  f.item.attempts = [{ requestId: 'repair', runId: 'run', receiptFile: '/receipt', sourceDelivery: {} }];
  f.receipt = { key: 'i', requestId: 'repair', status: 'blocked', checks: { task: true, delivery: 'unknown' }, evidence: ['/artifact'] };
  f.deliveries = [{ runId: 'run', surfaceKind: 'final', state: 'delivered', externalId: 'om_1' },
    { runId: 'run', surfaceKind: 'final', state: 'needs_review' }];
  assert.equal((await triage(f)).code, 'delivery_readback_required');
  f.deliveries[1] = { runId: 'run', surfaceKind: 'final', state: 'delivered', externalId: 'om_2' };
  assert.equal((await triage(f)).disposition, 'resolved');
  f.receipt.requestId = 'unrelated'; assert.equal((await triage(f)).disposition, 'agent');
  f.receipt.requestId = 'repair'; f.deliveries[1].state = 'pending'; f.item.updatedAt = new Date(now).toISOString();
  assert.equal((await triage(f)).disposition, 'wait');
  f.item.triage = { code: 'native_delivery_pending', waitStartedAt: new Date(now - 11 * 60_000).toISOString() };
  assert.equal((await triage(f)).disposition, 'agent', 'rechecks cannot move the delivery deadline forward');
});

test('native work and delivery waits do not create a second task, stop or supersession is not acceptance', async () => {
  const f = fixture(); f.item = { kind: 'automation', id: 'task', originRunId: 'old', attempts: [] };
  f.task = { state: 'active', lastExecution: { runId: 'old' } }; f.latestRun = { id: 'manual', state: 'running' };
  assert.equal((await triage(f)).code, 'original_work_running');
  f.task.state = 'paused'; assert.equal((await triage(f)).disposition, 'cancelled');
  f.task.state = 'active'; f.task.lastExecution.runId = 'new'; assert.equal((await triage(f)).code, 'task_superseded');
});

test('shared account outage waits for fresh availability and never treats account recovery as task completion', async () => {
  const f = fixture(); f.item = { kind: 'automation', id: 'task', originRunId: 'old', attempts: [] };
  f.task = { state: 'active', lastExecution: { runId: 'old', error: '暂无可用的 Codex 账号，请等待限流或额度恢复，或完成账号登录。' } };
  assert.equal((await triage(f)).disposition, 'wait');
  f.snapshot.accountContinuity = { remainingPercent: 0, backupCount: 0, observedAt: new Date(now).toISOString() };
  assert.equal((await triage(f)).code, 'codex_account_unavailable');
  f.snapshot.accountContinuity.remainingPercent = 60;
  assert.equal((await triage(f)).disposition, 'wait', 'positive quota alone does not prove execution availability');
  f.snapshot.accountContinuity.executionAvailable = true;
  assert.equal((await triage(f)).code, 'task_acceptance_required');
  f.snapshot.accountContinuity.observedAt = new Date(now - 180000).toISOString();
  assert.equal((await triage(f)).disposition, 'wait', 'stale healthy quota cannot release the dependency');
  f.snapshot.accountContinuity = { remainingPercent: 0, autoSwitch: true, backupCount: 1, executionAvailable: true, observedAt: new Date(now).toISOString() };
  assert.equal((await triage(f)).disposition, 'agent');
});
