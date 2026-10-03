import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMonitoringAlerts } from '../chat/monitoring-alerts.mjs';
import { renderMonitoringReport } from '../lib/monitoring-report.mjs';

const disk = { kind: 'disk', subject: 'System disk', severity: 'critical', availableBytes: 3 * 1024 ** 3, usedPercent: 97 };
const snapshot = attention => ({ generatedAt: '2026-10-03T06:00:00Z', attention,
  accounts: [], disks: [], services: [], coverage: { unknownAccounts: 1, gaps: [] },
  automations: { active: 3 }, opportunities: [], usage: null });

function fixture() {
  let state = null, sends = 0;
  return { options: { config: {}, load: async () => structuredClone(state), save: async (_file, value) => { state = structuredClone(value); },
    send: async (_events, _config, id) => { sends++; assert.ok(id.length <= 50); return 'om_batch'; } },
  getState: () => state, getSends: () => sends };
}

test('normal observations are silent; simultaneous urgent issues send once and survive restart', async () => {
  const f = fixture();
  await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([]) }); assert.equal(f.getSends(), 0);
  const value = snapshot([disk, { kind: 'service', subject: 'Service', severity: 'critical' }]);
  assert.equal((await dispatchMonitoringAlerts({ ...f.options, snapshot: value })).sent, 2);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value }); assert.equal(f.getSends(), 1);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([]) });
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value }); assert.equal(f.getSends(), 2);
});

test('unknown disk measurement is not recovery; only explicit recovery rearms an urgent notification', async () => {
  const f = fixture(); await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([disk]) });
  const unknown = snapshot([]); unknown.disks = [{ label: disk.subject, status: 'unknown' }];
  await dispatchMonitoringAlerts({ ...f.options, snapshot: unknown });
  await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([disk]) }); assert.equal(f.getSends(), 1);
});

test('interrupted or missing receipts require readback and never automatically replay', async () => {
  const f = fixture();
  await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([disk]), send: async () => { throw new Error('uncertain'); } });
  assert.equal(Object.values(f.getState().incidents)[0].status, 'needs_review');
  await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([disk]) }); assert.equal(f.getSends(), 0);
  const state = f.getState(); Object.values(state.batches)[0].status = 'sending'; Object.values(state.incidents)[0].status = 'sending';
  await f.options.save('', state);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([disk]) }); assert.equal(f.getSends(), 0);
  assert.equal(Object.values(f.getState().batches)[0].status, 'needs_review');
});

test('only configured important automations escalate after persistent failed observations', async () => {
  const f = fixture(); const value = snapshot([{ kind: 'automation', id: 'sch_daily', subject: 'Daily', severity: 'warning' }]);
  const options = { ...f.options, config: { criticalAutomationIds: ['sch_daily'] }, snapshot: value };
  await dispatchMonitoringAlerts(options); await dispatchMonitoringAlerts(options); assert.equal(f.getSends(), 0);
  await dispatchMonitoringAlerts(options); assert.equal(f.getSends(), 1);
});

test('the existing incident can be baselined without a deployment-time group message', async () => {
  const f = fixture();
  await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([disk]), baseline: true });
  await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([disk]) }); assert.equal(f.getSends(), 0);
});

test('a disk leaving the critical range rearms a later critical event with a new delivery key', async () => {
  const f = fixture(), keys = [];
  const options = { ...f.options, send: async (_events, _config, key) => { keys.push(key); return 'om_batch'; } };
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([disk]) });
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([{ ...disk, severity: 'warning' }]) });
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([disk]) });
  assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]);
});

test('an observer does not alert on its own timer being stopped during operator maintenance', async () => {
  const f = fixture();
  const self = { kind: 'service', id: 'observer.timer', subject: 'Observer', severity: 'critical' };
  await dispatchMonitoringAlerts({ ...f.options, config: { ignoreUnits: ['observer.timer'] }, snapshot: snapshot([self]) });
  assert.equal(f.getSends(), 0);
  await dispatchMonitoringAlerts({ ...f.options, config: { ignoreUnits: ['observer.timer'] }, snapshot: snapshot([self, disk]) });
  assert.equal(f.getSends(), 1);
});

test('daily Markdown includes the actual observation range and retains uncertainty without publishing', () => {
  const value = snapshot([disk]); value.disks = [{ label: 'Missing', status: 'unknown', observedAt: value.generatedAt }];
  value.coverage.gaps = [{ source: 'disk', code: 'ENOENT' }];
  const report = renderMonitoringReport(value);
  assert.match(report, /资源与运行/); assert.match(report, /3\.00 GiB/); assert.match(report, /读取不可用/);
  assert.match(report, /未知不当作可用/); assert.match(report, /ENOENT/); assert.match(report, /本轮没有已核验的七天富余额度/);
});
