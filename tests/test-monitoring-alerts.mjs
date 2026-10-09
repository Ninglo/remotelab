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
  const recovered = snapshot([]); recovered.disks = [{ label: disk.subject, status: 'healthy' }];
  recovered.services = [{ label: 'Service', status: 'healthy' }];
  await dispatchMonitoringAlerts({ ...f.options, snapshot: recovered });
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

test('a missing or renamed source does not rearm an already reported automation failure', async () => {
  const f = fixture(), config = { criticalAutomationIds: ['sch_daily'] };
  const failed = snapshot([{ kind: 'automation', id: 'sch_daily', subject: 'Daily', severity: 'warning' }]);
  for (let i = 0; i < 3; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: failed });
  assert.equal(f.getSends(), 1);
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: snapshot([]) });
  const unavailable = snapshot([]); unavailable.coverage.gaps = [{ source: 'automations', code: 'UNAVAILABLE' }];
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: unavailable });
  failed.attention[0].subject = 'Renamed daily review';
  for (let i = 0; i < 5; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: failed });
  assert.equal(f.getSends(), 1);
  const recovered = snapshot([]);
  recovered.automations.items = [{ id: 'sch_daily', state: 'active', lastExecution: { state: 'completed' } }];
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: recovered });
  for (let i = 0; i < 3; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: failed });
  assert.equal(f.getSends(), 2, 'a real recovery rearms a later failure');
});

test('an unfinished retry and a disappeared service or disk are not recovery', async () => {
  const f = fixture(), config = { criticalAutomationIds: ['sch_daily'] };
  const failed = snapshot([disk, { kind: 'service', id: 'app.service', subject: 'App', severity: 'critical' },
    { kind: 'automation', id: 'sch_daily', subject: 'Daily', severity: 'warning' }]);
  for (let i = 0; i < 3; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: failed });
  const sends = f.getSends(), retry = snapshot([]);
  retry.automations.items = [{ id: 'sch_daily', state: 'active', check: { at: '2026-10-03T07:00:00Z', reason: 'match' }, lastExecution: { state: 'running' } }];
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: retry });
  for (let i = 0; i < 3; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: failed });
  assert.equal(f.getSends(), sends);
});

test('independently verified repair rearms the next failed Run without rewriting the historical failure', async () => {
  const f = fixture(), config = { criticalAutomationIds: ['sch_daily'] };
  const failed = snapshot([{ kind: 'automation', id: 'sch_daily', subject: 'Daily', severity: 'warning' }]);
  for (let i = 0; i < 3; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: failed });
  const repaired = snapshot([]);
  repaired.automations.items = [{ id: 'sch_daily', state: 'active', lastExecution: { state: 'failed', runId: 'run_original' } }];
  repaired.recovery = [{ kind: 'automation', id: 'sch_daily', originRunId: 'run_original', status: 'resolved' }];
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: repaired });
  for (let i = 0; i < 3; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: failed });
  assert.equal(f.getSends(), 2);
});

test('resuming with a baseline also acknowledges important failures below the three-observation threshold', async () => {
  const f = fixture(), config = { criticalAutomationIds: ['sch_daily'] };
  const failed = snapshot([{ kind: 'automation', id: 'sch_daily', subject: 'Daily', severity: 'warning' }]);
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: failed, baseline: true });
  for (let i = 0; i < 6; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: failed });
  assert.equal(f.getSends(), 0, 'old failures are not resent on the third observation after resume');
  assert.equal(Object.values(f.getState().incidents)[0].status, 'baseline');
});

test('a read-only dry run predicts a notification without saving state or sending', async () => {
  const f = fixture(); let saves = 0;
  const result = await dispatchMonitoringAlerts({ ...f.options, snapshot: snapshot([disk]), dryRun: true,
    save: async () => { saves++; } });
  assert.equal(result.wouldSend, 1); assert.equal(result.sent, 0);
  assert.equal(f.getSends(), 0); assert.equal(saves, 0); assert.equal(f.getState(), null);
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

test('one observer batches persistent service, account-loss and exhaustion incidents, with explicit recovery', async () => {
  const f = fixture(), config = { confirmationObservations: 3, accountAlerts: { enabled: true, sources: ['approved'] } };
  const value = snapshot([{ kind: 'service', id: 'app.service', subject: 'App', severity: 'critical' }]);
  value.accounts = [{ id: 'a', label: 'A', status: 'unknown', sources: ['approved'] },
    { id: 'b', label: 'B', status: 'exhausted', sources: ['approved'] },
    { id: 'outside', status: 'unknown', sources: ['another-instance'] }];
  const options = { ...f.options, config, snapshot: value };
  await dispatchMonitoringAlerts(options); await dispatchMonitoringAlerts(options);
  assert.equal(f.getSends(), 0);
  assert.equal((await dispatchMonitoringAlerts(options)).sent, 3);
  await dispatchMonitoringAlerts(options); assert.equal(f.getSends(), 1);
  const unknown = snapshot([]); unknown.accounts = [{ id: 'b', status: 'unknown', sources: ['approved'] }];
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: unknown });
  await dispatchMonitoringAlerts(options); assert.equal(f.getSends(), 1, 'unknown is not quota recovery');
  const recovered = snapshot([]); recovered.services = [{ unit: 'app.service', status: 'healthy' }];
  recovered.accounts = value.accounts.map(account => ({ ...account, status: 'available' }));
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: recovered });
  await dispatchMonitoringAlerts(options); await dispatchMonitoringAlerts(options);
  assert.equal(f.getSends(), 1);
  assert.equal((await dispatchMonitoringAlerts(options)).sent, 3);
});

test('account consolidation is opt-in and baselines existing failures before the threshold', async () => {
  const f = fixture(), value = snapshot([]);
  value.accounts = [{ id: 'a', status: 'unknown', sources: ['approved'] }];
  for (let i = 0; i < 4; i++) await dispatchMonitoringAlerts({ ...f.options, snapshot: value });
  assert.equal(f.getSends(), 0);
  const config = { confirmationObservations: 3, accountAlerts: { enabled: true } };
  value.attention = [{ kind: 'service', id: 'app.service', severity: 'critical' }];
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value, baseline: true });
  for (let i = 0; i < 4; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value });
  assert.equal(f.getSends(), 0);
  assert.equal(Object.values(f.getState().incidents).every(incident => incident.status === 'baseline'), true);
});
