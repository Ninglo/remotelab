import './isolate-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { dispatchMonitoringAlerts, renderMonitoringAlert } from '../chat/monitoring-alerts.mjs';
import { mergeServiceCycles, serviceIncidentAttention } from '../chat/service-incidents.mjs';
import { observePersistentAlert } from '../lib/alert-notification-policy.mjs';
import { metricAlertBundles, metricBundleCard } from '../lib/metric-alert-bundle.mjs';

const start = Date.parse('2026-10-31T01:00:00Z');
const disk = { kind: 'disk', id: '/', subject: 'Disk', severity: 'critical', availableBytes: 1024 ** 3, usedPercent: 99 };
let serial = 0;
function fixture() {
  let state;
  const sends = [], edits = [];
  const options = { config: {}, stateFile: join(CONFIG_DIR, `alerts-${serial++}.json`),
    load: async () => structuredClone(state), save: async (_, value) => { state = structuredClone(value); },
    send: async events => { sends.push(structuredClone(events)); return `om_${sends.length}`; },
    update: async (events, _, id) => { edits.push({ events: structuredClone(events), id }); return id; } };
  const run = (minutes, attention = [disk], extra = {}, overrides = {}) => dispatchMonitoringAlerts({ ...options,
    now: start + minutes * 60_000, snapshot: { generatedAt: new Date(start + minutes * 60_000).toISOString(), attention,
      disks: [], services: [], accounts: [], automations: { items: [] }, coverage: { gaps: [] }, ...extra }, ...overrides });
  return { options, run, sends, edits, state: () => state };
}

test('10-minute persistence edits once; follow-up, severity and recovery retain the original card', async () => {
  const f = fixture();
  await f.run(0); await f.run(9.99);
  assert.equal(f.sends.length, 1); assert.equal(f.edits.length, 0);
  await f.run(10);
  assert.equal(f.sends.length, 1); assert.equal(f.edits.length, 1);
  assert.match(renderMonitoringAlert(f.edits[0].events, {}), /连续10分钟未见改善/);
  await f.run(11); assert.equal(f.edits.length, 1);
  await f.run(12, [disk], {}, { config: { recoveryIncidents: [{ kind: 'disk', id: '/', status: 'running', runId: 'repair' }] } });
  await f.run(14, [{ ...disk, severity: 'warning' }]);
  await f.run(15, [], { disks: [{ path: '/', status: 'healthy' }] });
  await f.run(16);
  assert.equal(f.sends.length, 1);
  assert.ok(f.edits.every(e => e.id === 'om_1'));
  const latest = f.edits.at(-1).events[0];
  assert.ok(latest.history.some(e => e.label === '复查确认恢复'));
  assert.ok(latest.history.some(e => e.label === '三小时内再次预警'));
  assert.equal(latest.persistentWarningAt, null);
});

test('three hours is anchored to first send; no rolling postponement or periodic resend of an open problem', async () => {
  const f = fixture();
  await f.run(0);
  await f.run(1, [], { disks: [{ path: '/', status: 'healthy' }] });
  await f.run(179.99); assert.equal(f.sends.length, 1);
  await f.run(180, [], { disks: [{ path: '/', status: 'healthy' }] });
  await f.run(180.01); assert.equal(f.sends.length, 2);
  await f.run(400); assert.equal(f.sends.length, 2);
});

test('a final repair receipt arriving after recovery updates the same card and preserves attribution evidence', async () => {
  const f = fixture(); await f.run(0);
  const healthy = { disks: [{ path: '/', status: 'healthy' }] };
  await f.run(1, [], healthy);
  const repair = { kind: 'disk', id: '/', status: 'resolved', summary: '清理完成并复查',
    resolution: { method: 'agent', evidence: ['verified-repair'] } };
  await f.run(2, [], healthy, { config: { recoveryIncidents: [repair] } });
  assert.equal(f.sends.length, 1);
  assert.equal(f.edits.at(-1).id, 'om_1');
  assert.match(renderMonitoringAlert(f.edits.at(-1).events, {}), /Agent 已自行处理/);
  assert.ok(f.edits.at(-1).events[0].history.some(e => e.label === '处理跟进'));
});

test('an improvement restarts persistence; stale or missing observations never escalate', async () => {
  const f = fixture();
  await f.run(0);
  await f.run(9, [{ ...disk, availableBytes: 2 * 1024 ** 3 }]);
  await f.run(10, [{ ...disk, availableBytes: 2 * 1024 ** 3 }]);
  assert.equal(f.edits.length, 0);
  await f.run(19, [{ ...disk, availableBytes: 2 * 1024 ** 3 }], { generatedAt: new Date(start).toISOString() });
  assert.equal(f.edits.length, 0);
  await f.run(20, [], { disks: [{ path: '/', status: 'unknown' }] });
  assert.equal(f.edits.length, 0);
  await f.run(21, [{ ...disk, availableBytes: 2 * 1024 ** 3 }]);
  assert.match(renderMonitoringAlert(f.edits.at(-1).events, {}), /连续10分钟/);
});

test('uncertain sends and failed updates never fall back to another card, including after recovery', async () => {
  const f = fixture();
  await f.run(0, [disk], {}, { send: async () => { throw new Error('unknown'); } });
  await f.run(1, [], { disks: [{ path: '/', status: 'healthy' }] });
  await f.run(2); assert.equal(f.sends.length, 0);
  const g = fixture(); await g.run(0);
  await g.run(10, [disk], {}, { update: async () => { throw new Error('unknown'); } });
  await g.run(11); await g.run(12, [], { disks: [{ path: '/', status: 'healthy' }] }); await g.run(13);
  assert.equal(g.sends.length, 1);
});

test('concurrent dispatchers share a durable lease and cannot both send', async () => {
  const f = fixture();
  let release, entered;
  const ready = new Promise(r => { entered = r; });
  const hold = new Promise(r => { release = r; });
  const first = f.run(0, [disk], {}, { send: async () => { entered(); await hold; return 'om_one'; } });
  await ready;
  assert.equal((await f.run(0)).skipped, 'busy');
  release(); await first;
  await f.run(1); assert.equal(f.sends.length, 0);
});

const crash = (n, minute = n / 5) => ({ id: `crash_${n}`, unit: 'bot.service',
  at: new Date(start + minute * 60_000).toISOString(), reason: 'javascript_heap_oom', evidence: [{ message: 'OOM' }] });
const services = [{ unit: 'bot.service', label: 'Bot', status: 'healthy', lastRunAt: new Date(start).toISOString() }];

test('500 crashes across bounded journal windows keep one cycle and one card; stability closes it', async () => {
  const f = fixture(); let cycles = [];
  for (const n of [1, 50, 150, 256, 400, 500]) {
    const raw = Array.from({ length: Math.min(n, 256) }, (_, i) => crash(n - Math.min(n, 256) + i));
    cycles = mergeServiceCycles(cycles, raw);
    // Feed every intervening sample when the retained journal window advances.
    assert.equal(cycles.length, 1);
    await f.run(n / 5, serviceIncidentAttention(cycles, services, { now: start + n / 5 * 60_000 }), { services });
  }
  assert.equal(cycles[0].count, 500);
  assert.equal(cycles[0].id, 'crash_0');
  assert.equal(f.sends.length, 1);
  assert.equal(f.edits.at(-1).events.length, 1);
  const recovered = serviceIncidentAttention(cycles, services, { now: start + 131 * 60_000 });
  assert.equal(recovered[0].recovered, true);
  await f.run(131, recovered, { services });
  assert.equal(f.edits.at(-1).events[0].recovered, true);
  assert.match(renderMonitoringAlert(f.edits.at(-1).events, {}), /根因修复待确认/);
  const gap = serviceIncidentAttention(cycles, services, { now: start + 131 * 60_000, gaps: [{ source: 'serviceJournal:bot.service' }] });
  assert.equal(gap[0].recovered, false);
  cycles = mergeServiceCycles(cycles, [crash(501, 140)]);
  await f.run(140, serviceIncidentAttention(cycles, services, { now: start + 140 * 60_000 }), { services });
  assert.equal(f.sends.length, 1);
  assert.equal(f.edits.at(-1).events.length, 1, 'a new cycle inside three hours replaces the summary, preserving history');
});

test('legacy per-invocation cards migrate to the first receipt without replaying pending crashes', async () => {
  const f = fixture();
  const legacy = n => ({ kind: 'serviceCrash', id: `crash_${n}`, unit: 'bot.service', subject: 'Bot', severity: 'critical', signals: { reason: 'javascript_heap_oom' } });
  await f.run(0, [legacy(0)]);
  await f.run(1, [legacy(1)]); // legacy identity is already protected at dispatch
  const cycles = mergeServiceCycles([], [crash(0), crash(1), crash(2)]);
  await f.run(2, serviceIncidentAttention(cycles, services, { now: start + 2 * 60_000 }), { services });
  assert.equal(f.sends.length, 1);
  assert.equal(f.edits.at(-1).events.length, 1);
  assert.equal(f.edits.at(-1).events[0].crashCount, 3);
});

test('private metric persistence is visible in the existing three-hour bundle', () => {
  const config = { profile: 'bot', openId: 'ou_test', feishuAppId: 'cli_test' };
  const item = { id: 'metric1', kind: 'metric', metric: 'context', key: 'context', status: 'needs_review',
    createdAt: new Date(start).toISOString(), notification: { ready: true }, ratio: 2 };
  const state = { incidents: { metric1: item } };
  const first = metricAlertBundles(state, config, start)[0]; first.delivery = { messageId: 'om_private' };
  observePersistentAlert(item, item, { now: start + 10 * 60_000, since: item.createdAt });
  const next = metricAlertBundles(state, config, start + 10 * 60_000)[0];
  assert.equal(next.delivery.messageId, 'om_private');
  assert.match(JSON.stringify(metricBundleCard(next, config)), /连续10分钟未见改善/);
});
