import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFeishuApiHealth, feishuApiAttention } from '../lib/feishu-api-health.mjs';
import { dispatchMonitoringAlerts } from '../chat/monitoring-alerts.mjs';
import { readService, createMonitoringReader } from '../chat/monitoring.mjs';
import { createFeishuHttpInstance } from '../lib/feishu-http-client.mjs';

const now = Date.parse('2026-10-10T12:00:00Z');
const config = { apps: [{ appId: 'app', label: 'Bot' }], callsPer5m: 10 };
const row = (offset, code = 0, extras = {}) => ({ type: 'feishu_api_call', ts: new Date(now - offset).toISOString(),
  appId: 'app', sourceRouteId: 'bot', method: 'GET', endpoint: '/open-apis/im/v1/messages/private-id',
  code, outcome: code ? 'business_error' : 'success', durationMs: 20, ...extras });
async function logs(t, rows) {
  const directory = await mkdtemp(join(tmpdir(), 'api-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '2026-10-10.1.abcdef.0.jsonl'), rows.map(item => JSON.stringify(item)).join('\n') + '\n');
  return directory;
}

test('quota rejection survives token success, idle time, restart and log rotation; restoration is explicit', async t => {
  const directory = await logs(t, [row(3600000, 99991403), row(1000, 0, { endpoint: '/open-apis/auth/v3/tenant_access_token/internal' })]);
  const result = await readFeishuApiHealth({ directory, config, now });
  assert.equal(result.providers[0].status, 'quota_exhausted');
  assert.equal(result.tenantQuota, null);
  assert.doesNotMatch(JSON.stringify(result), /private-id/);
  await rm(join(directory, '2026-10-10.1.abcdef.0.jsonl'));
  const rotated = await readFeishuApiHealth({ directory, config, previous: result, now: now + 32 * 86400000 });
  assert.equal(rotated.providers[0].status, 'quota_exhausted');
  const restored = await readFeishuApiHealth({ directory, previous: rotated, now: now + 33 * 86400000,
    config: { ...config, quotaRestoredAt: new Date(now + 32 * 86400000).toISOString(), quotaRestorationEvidence: 'verified affected read' } });
  assert.equal(restored.providers[0].quotaRejectedAt, null);
  assert.equal(restored.providers[0].status, 'unknown', 'restoration is not evidence of fresh observations');
});

test('bursts, errors and latency use real recent calls; partial logs cannot become healthy', async t => {
  const directory = await logs(t, [...Array.from({ length: 12 }, () => row(1000)), row(86400001), row(-60000)]);
  const result = await readFeishuApiHealth({ directory, config, now });
  assert.equal(result.providers[0].calls5m, 12); assert.equal(result.providers[0].calls24h, 12);
  assert.equal(result.providers[0].burst, true); assert.equal(result.providers[0].status, 'degraded');
  assert.equal(feishuApiAttention(result)[0].kind, 'api');
  const partial = await readFeishuApiHealth({ directory, config, now, maxBytes: 1 });
  assert.equal(partial.coverage.complete, false); assert.equal(partial.providers[0].status, 'unknown');
  await writeFile(join(directory, '2026-10-10.1.abcdef.0.jsonl'), Array.from({ length: 5 }, () => JSON.stringify(row(1000, 99991400, { durationMs: 6000 }))).join('\n'));
  const failures = await readFeishuApiHealth({ directory, config, now });
  assert.equal(failures.providers[0].errors, true); assert.equal(failures.providers[0].slow, true);
});

test('only fresh administrator measurements can supply billing quota and early warnings', async t => {
  const directory = await logs(t, [row(1000)]);
  const tenantQuota = { used: 9000, limit: 10000, source: 'feishu_admin', evidence: 'admin readback', observedAt: new Date(now).toISOString() };
  const result = await readFeishuApiHealth({ directory, config: { ...config, tenantQuota }, now });
  assert.equal(result.tenantQuota.usedPercent, 90);
  assert.equal(feishuApiAttention(result)[0].id, 'feishu:tenant-quota');
  const old = await readFeishuApiHealth({ directory, config: { ...config, tenantQuota }, now: now + 86400001 });
  assert.equal(old.tenantQuota, null);
  const invented = await readFeishuApiHealth({ directory, config: { ...config, tenantQuota: { ...tenantQuota, source: 'local_logs' } }, now });
  assert.equal(invented.tenantQuota, null);
});

test('monthly failure immediately records an undelivered local alert and never calls the failed transport', async () => {
  let state = null, sends = 0;
  const health = { coverage: { complete: true }, providers: [{ id: 'feishu:app', quotaRejectedAt: new Date(now).toISOString() }] };
  const snapshot = { generatedAt: new Date(now).toISOString(), disks: [], services: [], accounts: [], automations: { items: [] },
    coverage: { gaps: [] }, apiHealth: health, attention: [{ kind: 'api', severity: 'critical', id: 'feishu:app:quota', code: 99991403, subject: 'Bot' }] };
  const options = { config: { confirmationObservations: 3 }, snapshot, now,
    load: async () => structuredClone(state), save: async (_path, value) => { state = structuredClone(value); },
    send: async () => { sends++; return 'om_test'; } };
  assert.equal((await dispatchMonitoringAlerts(options)).status, 'blocked_dependency');
  await dispatchMonitoringAlerts(options); await dispatchMonitoringAlerts(options);
  assert.equal(sends, 0); assert.equal(Object.values(state.batches).length, 1);
  assert.equal(Object.values(state.incidents)[0].observations, 3);
});

test('transient API trouble requires confirmed observations and no traffic does not rearm it', async () => {
  let state = null, sends = 0;
  const snapshot = { disks: [], services: [], accounts: [], automations: { items: [] }, coverage: { gaps: [] },
    apiHealth: { coverage: { complete: true }, providers: [{ id: 'feishu:app', status: 'degraded' }] },
    attention: [{ kind: 'api', severity: 'critical', id: 'feishu:app:traffic', subject: 'Bot' }] };
  const options = { config: { confirmationObservations: 3 }, snapshot,
    load: async () => structuredClone(state), save: async (_path, value) => { state = structuredClone(value); },
    send: async () => { sends++; return 'om_test'; } };
  await dispatchMonitoringAlerts(options); await dispatchMonitoringAlerts(options); assert.equal(sends, 0);
  await dispatchMonitoringAlerts(options); assert.equal(sends, 1);
  await dispatchMonitoringAlerts({ ...options, snapshot: { ...snapshot, attention: [], apiHealth: { ...snapshot.apiHealth, providers: [{ id: 'feishu:app', status: 'unknown' }] } } });
  await dispatchMonitoringAlerts(options); assert.equal(sends, 1);
});

test('only an explicit inactive maintenance hold suppresses service faults', async () => {
  const item = { unit: 'test.service', scope: 'system', maintenance: { reason: 'operator pause', source: 'original request' } };
  const observe = active => readService(item, async () => ({ stdout: `LoadState=loaded\nType=simple\nActiveState=${active}\nResult=success\n` }));
  assert.equal((await observe('inactive')).status, 'paused');
  assert.equal((await observe('failed')).status, 'failed');
  assert.equal((await observe('active')).status, 'healthy');
  assert.equal((await readService({ unit: item.unit, scope: item.scope }, async () => ({ stdout: 'LoadState=loaded\nType=simple\nActiveState=inactive\nResult=success\n' }))).status, 'failed');
});

test('overview exposes provider and alert delivery gaps without making provider calls', async () => {
  const reader = createMonitoringReader({ now: () => now, read: async () => JSON.stringify({ feishuApi: { enabled: true }, alertDelivery: {} }),
    getRecord: async path => path.endsWith('monitoring-alerts.json') ? { batches: { a: { status: 'needs_review' } } } : null,
    getApiHealth: async () => ({ providers: [], coverage: { complete: false } }), getUsage: async () => null,
    getAccounts: async () => null, getTasks: async () => [], getFs: async () => ({ blocks: 100, bsize: 1e9, bfree: 80, bavail: 80, files: 1, ffree: 1 }),
    getStat: async () => ({ dev: 1 }) });
  const value = await reader();
  assert.equal(value.alertDelivery.uncertain, 1);
  assert.ok(value.coverage.gaps.some(gap => gap.source === 'feishuApi'));
  assert.ok(value.attention.some(item => item.kind === 'alertDelivery'));
});

test('configured service additions beyond twenty are observed instead of silently dropped', async () => {
  const services = Array.from({ length: 25 }, (_value, index) => ({ unit: `app${index}.service`, scope: 'system' }));
  const reader = createMonitoringReader({ read: async () => JSON.stringify({ services }), getUsage: async () => null,
    getAccounts: async () => null, getTasks: async () => [], getService: async item => ({ ...item, status: 'healthy' }),
    getFs: async () => ({ blocks: 100, bsize: 1e9, bfree: 80, bavail: 80, files: 1, ffree: 1 }), getStat: async () => ({ dev: 1 }) });
  assert.equal((await reader()).services.length, 25);
});

test('component/hour accounting and unchanged reads expose design clues without retaining digests in the overview', async t => {
  const directory = await logs(t, Array.from({ length: 20 }, () => row(1000, 0, { component: 'display', pid: 1,
    readFingerprint: 'a'.repeat(64), dataFingerprint: 'b'.repeat(64) })));
  const value = await readFeishuApiHealth({ directory, config: { ...config, callsPer5m: 100, tenantQuotaLimit: 1000000 }, now });
  const provider = value.providers[0];
  assert.equal(provider.components[0].calls, 20); assert.equal(provider.hours[0].calls, 20);
  assert.equal(provider.duplicateReads[0].calls, 20); assert.equal(provider.comparedReads5m, 20);
  assert.equal(feishuApiAttention(value)[0].severity, 'warning');
  assert.doesNotMatch(JSON.stringify(value), /aaaaaaaa|bbbbbbbb/);
  assert.equal(value.tenantQuotaLimit, 1000000); assert.equal(value.tenantQuota, null);
});

test('successful read digests distinguish parameters and data, exclude tokens/writes, and change after restart', async () => {
  const records = [];
  const audit = { logger: { record: value => { records.push(value); } } };
  let response = { code: 0, data: { secretText: 'never-in-ledger' } };
  const transport = { request: async () => response };
  const client = createFeishuHttpInstance(transport, 1000, audit);
  await client.get('/open-apis/im/v1/messages/private-id', { params: { page_token: 'private-page' } });
  await client.get('/open-apis/im/v1/messages/private-id', { params: { page_token: 'private-page' } });
  assert.equal(records[0].readFingerprint, records[1].readFingerprint);
  assert.equal(records[0].dataFingerprint, records[1].dataFingerprint);
  await client.get('/open-apis/im/v1/messages/private-id', { params: { page_token: 'another-page' } });
  assert.notEqual(records[0].readFingerprint, records[2].readFingerprint);
  response = { code: 0, data: { secretText: 'changed' } };
  await client.get('/open-apis/im/v1/messages/private-id', { params: { page_token: 'private-page' } });
  assert.notEqual(records[0].dataFingerprint, records[3].dataFingerprint);
  await client.post('/open-apis/im/v1/messages', { private: 'write text' });
  await client.get('/open-apis/auth/v3/token');
  assert.equal(records[4].readFingerprint, undefined); assert.equal(records[5].dataFingerprint, undefined);
  const restarted = createFeishuHttpInstance(transport, 1000, audit);
  await restarted.get('/open-apis/im/v1/messages/private-id', { params: { page_token: 'private-page' } });
  assert.notEqual(records[0].readFingerprint, records[6].readFingerprint);
});


test('same affected business endpoint can prove recovery without a quota probe, even with an unrelated malformed log', async t => {
  const directory = await logs(t, [row(3600000, 99991403), row(1000)]);
  const file = join(directory, '2026-10-10.1.abcdef.0.jsonl');
  const { appendFile } = await import('node:fs/promises'); await appendFile(file, 'broken legacy record\n');
  const result = await readFeishuApiHealth({ directory, config, now });
  assert.equal(result.providers[0].quotaRejectedAt, null);
  assert.match(result.providers[0].quotaRestorationEvidence, /GET.*success/);
  assert.equal(result.coverage.complete, false); assert.equal(result.providers[0].status, 'unknown');
  assert.equal(result.tenantQuota, null);
  await rm(file);
  const restarted = await readFeishuApiHealth({ directory, config, previous: result, now: now + 1000 });
  assert.equal(restarted.providers[0].quotaRejectedAt, null);
  await writeFile(file, JSON.stringify(row(-2000, 99991403)) + '\n');
  const rejectedAgain = await readFeishuApiHealth({ directory, config, previous: restarted, now: now + 3000 });
  assert.equal(rejectedAgain.providers[0].status, 'quota_exhausted');
});

test('success from another app or another business endpoint cannot clear an affected endpoint rejection', async t => {
  const directory = await logs(t, [row(3600000, 99991403), row(1000, 0, { appId: 'other' }),
    row(1000, 0, { endpoint: '/open-apis/im/v1/chats/another-id' })]);
  const result = await readFeishuApiHealth({ directory, config, now });
  assert.equal(result.providers.find(p => p.appId === 'app').status, 'quota_exhausted');
});

test('a calendar restriction does not disable a proven message transport or infer billing recovery', async t => {
  const directory = await logs(t, [row(3600000, 99991403, { endpoint: '/open-apis/calendar/v4/calendars/primary' }),
    row(1000, 0, { method: 'POST', endpoint: '/open-apis/im/v1/messages/private-id/reply' })]);
  const health = await readFeishuApiHealth({ directory, config, now });
  const p = health.providers[0];
  assert.ok(p.quotaRejectedAt); assert.equal(p.notificationDelivery.status, 'available');
  assert.equal(health.tenantQuota, null); assert.equal(feishuApiAttention(health)[0].severity, 'warning');
  const snapshot = { disks: [], services: [], accounts: [], automations: { items: [] }, coverage: { gaps: [] },
    apiHealth: health, attention: [{ kind: 'disk', id: '/data', subject: 'Data', severity: 'critical', availableBytes: 1, usedPercent: 99 }] };
  let state = null, sends = 0;
  const options = { config: { feishuAppId: 'app' }, snapshot, now,
    load: async () => structuredClone(state), save: async (_p, v) => { state = structuredClone(v); },
    send: async () => { sends++; return 'om_delivered'; } };
  const blockedHealth = { ...health, providers: [{ ...p, notificationDelivery: { status: 'unknown' } }] };
  await dispatchMonitoringAlerts({ ...options, snapshot: { ...snapshot, apiHealth: blockedHealth } }); assert.equal(sends, 0);
  health.coverage.complete = false;
  await dispatchMonitoringAlerts(options); assert.equal(sends, 1);
  await dispatchMonitoringAlerts(options); assert.equal(sends, 1);
  assert.equal(Object.values(state.batches).filter(b => b.status === 'blocked_dependency').length, 0);
  const file = join(directory, '2026-10-10.1.abcdef.0.jsonl');
  await rm(file);
  const quiet = await readFeishuApiHealth({ directory, config, previous: health, now: now + 3600000 });
  assert.equal(quiet.providers[0].notificationDelivery.status, 'available', 'idle time and log rotation retain the verified transport receipt');
  state = null;
  await dispatchMonitoringAlerts({ ...options, now: now + 3600000, snapshot: { ...snapshot, apiHealth: quiet } });
  assert.equal(sends, 2, 'the actual dispatch gate accepts retained recovery after a quiet hour');
  await writeFile(file, JSON.stringify(row(-3599000, 99991403, { method: 'POST', endpoint: '/open-apis/im/v1/messages' })) + '\n');
  const rejected = await readFeishuApiHealth({ directory, config, previous: quiet, now: now + 3600000 });
  assert.equal(rejected.providers[0].notificationDelivery.status, 'unknown', 'a newer quota rejection invalidates the transport receipt');
  state = null;
  await dispatchMonitoringAlerts({ ...options, now: now + 3600000, snapshot: { ...snapshot, apiHealth: rejected } });
  assert.equal(sends, 2, 'a newer rejection blocks delivery until recovery is verified again');
});

test('high successful traffic is an optimization signal, not an outage; failures and slowness stay actionable', () => {
  const provider = { id: 'feishu:test', status: 'degraded', burst: true, errors: false, slow: false };
  assert.equal(feishuApiAttention({ providers: [provider] })[0].severity, 'warning');
  for (const signal of ['errors', 'slow']) assert.equal(feishuApiAttention({ providers: [{ ...provider, [signal]: true }] })[0].severity, 'critical');
});
