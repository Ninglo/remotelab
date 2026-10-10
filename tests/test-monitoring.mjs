import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitoringReader, projectAccounts, analyzeResources, readService } from '../chat/monitoring.mjs';

const now = Date.parse('2026-10-03T06:00:00Z');
const at = new Date(now).toISOString();
const quota = remainingPercent => [{ id: 'codex', primary: { remainingPercent, windowDurationMins: 10080, resetsAt: '2026-10-07T00:00:00Z' } }];
const sample = (remainingPercent, overrides = {}) => ({ identityId: 'account', label: 'owner@example.com', status: 'ready', quota: quota(remainingPercent), observedAt: at, ...overrides });
const entry = subscriptions => ({ receivedAt: at, snapshot: { subscriptions } });

test('verified recovery clears only that failed Run from attention, and a later failure still alerts', () => {
  const task = { id: 'sch_test', state: 'active', lastExecution: { state: 'failed', runId: 'run_original' } };
  const input = { accounts: [], disks: [], services: [], automations: { items: [task] },
    recovery: [{ kind: 'automation', id: task.id, originRunId: 'run_original', status: 'resolved' }] };
  assert.equal(analyzeResources(input).attention.length, 0);
  task.lastExecution.runId = 'run_later'; assert.equal(analyzeResources(input).attention.length, 1);
  task.lastExecution.runId = 'run_original'; task.lastError = 'New gate failure';
  assert.equal(analyzeResources(input).attention.length, 1, 'an execution repair cannot cover a separate gate failure');
});

test('oneshot execution in progress is not a service fault, and a never-run or failed unit is not healthy', async () => {
  const item = { unit: 'test.service', scope: 'user' };
  const observe = (active, result, started = at) => readService(item, async () => ({ stdout:
    `LoadState=loaded\nType=oneshot\nActiveState=${active}\nResult=${result}\nExecMainStartTimestamp=${started}\n` }));
  assert.equal((await observe('activating', 'success')).status, 'running');
  assert.equal((await observe('inactive', 'success')).status, 'healthy');
  assert.equal((await observe('inactive', 'success', '')).status, 'unknown');
  assert.equal((await observe('failed', 'exit-code')).status, 'failed');
  assert.equal((await observe('activating', 'exit-code')).status, 'failed');
});

test('quotas deduplicate sources without letting a stale or paused source override a valid observation', () => {
  const fleet = { adapters: { fresh: entry([sample(70)]), old: entry([sample(0, { status: 'paused', observedAt: '2026-09-30T00:00:00Z' })]) } };
  const result = projectAccounts({ activeId: 'saved', accounts: [{ id: 'saved', identityId: 'account', label: 'Owner', usage: null }] }, fleet, now);
  assert.equal(result.length, 1); assert.equal(result[0].active, true);
  assert.equal(result[0].status, 'available'); assert.equal(result[0].windows[0].remainingPercent, 70);
  assert.equal(result[0].label, 'o***@example.com');
  fleet.adapters.old = entry([sample(0)]);
  assert.equal(projectAccounts(null, fleet, now)[0].status, 'conflicting');
  assert.deepEqual(projectAccounts(null, fleet, now)[0].windows, []);
});

test('missing, expired and unrelated quota windows never become zero or available weekly capacity', () => {
  assert.deepEqual(projectAccounts({ activeId: 'default', accounts: [{ id: 'default', account: null, usage: null }] }, null, now), []);
  const fleet = { adapters: { test: entry([sample(0, { observedAt: '2026-09-30T00:00:00Z' })]) } };
  assert.equal(projectAccounts(null, fleet, now)[0].status, 'unknown');
  fleet.adapters.test = entry([sample(100, { quota: [{ id: 'codex', primary: { remainingPercent: 100 } }] })]);
  assert.equal(projectAccounts(null, fleet, now)[0].status, 'unknown');
  fleet.adapters.test = entry([sample(0, { quota: [{ id: 'codex', primary: { remainingPercent: 0, windowDurationMins: 10080, resetsAt: '2026-10-02T00:00:00Z' } }] })]);
  assert.equal(projectAccounts(null, fleet, now)[0].status, 'unknown');
  fleet.adapters.test = entry([sample(100, { quota: [{ id: 'other', primary: { remainingPercent: 100, windowDurationMins: 10080 } }] })]);
  assert.equal(projectAccounts(null, fleet, now)[0].status, 'unknown');
  fleet.adapters.test = entry([sample(100, { quota: [{ id: 'codex', primary: { remainingPercent: 100, windowDurationMins: 43200 } }] })]);
  const accounts = projectAccounts(null, fleet, now);
  assert.deepEqual(analyzeResources({ accounts, disks: [], services: [], automations: { items: [] } }).opportunities, []);
});

test('partial failures remain visible, observations share a bounded cache, and credential fields never leave the projection', async () => {
  let reads = 0;
  const config = { fleetStateFile: 'fleet', disks: [{ path: '/', system: true }, { path: '/missing' }], services: [{ unit: 'test.service', scope: 'user', label: 'Test' }] };
  const reader = createMonitoringReader({ now: () => now,
    read: async path => JSON.stringify(path === 'fleet' ? { schemaVersion: 2, adapters: { a: entry([sample(80, { secret: 'never-expose' })]) } } : config),
    getUsage: async () => { reads++; return { window: {}, totals: { totalTokens: 100, costUsd: 0.2, estimatedCostUsd: 1.5 }, topRuns: [{ private: 'never-expose' }], byIdentity: [{ private: 'never-expose' }] }; },
    getTasks: async () => [{ id: 'sch_test', kind: 'recurring', title: 'Daily', state: 'active', lastExecution: { state: 'failed', sessionId: 'session_test' } }],
    getAccounts: async () => ({ activeId: 'account', accounts: [{ id: 'account', identityId: 'account', account: { accessToken: 'never-expose' }, usage: null, home: '/private/credentials' }] }),
    getService: async () => { throw Object.assign(new Error('secret error text'), { code: 'SERVICE_UNAVAILABLE' }); },
    getFs: async path => { if (path === '/missing') throw Object.assign(new Error('secret error text'), { code: 'ENOENT' });
      return { blocks: 100, bsize: 1024 ** 3, bfree: 10, bavail: 4, files: 100, ffree: 20 }; }, getStat: async () => ({ dev: 1 }),
  });
  const [a, b] = await Promise.all([reader(), reader()]);
  assert.equal(a, b); assert.equal(reads, 1);
  assert.equal(a.disks[0].status, 'critical'); assert.equal(a.disks[1].status, 'unknown');
  assert.equal(a.disks[1].availableBytes, undefined);
  assert.equal(a.services[0].status, 'unknown');
  assert.equal(a.usage.totals.costUsd, 0.2); assert.equal(a.usage.totals.estimatedCostUsd, 1.5);
  assert.ok(a.coverage.gaps.some(gap => gap.source === 'disk:/missing'));
  assert.ok(a.attention.some(item => item.kind === 'automation'));
  assert.doesNotMatch(JSON.stringify(a), /never-expose|credentials|secret error text/);
  await reader({ days: 1 }); assert.equal(reads, 2);
});

test('stopped automations do not create failure alerts and duplicate filesystem capacity is marked', async () => {
  const reader = createMonitoringReader({ now: () => now, read: async () => JSON.stringify({ disks: [{ path: '/' }, { path: '/data' }] }),
    getUsage: async () => null, getAccounts: async () => null, getTasks: async () => [{ id: 'sch_old', kind: 'recurring', state: 'completed', lastError: 'old error' }],
    getFs: async () => ({ blocks: 100, bsize: 1024 ** 3, bfree: 80, bavail: 80, files: 0, ffree: 0 }), getStat: async () => ({ dev: 1 }),
  });
  const value = await reader();
  assert.equal(value.disks[0].sharedFilesystem, '/data'); assert.equal(value.disks[1].sharedFilesystem, '/');
  assert.equal(value.disks[0].inodeUsedPercent, null);
  assert.deepEqual(value.attention, []);
});

test('disabled, cancelled and superseded automation failures remain history while a new failure stays current', async () => {
  const tasks = [
    { id: 'cancelled', kind: 'recurring', state: 'cancelled', lastExecution: { state: 'failed', runId: 'old' } },
    { id: 'disabled', kind: 'recurring', state: 'active', enabled: false, lastError: 'old gate error', lastExecution: { state: 'failed', runId: 'old' } },
    { id: 'consumer', kind: 'recurring', state: 'active', enabled: true, check: { at, reason: 'consumer_disabled' }, lastExecution: { state: 'failed', runId: 'old' } },
    { id: 'recovered', kind: 'recurring', state: 'active', enabled: true, lastExecution: { state: 'completed', runId: 'new' } },
    { id: 'failing', kind: 'recurring', state: 'active', enabled: true, lastExecution: { state: 'failed', runId: 'new' } },
  ];
  const ledger = { incidents: Object.fromEntries(tasks.map(task => [task.id,
    { kind: 'automation', id: task.id, status: 'blocked', originRunId: 'old', reason: 'Original delivery unknown' }])) };
  const original = JSON.stringify(ledger);
  const reader = createMonitoringReader({ now: () => now,
    read: async () => JSON.stringify({ recovery: { enabled: true } }), getRecord: async () => ledger,
    getUsage: async () => null, getAccounts: async () => null, getTasks: async () => tasks,
    getFs: async () => ({ blocks: 100, bsize: 1024 ** 3, bfree: 80, bavail: 80, files: 0, ffree: 0 }), getStat: async () => ({ dev: 1 }),
  });
  const value = await reader();
  assert.deepEqual(value.attention.map(item => item.id), ['failing']);
  assert.deepEqual(value.recovery.map(item => [item.currentResourceStatus, item.currentIssue]),
    [['cancelled', false], ['paused', false], ['paused', false], ['healthy', false], ['failed', true]]);
  assert.ok(value.recovery.every(item => item.status === 'blocked' && item.reason === 'Original delivery unknown'));
  assert.equal(JSON.stringify(ledger), original, 'a presentation correction cannot rewrite business acceptance');
  assert.equal(value.automations.items.find(item => item.id === 'disabled').enabled, false);
});

test('an unmet or stale business condition cannot conceal a current execution or condition failure', () => {
  const task = { id: 'test', state: 'active', enabled: true, lastExecution: { state: 'failed' }, check: { at, reason: 'consumer_disabled' } };
  const input = { accounts: [], disks: [], services: [], automations: { items: [task] }, now };
  assert.equal(analyzeResources(input).attention.length, 0);
  task.check.at = new Date(now - 11 * 60_000).toISOString();
  assert.equal(analyzeResources(input).attention.length, 1);
  task.check = { at, reason: 'condition_not_met' };
  assert.equal(analyzeResources(input).attention.length, 1);
  task.check.reason = 'consumer_disabled'; task.lastError = 'Condition read failed';
  assert.equal(analyzeResources(input).attention.length, 1);
});

test('an unavailable automation source leaves old acceptance unknown rather than claiming restoration', async () => {
  const reader = createMonitoringReader({ now: () => now,
    read: async () => JSON.stringify({ recovery: { enabled: true } }),
    getRecord: async () => ({ incidents: { old: { kind: 'automation', id: 'missing', status: 'blocked', originRunId: 'old' } } }),
    getTasks: async () => { throw Object.assign(new Error('unavailable'), { code: 'SOURCE_UNAVAILABLE' }); },
    getUsage: async () => null, getAccounts: async () => null,
    getFs: async () => ({ blocks: 100, bsize: 1024 ** 3, bfree: 80, bavail: 80, files: 0, ffree: 0 }), getStat: async () => ({ dev: 1 }),
  });
  const value = await reader();
  assert.equal(value.recovery[0].currentResourceStatus, 'unknown');
  assert.equal(value.recovery[0].currentIssue, true);
  assert.ok(value.coverage.gaps.some(item => item.source === 'automations'));
});

test('historical admission records without a Run are not represented as hundreds of active jobs', async () => {
  const reader = createMonitoringReader({ now: () => now, read: async () => '{}',
    getUsage: async () => null, getAccounts: async () => null,
    getFs: async () => ({ blocks: 100, bsize: 1024 ** 3, bfree: 80, bavail: 80, files: 0, ffree: 0 }), getStat: async () => ({ dev: 1 }),
    getTasks: async () => [
      { id: 'sch_current', kind: 'recurring', state: 'active' },
      { id: 'trg_live', kind: 'one_time', state: 'running' },
      { id: 'trg_old', kind: 'one_time', state: 'admitted', lastExecution: { scheduledAt: '2026-08-01T00:00:00Z' } },
      { id: 'trg_recent', kind: 'one_time', state: 'admitted', lastExecution: { scheduledAt: at } },
    ],
  });
  const value = await reader();
  assert.equal(value.automations.active, 2); assert.equal(value.coverage.unverifiedAdmissions, 2);
  assert.ok(!value.automations.items.some(item => item.id === 'trg_old'));
  assert.ok(value.automations.items.some(item => item.id === 'trg_recent'));
});

test('a configured important automation missing after a source change is an explicit coverage gap', async () => {
  const reader = createMonitoringReader({ now: () => now,
    read: async () => JSON.stringify({ criticalAutomationIds: ['sch_kept', 'sch_missing'] }),
    getUsage: async () => null, getAccounts: async () => null,
    getTasks: async () => [{ id: 'sch_kept', kind: 'recurring', state: 'active', check: { at, reason: 'no_match' } }],
    getFs: async () => ({ blocks: 100, bsize: 1024 ** 3, bfree: 80, bavail: 80, files: 0, ffree: 0 }), getStat: async () => ({ dev: 1 }),
  });
  const value = await reader();
  assert.deepEqual(value.coverage.gaps, [{ source: 'automation:sch_missing', code: 'NOT_FOUND' }]);
  assert.deepEqual(value.automations.items[0].check, { at, reason: 'no_match' });
  assert.equal(value.attention.filter(item => item.kind === 'automation').length, 0);
});
