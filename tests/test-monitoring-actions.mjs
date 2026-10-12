import test from 'node:test';
import assert from 'node:assert/strict';
import { accountContinuity, continuityAttention, recoveryPlan } from '../lib/monitoring-actions.mjs';
import { analyzeResources } from '../chat/monitoring.mjs';
const now = Date.parse('2026-10-12T12:00:00Z');
const account = (id, balance, age = 0) => ({ id, identityId: id, label: id, account: { type: 'chatgpt' },
  usage: { status: 'ready', checkedAt: new Date(now - age).toISOString(),
    buckets: [{ id: 'codex', primary: { remainingPercent: balance, resetsAt: new Date(now + 86400000).toISOString() } }] } });
const runtime = accounts => ({ activeId: 'a', autoSwitch: true, accounts });
test('normal depleted backups do not alert; readiness uses only fresh authorized local identities', () => {
  const x = runtime([account('a', 38), account('b', 0), account('c', 7)]);
  let state = accountContinuity(x, now);
  assert.equal(state.status, 'preparing'); assert.equal(state.backupCount, 0); assert.deepEqual(continuityAttention(state), []);
  x.accounts[0] = account('a', 20); state = accountContinuity(x, now);
  assert.equal(state.status, 'no_backup'); assert.equal(continuityAttention(state)[0].action.requiresConfirmation, true);
  x.accounts.push(account('b', 80, 61000)); assert.equal(accountContinuity(x, now).backupCount, 0);
  x.accounts.at(-1).usage.checkedAt = new Date(now).toISOString(); x.accounts.at(-1).identityId = 'a';
  assert.equal(accountContinuity(x, now).backupCount, 0);
  x.accounts.at(-1).identityId = 'b'; assert.equal(accountContinuity(x, now).status, 'ready');
  x.accounts[0] = account('a', 10); assert.equal(accountContinuity(x, now).status, 'switch_pending');
});
test('unknown account readings and disabled switching are distinct from exhaustion', () => {
  const x = runtime([account('a', 0, 61000), account('b', 80)]);
  assert.equal(accountContinuity(x, now).status, 'unknown');
  x.accounts[0] = account('a', 20); x.autoSwitch = false;
  assert.equal(accountContinuity(x, now).status, 'switch_disabled');
});
test('fleet depletion does not become actionable risk without local continuity evidence', () => {
  const result = analyzeResources({ accounts: [{ status: 'exhausted', active: false, label: 'Remote' }],
    disks: [], automations: { items: [] }, services: [] });
  assert.deepEqual(result.attention, []);
});
test('confirmation requires concrete action scope, impact, rollback and validation', () => {
  assert.equal(recoveryPlan({ risk: 'high', summary: 'Ask somebody' }), null);
  const p = recoveryPlan({ risk: 'medium', summary: 'Move ended archive', target: '/owned/archive', impact: 'read interruption', rollback: 'old pointer', verification: 'hash' });
  assert.equal(p.requiresConfirmation, true);
});

import { monitoringDisposition, monitoringDiagnosticReport } from '../lib/monitoring-policy.mjs';
import { monitoringNextStep } from '../chat/monitoring-alert-message.mjs';
test('metric guidance never claims execution and separates help from approval', () => {
  const config = { overviewUrl: 'https://example.test/' };
  for (const kind of ['service', 'automation', 'api']) {
    const next = monitoringNextStep({ kind }, config);
    assert.equal(next.type, 'notice'); assert.doesNotMatch(next.summary, /我在处理|我这边继续核查/);
  }
  assert.equal(monitoringDisposition({ kind: 'api', code: 99991403 }).type, 'input');
  assert.equal(monitoringDisposition({ kind: 'api', code: 99991403, notificationAvailable: true }).type, 'notice');
  const item = { kind: 'service', recovery: { status: 'running', sessionId: 's' } };
  assert.match(monitoringNextStep(item, config).summary, /我在处理/);
  item.recovery = { status: 'awaiting_confirmation', sessionId: 's', plan: { requiresConfirmation: true, summary: 'Restart scoped service' } };
  assert.equal(monitoringNextStep(item, config).type, 'approval');
});
test('fixed diagnosis preserves unknown and paused resources, scopes IDs and excludes task prompts', () => {
  const snapshot = { generatedAt: 'now', services: [{ unit: 'a.service', status: 'paused' }, { unit: 'b.service', status: 'unknown' }],
    automations: { items: [{ id: 'task', prompt: 'PRIVATE', state: 'paused' }] },
    coverage: { gaps: [{ source: 'accounts' }] }, attention: [], recovery: [] };
  const report = monitoringDiagnosticReport(snapshot);
  assert.equal(report.mode, 'read_only'); assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.deepEqual(report.resources.slice(0, 2).map(r => r.status), ['paused', 'unknown']);
  assert.deepEqual(monitoringDiagnosticReport(snapshot, { kind: 'service', id: 'a.service' }).resources.map(r => r.id), ['a.service']);
  assert.deepEqual(report.coverage, snapshot.coverage);
});

test('diagnosis CLI emits parseable JSON without starting recovery or accepting mutation flags', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const { stdout } = await exec(process.execPath, ['scripts/monitoring-diagnose.mjs', '--kind', 'service'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'read_only');
  assert.ok(report.resources.every(item => item.kind === 'service'));
  await assert.rejects(exec(process.execPath, ['scripts/monitoring-diagnose.mjs', '--apply']), /Unknown option/);
});
