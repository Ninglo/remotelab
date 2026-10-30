import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDiskGrowth, diskGrowthAttention, recordDiskSamples } from '../chat/disk-growth.mjs';
import { dispatchMonitoringAlerts } from '../chat/monitoring-alerts.mjs';
import { createMonitoringReader } from '../chat/monitoring.mjs';

const GiB = 1024 ** 3, now = Date.parse('2026-10-30T08:00:00Z');
const point = (minutesAgo, availableGiB, extra = {}) => ({ path: '/', label: '系统盘', filesystemId: 'root-a',
  totalBytes: 100 * GiB, availableBytes: availableGiB * GiB, usedPercent: 70, status: 'healthy',
  observedAt: new Date(now - minutesAgo * 60_000).toISOString(), ...extra });
const config = { enabled: true, paths: ['/'] };
const assess = (disk, samples) => assessDiskGrowth([disk], { samples }, config, now)[0];

test('rapid writes alert with healthy capacity, including a burst before fifteen minutes', () => {
  const disk = point(0, 30), row = assess(disk, [point(2, 31.1)]);
  assert.equal(row.status, 'warning'); assert.equal(row.rule, 'window:15');
  assert.equal(disk.status, 'healthy');
  assert.equal(diskGrowthAttention([row], [disk])[0].kind, 'diskGrowth');
  assert.equal(assess(point(0, 30), [point(50, 32.1)]).rule, 'window:60');
  assert.equal(assess(point(0, 30), [point(1200, 35.1)]).rule, 'window:1440');
});

test('measured multi-hour growth forecasts reaching the unchanged reserve', () => {
  const row = assess(point(0, 17), [point(360, 18)]);
  assert.equal(row.rule, 'forecast'); assert.equal(row.hoursToReserve, 12);
  assert.match(row.detail, /6.0小时净增 1.00 GiB/);
  assert.equal(assess(point(0, 40), [point(360, 41)]).status, 'healthy');
});

test('overview exposes growth attention while its capacity reading remains healthy', async () => {
  const reader = createMonitoringReader({ now: () => now,
    read: async () => JSON.stringify({ disks: [{ path: '/', label: '系统盘', system: true }], diskGrowth: config }),
    getTasks: async () => [], getUsage: async () => null, getAccounts: async () => null,
    getFs: async () => ({ blocks: 100 * GiB, bsize: 1, bfree: 35 * GiB, bavail: 30 * GiB, files: 100, ffree: 90 }),
    getStat: async () => ({ dev: 123 }),
    getRecord: async () => ({ samples: [point(2, 31.1, { filesystemId: '123' })] }),
  });
  const result = await reader();
  assert.equal(result.disks[0].status, 'healthy');
  assert.equal(result.diskGrowth[0].status, 'warning');
  assert.equal(result.attention.find(e => e.kind === 'diskGrowth').id, '/');
  assert.equal(result.attention.some(e => e.kind === 'disk'), false);
});

test('flat/decreasing use clears; missing, stale, changed and future samples remain unknown', () => {
  assert.equal(assess(point(0, 30), [point(60, 29)]).status, 'healthy');
  assert.equal(assess(point(0, 30), [point(60, 30)]).status, 'healthy');
  assert.equal(assess(point(0, 30), []).status, 'unknown');
  assert.equal(assess(point(4, 30), [point(60, 32)]).status, 'unknown');
  assert.equal(assess(point(0, 30), [point(-10, 32)]).status, 'unknown');
  assert.equal(assess(point(0, 30), [point(60, 32, { filesystemId: 'old-root' })]).status, 'unknown');
  assert.equal(assess(point(0, 30), [point(60, 32, { totalBytes: 90 * GiB })]).status, 'unknown');
  assert.deepEqual(assessDiskGrowth([point(0, 30)], {}, {}, now), []);
});

test('durable history survives restart, deduplicates each minute and drops old or invalid samples', async () => {
  let state = { samples: [point(3000, 50), point(60, 31), { path: '/', availableBytes: 0 }] };
  const options = { now, load: async () => structuredClone(state), save: async (_, v) => { state = v; } };
  await recordDiskSamples([point(0, 30)], config, options);
  await recordDiskSamples([point(0, 29.9)], config, options);
  assert.equal(state.samples.length, 2);
  assert.equal(state.samples[1].availableBytes, 29.9 * GiB);
  assert.equal(assessDiskGrowth([point(0, 29)], state, config, now)[0].status, 'warning');
});

test('growth sends before capacity warnings, deduplicates, survives unknown readings and rearms only after recovery', async () => {
  let state = null, sends = 0, updates = 0;
  const disk = point(0, 30), row = assess(disk, [point(2, 31.1)]);
  const options = { now, config: { noisePolicy: { mode: 'risk_only' } },
    load: async () => structuredClone(state), save: async (_, value) => { state = structuredClone(value); },
    send: async () => `om_growth_${++sends}`, update: async () => { updates++; } };
  const snapshot = rows => ({ generatedAt: disk.observedAt, disks: [disk], diskGrowth: rows,
    attention: diskGrowthAttention(rows, [disk]), services: [], accounts: [], automations: { items: [] }, coverage: { gaps: [] } });
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([row]) });
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([{ ...row, growthBytes: row.growthBytes + 100 }]) });
  assert.equal(sends, 1); assert.equal(updates, 0);
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([{ path: '/', status: 'unknown' }]) });
  assert.equal(Object.values(state.incidents)[0].active, true);
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([{ path: '/', status: 'healthy' }]) });
  assert.equal(Object.values(state.incidents)[0].active, false);
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([row]) });
  assert.equal(sends, 2);
});
