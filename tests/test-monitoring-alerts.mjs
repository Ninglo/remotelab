import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMonitoringAlerts, renderMonitoringAlert, runMonitoringAlerts, renderMonitoringAlertCard, updateMonitoringAlert } from '../chat/monitoring-alerts.mjs';
import { renderMonitoringReport } from '../lib/monitoring-report.mjs';

const disk = { kind: 'disk', subject: 'System disk', severity: 'critical', availableBytes: 3 * 1024 ** 3, usedPercent: 97 };
const snapshot = attention => ({ generatedAt: '2026-10-03T06:00:00Z', attention,
  accounts: [], disks: [], services: [], coverage: { unknownAccounts: 1, gaps: [] },
  automations: { active: 3 }, opportunities: [], usage: null });

function fixture() {
  let state = null, sends = 0, updates = 0;
  return { options: { config: {}, load: async () => structuredClone(state), save: async (_file, value) => { state = structuredClone(value); },
    send: async (_events, _config, id) => { sends++; assert.ok(id.length <= 50); return `om_batch_${sends}`; },
    update: async (_events, _config, id) => { updates++; return id; } },
  getState: () => state, getSends: () => sends, getUpdates: () => updates };
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

test('a disk fluctuating within an unresolved incident edits its original message', async () => {
  const f = fixture(), keys = [];
  const options = { ...f.options, send: async (_events, _config, key) => { keys.push(key); return 'om_batch'; } };
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([disk]) });
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([{ ...disk, severity: 'warning', availableBytes: 30 * 1024 ** 3, usedPercent: 88 }]) });
  await dispatchMonitoringAlerts({ ...options, snapshot: snapshot([disk]) });
  assert.equal(keys.length, 1); assert.equal(f.getUpdates(), 2);
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

test('daily source keeps stopped automation repairs out of the current failure table without deleting their audit', () => {
  const value = snapshot([]);
  value.recovery = [
    { subject: 'Cancelled evaluation', status: 'blocked', currentResourceStatus: 'cancelled', label: '已取消', reason: 'Old error requiring no work', attempts: 1 },
    { subject: 'Current failure', status: 'blocked', currentResourceStatus: 'failed', label: '补救受阻', reason: 'Current dependency', attempts: 1 },
  ];
  const report = renderMonitoringReport(value);
  assert.match(report, /当前故障处理[\s\S]*Current failure/);
  assert.match(report, /历史处理记录.*1条/);
  assert.doesNotMatch(report, /Cancelled evaluation|Old error requiring no work/);
  assert.equal(value.recovery.length, 2);
});

test('normal exhaustion and remote account observation loss do not notify; service recovery still rearms', async () => {
  const f = fixture(), config = { confirmationObservations: 3, accountAlerts: { enabled: true, sources: ['approved'] } };
  const value = snapshot([{ kind: 'service', id: 'app.service', subject: 'App', severity: 'critical' }]);
  value.accounts = [{ id: 'a', label: 'A', status: 'unknown', sources: ['approved'] },
    { id: 'b', label: 'B', status: 'exhausted', sources: ['approved'] },
    { id: 'outside', status: 'unknown', sources: ['another-instance'] }];
  const options = { ...f.options, config, snapshot: value };
  await dispatchMonitoringAlerts(options); await dispatchMonitoringAlerts(options);
  assert.equal(f.getSends(), 0);
  assert.equal((await dispatchMonitoringAlerts(options)).sent, 1);
  await dispatchMonitoringAlerts(options); assert.equal(f.getSends(), 1);
  const unknown = snapshot([]); unknown.accounts = [{ id: 'b', status: 'unknown', sources: ['approved'] }];
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: unknown });
  await dispatchMonitoringAlerts(options); assert.equal(f.getSends(), 1, 'unknown is not quota recovery');
  const recovered = snapshot([]); recovered.services = [{ unit: 'app.service', status: 'healthy' }];
  recovered.accounts = value.accounts.map(account => ({ ...account, status: 'available' }));
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: recovered });
  await dispatchMonitoringAlerts(options); await dispatchMonitoringAlerts(options);
  assert.equal(f.getSends(), 1);
  assert.equal((await dispatchMonitoringAlerts(options)).sent, 1);
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


test('local continuity incidents require persistence; fleet exhaustion alone stays silent', async () => {
  const f = fixture(), config = { accountAlerts: { enabled: true } };
  const value = snapshot([{ kind: 'accountContinuity', id: 'local-codex', subject: 'Local continuity', severity: 'warning',
    action: { risk: 'medium', requiresConfirmation: true, summary: 'No authorized backup; choose a new login or wait for reset.' } }]);
  value.accountContinuity = { status: 'no_backup' };
  for (let i = 0; i < 2; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value });
  assert.equal(f.getSends(), 0);
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value }); assert.equal(f.getSends(), 1);
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value }); assert.equal(f.getSends(), 1);
  const ready = snapshot([]); ready.accountContinuity = { status: 'ready' };
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: ready });
  for (let i = 0; i < 3; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value });
  assert.equal(f.getSends(), 2);
});

test('disk deterioration and a concrete confirmation plan update the original message', async () => {
  const f = fixture(), value = snapshot([{ ...disk, id: '/data', severity: 'warning', usedPercent: 86, availableBytes: 100 * 1024 ** 3 }]);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value }); assert.equal(f.getSends(), 1);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value }); assert.equal(f.getSends(), 1);
  Object.assign(value.attention[0], { severity: 'critical', usedPercent: 98, availableBytes: 12 * 1024 ** 3 });
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value }); assert.equal(f.getSends(), 1); assert.equal(f.getUpdates(), 1);
  const plan = { risk: 'high', requiresConfirmation: true, summary: 'Migrate finished archive', target: 'owned/archive',
    impact: 'brief read interruption', rollback: 'restore original pointer', verification: 'hash and original-path read' };
  const config = { recoveryIncidents: [{ kind: 'disk', id: '/data', status: 'awaiting_confirmation', plan }] };
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value }); assert.equal(f.getSends(), 1); assert.equal(f.getUpdates(), 2);
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value }); assert.equal(f.getSends(), 1); assert.equal(f.getUpdates(), 2);
  const message = renderMonitoringAlert(value.attention, config);
  assert.match(message, /确认前不执行/); assert.match(message, /owned\/archive/); assert.match(message, /hash and original-path read/);
});

test('blocked/running/blocked, small metric changes and observer restarts cannot create another alert', async () => {
  const f = fixture(), value = snapshot([{ ...disk, id: '/data' }]);
  for (const status of ['blocked', 'running', 'blocked']) {
    const config = { recoveryIncidents: [{ kind: 'disk', id: '/data', status, reason: `Internal state ${status}` }] };
    await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value });
    value.attention[0].availableBytes -= 1024;
    await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value });
  }
  assert.equal(f.getSends(), 1); assert.equal(f.getUpdates(), 2);
});

test('editing one subject preserves the other batch members, including independently recovered members', async () => {
  const f = fixture(), value = snapshot([{ ...disk, id: '/data' }, { kind: 'service', id: 'app', subject: 'App', severity: 'critical' }]);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value });
  value.attention = [value.attention[0]]; value.services = [{ unit: 'app', status: 'healthy' }];
  let edited;
  const config = { recoveryIncidents: [{ kind: 'disk', id: '/data', status: 'running' }] };
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value, update: async (events, _config, id) => { edited = events; return id; } });
  assert.equal(edited.length, 2); assert.equal(edited.find(e => e.id === 'app').recovered, true);
  assert.equal(edited.find(e => e.id === '/data').recovery.status, 'running'); assert.equal(f.getSends(), 1);
});

test('a recalled message or uncertain edit freezes delivery instead of falling back to another send', async () => {
  const f = fixture(), value = snapshot([{ ...disk, id: '/data' }]);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value });
  const config = { recoveryIncidents: [{ kind: 'disk', id: '/data', status: 'running' }] };
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value, update: async () => { throw new Error('lost update acknowledgement'); } });
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value });
  assert.equal(f.getSends(), 1); assert.equal(Object.values(f.getState().incidents)[0].status, 'needs_review');
});

test('muted observer still samples and reconciles recovery, but neither sends nor edits', async () => {
  const f = fixture(), value = snapshot([{ ...disk, id: '/data' }]);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value });
  let recoveries = 0;
  const result = await runMonitoringAlerts({ config: { alertDelivery: { enabled: false }, recovery: { enabled: true } },
    reader: async () => value, recover: async () => { recoveries++; return { incidents: [{ kind: 'disk', id: '/data', status: 'running' }] }; },
    dispatch: args => dispatchMonitoringAlerts({ ...f.options, ...args }) });
  assert.equal(result.muted, true); assert.equal(recoveries, 1); assert.equal(f.getSends(), 1); assert.equal(f.getUpdates(), 0);
  await dispatchMonitoringAlerts({ ...f.options, config: { recoveryIncidents: result.recovery.incidents }, snapshot: value });
  assert.equal(f.getSends(), 1); assert.equal(f.getUpdates(), 1);
});

test('known baselined risk remains silent until a real escalation or a new complete decision', async () => {
  const f = fixture(), value = snapshot([{ ...disk, id: '/data', usedPercent: 98, availableBytes: 12 * 1024 ** 3 }]);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value, baseline: true });
  for (const status of ['running', 'blocked']) await dispatchMonitoringAlerts({ ...f.options, snapshot: value,
    config: { recoveryIncidents: [{ kind: 'disk', id: '/data', status }] } });
  assert.equal(f.getSends(), 0);
  value.attention[0].availableBytes = 4 * 1024 ** 3;
  await dispatchMonitoringAlerts({ ...f.options, snapshot: value }); assert.equal(f.getSends(), 1);
});

test('card shows real results and red decisions, hides prior-attempt results while running and escapes mentions', () => {
  const events = [{ ...disk, id: '/data' }], config = { overviewUrl: 'https://example.test/?tab=tasks',
    recoveryIncidents: [{ kind: 'disk', id: '/data', status: 'awaiting_confirmation', sessionId: 'original', summary: 'Cleared 44 MiB; risk remains <at id=all>all</at>',
      plan: { requiresConfirmation: true, summary: 'Expand after approval', target: 'disk1', impact: 'cost', rollback: 'cannot shrink', verification: 'df' } }] };
  const card = renderMonitoringAlertCard(events, config), content = card.elements[0].text.content;
  assert.match(content, /Cleared 44 MiB/); assert.match(content, /<font color="red">需要确认/);
  assert.match(content, /session=original/); assert.doesNotMatch(content, /<at|低风险处理自行完成/);
  config.recoveryIncidents[0].status = 'running'; delete config.recoveryIncidents[0].plan;
  assert.doesNotMatch(renderMonitoringAlert(events, config), /Cleared 44 MiB/);
});

test('transport edits the same card, supports existing rich-text alerts, and refuses recalled/cross-chat messages', async () => {
  for (const type of ['interactive', 'post']) {
    const calls = [], config = { chatId: 'oc_expected' };
    const api = async (_config, method, path, body) => { calls.push({ method, path, body });
      return method === 'GET' ? { items: [{ message_id: 'om_original', chat_id: config.chatId, msg_type: type }] } : {}; };
    assert.equal(await updateMonitoringAlert([disk], config, 'om_original', api), 'om_original');
    assert.deepEqual(calls.map(c => c.method), ['GET', type === 'interactive' ? 'PATCH' : 'PUT']);
    assert.ok(calls.every(c => c.path.endsWith('/om_original')));
  }
  for (const message of [{ deleted: true }, { chat_id: 'oc_other' }]) {
    let writes = 0;
    await assert.rejects(updateMonitoringAlert([disk], { chatId: 'oc_expected' }, 'om_original', async (_c, method) => {
      if (method !== 'GET') writes++; return { items: [{ message_id: 'om_original', ...message }] };
    }));
    assert.equal(writes, 0);
  }
});

test('a recovery observed while muted updates the old message even if a new incident starts before unmuting', async () => {
  const f = fixture(), failed = snapshot([{ ...disk, id: '/data' }]);
  await dispatchMonitoringAlerts({ ...f.options, snapshot: failed });
  const good = snapshot([]); good.disks = [{ path: '/data', status: 'healthy' }];
  await dispatchMonitoringAlerts({ ...f.options, config: { enabled: false }, snapshot: good });
  await dispatchMonitoringAlerts({ ...f.options, config: { enabled: false }, snapshot: failed });
  let oldEvents;
  await dispatchMonitoringAlerts({ ...f.options, snapshot: failed, update: async (events, _config, id) => { oldEvents = events; return id; } });
  assert.equal(oldEvents[0].recovered, true); assert.equal(f.getSends(), 2);
});

test('baseline records the existing confirmation plan without admitting repair or later replaying it as new', async () => {
  const f = fixture(), value = snapshot([{ ...disk, id: '/data' }]);
  value.recovery = [{ kind: 'disk', id: '/data', status: 'awaiting_confirmation', plan: {
    risk: 'high', requiresConfirmation: true, summary: 'Known expansion', target: '/data', impact: 'cost', rollback: 'cannot shrink', verification: 'df',
  } }];
  await runMonitoringAlerts({ baseline: true, config: { alertDelivery: {}, recovery: { enabled: true } }, reader: async () => value,
    recover: async () => { throw new Error('baseline must not start a repair'); },
    dispatch: args => dispatchMonitoringAlerts({ ...f.options, ...args }) });
  await dispatchMonitoringAlerts({ ...f.options, config: { recoveryIncidents: value.recovery }, snapshot: value });
  assert.equal(f.getSends(), 0);
});

test('inode-only critical pressure remains visible and an actual account switch updates its existing alert', async () => {
  assert.match(renderMonitoringAlert([{ ...disk, usedPercent: 40, availableBytes: 100 * 1024 ** 3, inodeUsedPercent: 99.9 }], {}), /inode 已用 99.9%/);
  const f = fixture(), config = { accountAlerts: { enabled: true } };
  const value = snapshot([{ kind: 'accountContinuity', id: 'local-codex', severity: 'warning', subject: 'Account' }]);
  value.accountContinuity = { status: 'no_backup', backupCount: 0, autoSwitch: true, current: { id: 'a' }, lastSwitch: null };
  for (let i = 0; i < 3; i++) await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value });
  value.accountContinuity.current.id = 'b'; value.accountContinuity.lastSwitch = { at: '2026-10-03T07:00:00Z' };
  await dispatchMonitoringAlerts({ ...f.options, config, snapshot: value });
  assert.equal(f.getSends(), 1); assert.equal(f.getUpdates(), 1);
});
