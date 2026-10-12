import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationHealthReader } from '../chat/automation-tasks.mjs';
import { createMonitoringReader } from '../chat/monitoring.mjs';

const at = '2026-10-12T10:00:00Z';
const trigger = (id, fields = {}) => ({ id, status: 'delivered', enabled: true, scheduledAt: at, ...fields });

test('health reads the latest occurrence, preserves stable ties, and shares run reads only within a collection', async () => {
  let state = 'failed';
  const reads = [];
  const reader = createAutomationHealthReader({
    getSchedules: async () => [{ id: 'daily', title: 'Daily', status: 'active', enabled: true }],
    getTriggers: async () => [
      trigger('old', { scheduleId: 'daily', scheduledAt: '2025-01-01', runId: 'old-run' }),
      trigger('latest', { scheduleId: 'daily', runId: 'shared' }),
      trigger('tie', { scheduleId: 'daily', runId: 'tie-run' }),
      trigger('single', { runId: 'shared' }),
    ],
    readRun: async id => { reads.push(id); assert.equal(id, 'shared'); return { state, completedAt: at }; },
    readRequest: async () => assert.fail('existing Run needs no receipt'),
  });
  let tasks = await reader();
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find(t => t.id === 'daily').lastExecution.id, 'latest');
  assert.equal(tasks.find(t => t.id === 'single').state, 'failed');
  assert.deepEqual(reads, ['shared']);
  state = 'completed';
  tasks = await reader();
  assert.equal(tasks.find(t => t.id === 'daily').lastExecution.state, 'completed');
  assert.deepEqual(reads, ['shared', 'shared']);
});

test('archived receipts, native dispatch and missing evidence retain the existing execution semantics', async () => {
  const reader = createAutomationHealthReader({ getSchedules: async () => [],
    getTriggers: async () => [trigger('receipt', { runId: 'receipt' }), trigger('native', { runId: 'native' }),
      trigger('missing', { runId: 'missing' }), trigger('cancelled', { status: 'cancelled', runId: 'receipt' })],
    readRun: async () => null,
    readRequest: async id => id === 'receipt' ? { result: { state: 'failed', error: { message: 'actual failure' } }, settledAt: at, sessionId: 's' }
      : id === 'native' ? { nativeDispatchRunId: 'native' } : null,
    readNativeRun: async () => ({ state: 'running', createdAt: at, sessionId: 'native-session' }),
  });
  const tasks = new Map((await reader()).map(t => [t.id, t]));
  assert.equal(tasks.get('receipt').state, 'failed');
  assert.equal(tasks.get('receipt').lastExecution.error, 'actual failure');
  assert.equal(tasks.get('native').state, 'running');
  assert.equal(tasks.get('missing').state, 'admitted');
  assert.equal(tasks.get('missing').lastExecution.runAvailable, false);
  assert.equal(tasks.get('cancelled').state, 'cancelled');
});

test('lightweight data preserves gate errors, disabled tasks, failed execution alerts and recovery classification', async () => {
  const schedules = [
    { id: 'bad', status: 'active', enabled: true },
    { id: 'off', status: 'active', enabled: false },
    { id: 'gate', status: 'active', enabled: true, lastError: 'gate broken' },
    { id: 'fixed', status: 'active', enabled: true },
    { id: 'empty', status: 'paused', enabled: false },
  ];
  const getTasks = createAutomationHealthReader({ getSchedules: async () => schedules,
    getTriggers: async () => ['bad', 'off', 'fixed'].map(id => trigger(id, { scheduleId: id, runId: id })),
    readRun: async id => ({ state: id === 'fixed' ? 'completed' : 'failed', completedAt: at }),
  });
  const reader = createMonitoringReader({ getTasks, getUsage: async () => null, getAccounts: async () => null,
    now: () => Date.parse(at), read: async () => JSON.stringify({ recovery: { enabled: true }, criticalAutomationIds: ['empty', 'absent'] }),
    getRecord: async () => ({ incidents: { fixed: { kind: 'automation', id: 'fixed', status: 'blocked', originRunId: 'previous' } } }),
    getFs: async () => ({ blocks: 100, bsize: 1024 ** 3, bfree: 80, bavail: 80, files: 0, ffree: 0 }),
    getStat: async () => ({ dev: 1 }),
  });
  const snapshot = await reader();
  assert.deepEqual(snapshot.attention.filter(x => x.kind === 'automation').map(x => x.id).sort(), ['bad', 'gate']);
  assert.equal(snapshot.recovery[0].currentResourceStatus, 'healthy');
  assert.equal(snapshot.automations.total, 5);
  assert.ok(snapshot.coverage.gaps.some(x => x.source === 'automation:absent'));
  assert.ok(!snapshot.coverage.gaps.some(x => x.source === 'automation:empty'));
});

test('read failure is a coverage gap and cannot become a fabricated healthy task', async () => {
  const getTasks = createAutomationHealthReader({ getSchedules: async () => [],
    getTriggers: async () => [trigger('broken', { runId: 'broken' })],
    readRun: async () => { throw Object.assign(new Error('unreadable'), { code: 'EIO' }); },
  });
  await assert.rejects(getTasks(), { code: 'EIO' });
});
