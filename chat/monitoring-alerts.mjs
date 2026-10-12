import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { createMonitoringReader } from './monitoring.mjs';
import { processMonitoringRecovery } from './monitoring-recovery.mjs';
import { diskRiskStage } from '../lib/monitoring-actions.mjs';

const hash = value => createHash('sha256').update(value).digest('base64url');
const errorCode = error => error.code || 'DELIVERY_UNCERTAIN';
import { sendMonitoringAlert, updateMonitoringAlert } from './monitoring-alert-message.mjs';
export { renderMonitoringAlert, renderMonitoringAlertCard, sendMonitoringAlert, updateMonitoringAlert } from './monitoring-alert-message.mjs';

function accountAlerts(snapshot, config) {
  if (config.accountAlerts?.enabled !== true) return [];
  return snapshot.attention.filter(item => item.kind === 'accountContinuity')
    .map(item => ({ ...item, continuity: snapshot.accountContinuity }));
}

export async function dispatchMonitoringAlerts({ config, snapshot, stateFile = join(CONFIG_DIR, 'monitoring-alerts.json'),
  send = sendMonitoringAlert, update = updateMonitoringAlert, load = readRecord, save = writeDurableJson, now = Date.now(), baseline = false, dryRun = false }) {
  const state = await load(stateFile) || { version: 1, incidents: {}, batches: {} };
  const transportQuotaBlocked = snapshot.apiHealth?.providers?.some(provider => provider.quotaRejectedAt
    && !(provider.notificationDelivery?.status === 'available'
      && provider.notificationDelivery.evidence
      && Date.parse(provider.notificationDelivery.observedAt) > Date.parse(provider.quotaRejectedAt)
      && Date.parse(provider.notificationDelivery.observedAt) <= now + 5000)
    && (!config.feishuAppId || provider.appId === config.feishuAppId));
  for (const batch of Object.values(state.batches)) if (['sending', 'updating'].includes(batch.status)) {
    batch.status = 'needs_review';
    for (const key of batch.keys) if (state.incidents[key]) state.incidents[key].status = 'needs_review';
  }
  const current = new Set(), recovered = new Set(), due = [], edits = new Set();
  // Retire old per-account exhaustion alerts as normal lifecycle records.
  // Keep receipts/batches; never replay an uncertain send during this change.
  for (const incident of Object.values(state.incidents)) if (['account', 'quota'].includes(incident.kind)) {
    incident.active = false; incident.retiredReason = '由本实例账号连续性监管替代，单个账号耗尽不作为故障';
  }
  if (['ready', 'preparing'].includes(snapshot.accountContinuity?.status)) recovered.add(hash('accountContinuity:local-codex'));
  // Absence after a source change, an unreadable source and an unfinished Run
  // are not recovery. Rearm only an explicitly observed healthy or stopped item.
  for (const item of snapshot.disks) if (item.status === 'healthy') recovered.add(hash(`disk:${item.path || item.label}`));
  for (const item of snapshot.services) if (item.status === 'healthy') recovered.add(hash(`service:${item.unit || item.label}`));
  for (const account of snapshot.accounts || []) {
    if (['available', 'exhausted'].includes(account.status)) recovered.add(hash(`account:${account.id}`));
    if (account.status === 'available') recovered.add(hash(`quota:${account.id}`));
  }
  for (const provider of snapshot.apiHealth?.providers || []) {
    if (!provider.quotaRejectedAt && (snapshot.apiHealth.coverage.complete || provider.quotaRestorationEvidence)) recovered.add(hash(`api:${provider.id}:quota`));
    if (provider.status === 'observed') recovered.add(hash(`api:${provider.id}:traffic`));
  }
  if (snapshot.apiHealth?.tenantQuota?.usedPercent < 80) recovered.add(hash('api:feishu:tenant-quota'));
  if (!snapshot.coverage.gaps.some(gap => gap.source === 'automations')) {
    for (const item of snapshot.automations.items || []) {
      const stopped = ['paused', 'cancelled', 'completed'].includes(item.state);
      const succeeded = item.lastExecution?.state === 'completed';
      const checked = !item.lastExecution && item.check?.at && item.check.reason && item.check.reason !== 'gate_error';
      const repaired = item.lastExecution?.runId && snapshot.recovery?.some(record => record.kind === 'automation'
        && record.id === item.id && record.originRunId === item.lastExecution.runId && record.status === 'resolved');
      if (stopped || !item.lastError && (succeeded || checked || repaired)) recovered.add(hash(`automation:${item.id}`));
    }
  }
  for (const item of [...snapshot.attention.filter(item => ['disk', 'service', 'automation', 'api'].includes(item.kind)
    && !(item.kind === 'service' && (config.ignoreUnits || []).includes(item.id))), ...accountAlerts(snapshot, config)]) {
    const key = hash(`${item.kind}:${item.id || item.subject}`); current.add(key);
    const previous = state.incidents[key];
    // A local optimization signal must not pre-confirm a new outage.
    const count = previous?.active && previous.event?.severity === item.severity ? previous.observations + 1 : 1;
    const eligible = item.severity === 'critical' || item.kind === 'api' && item.id === 'feishu:tenant-quota' || ['disk', 'accountContinuity'].includes(item.kind) || item.kind === 'automation'
      && (config.criticalAutomationIds || []).includes(item.id);
    const configuredCount = Number(config.confirmationObservations);
    const confirmationCount = Number.isInteger(configuredCount) && configuredCount >= 1 && configuredCount <= 10 ? configuredCount : 1;
    const requiredCount = item.kind === 'disk' || item.kind === 'api' && item.code === 99991403 ? 1 : item.kind === 'automation' ? 3
      : item.kind === 'accountContinuity' ? Math.max(3, confirmationCount) : confirmationCount;
    const critical = eligible && count >= requiredCount;
    const incident = !previous?.active ? { cycle: (previous?.cycle || 0) + 1, status: 'observing', observations: count, active: true } : previous;
    const repair = config.recoveryIncidents?.slice().reverse().find(r => r.kind === item.kind && r.id === item.id);
    const stage = diskRiskStage(item);
    // The incident identity survives runtime retries, plan wording and disk
    // stage changes. These update its existing message, never rearm a send.
    const version = hash(JSON.stringify({ stage, severity: item.severity, repair: repair ? {
      status: repair.status, summary: ['running', 'pending', 'admitting', 'waiting'].includes(repair.status) ? null : repair.summary,
      plan: repair.plan, humanAction: repair.humanAction, runId: repair.runId,
    } : null, signals: item.signals || null, notificationAvailable: item.notificationAvailable ?? null, action: item.action || null, continuity: item.continuity ? {
      status: item.continuity.status, backupCount: item.continuity.backupCount, autoSwitch: item.continuity.autoSwitch,
      currentId: item.continuity.current?.id, lastSwitch: item.continuity.lastSwitch,
    } : null }));
    const decisionVersion = repair?.plan?.requiresConfirmation ? hash(JSON.stringify(repair.plan)) : null;
    if (!baseline && incident.status === 'baseline' && (stage > (incident.riskStage || stage)
      || decisionVersion && incident.decisionVersion !== decisionVersion)) incident.status = 'observing';
    incident.decisionVersion = decisionVersion;
    incident.riskStage = stage;
    incident.event = { ...item, recovery: repair, observedAt: snapshot.generatedAt || new Date(now).toISOString() };
    incident.version = version;
    if (incident.status === 'sent' && incident.messageId && incident.presentedVersion !== version) edits.add(incident.messageId);
    Object.assign(incident, { observations: count, active: true, subject: item.subject, kind: item.kind });
    incident.lastCritical = critical;
    if (baseline && eligible
      && !['sent', 'needs_review'].includes(incident.status)) incident.status = 'baseline';
    if (critical && incident.status === 'observing') incident.status = 'pending';
    state.incidents[key] = incident;
    if (incident.status === 'blocked_dependency' && !transportQuotaBlocked
      && (snapshot.apiHealth?.coverage.complete || snapshot.apiHealth?.providers?.some(p => p.quotaRestorationEvidence
        && (!config.feishuAppId || p.appId === config.feishuAppId))
        || snapshot.apiHealth?.providers?.some(p => p.notificationDelivery?.status === 'available'
          && (!config.feishuAppId || p.appId === config.feishuAppId)) )) incident.status = 'pending';
    if (critical && incident.status === 'pending') due.push({ key, ...item, cycle: incident.cycle });
  }
  for (const [key, incident] of Object.entries(state.incidents)) if (!current.has(key)) incident.observations = 0;
  for (const [key, incident] of Object.entries(state.incidents)) if (!current.has(key) && recovered.has(key)) {
    if (incident.active && incident.status === 'sent' && incident.messageId && incident.event) {
      incident.event = { ...incident.event, recovered: true, observedAt: snapshot.generatedAt || new Date(now).toISOString() };
      incident.version = hash('recovered'); edits.add(incident.messageId);
    }
    incident.active = false;
  }
  for (const batch of Object.values(state.batches)) if (batch.status === 'blocked_dependency'
    && batch.keys.every(key => state.incidents[key]?.active === false || state.incidents[key]?.status === 'sent')) {
    batch.status = 'superseded'; batch.closedAt = new Date(now).toISOString();
  }
  // Persist pending edits even while muted or quota-blocked. A recovery update
  // must survive unmuting and a subsequent new cycle of the same resource.
  for (const batch of Object.values(state.batches)) if (batch.status === 'sent' && batch.messageId) {
    batch.events ||= {};
    for (const key of batch.keys) {
      const incident = state.incidents[key];
      if (incident?.messageId === batch.messageId && incident.event) {
        batch.events[key] = incident.event;
        if (incident.presentedVersion !== incident.version) batch.dirty = true;
      } else batch.events[key] ||= { subject: incident?.subject || '历史事件', detail: '历史状态未核实，详见原处理记录' };
    }
    if (batch.dirty) edits.add(batch.messageId);
  }
  state.observedAt = new Date(now).toISOString();
  const muted = config.enabled === false;
  if (dryRun) return { sent: 0, dryRun: true, baseline, muted, wouldSend: baseline || muted ? 0 : due.length,
    wouldUpdate: baseline || muted ? 0 : edits.size,
    subjects: baseline || muted ? [] : due.map(item => item.subject), observedAt: state.observedAt };
  // Keep observation and recovery alive while silencing both new sends and edits.
  if (baseline || muted) { await save(stateFile, state); return { sent: 0, updated: 0, baseline, muted, observedAt: state.observedAt }; }
  let updated = 0;
  for (const messageId of edits) {
    const batch = Object.values(state.batches).find(b => b.messageId === messageId);
    if (!batch || batch.status !== 'sent' || transportQuotaBlocked) continue;
    batch.status = 'updating'; await save(stateFile, state);
    try {
      const receipt = await update(Object.values(batch.events), { ...config, recoveryIncidents: [] }, messageId);
      if (receipt !== messageId) throw new Error('UPDATE_RECEIPT_MISMATCH');
      batch.status = 'sent'; batch.dirty = false; batch.updatedAt = state.observedAt; updated++;
      for (const key of batch.keys) if (state.incidents[key]?.messageId === messageId) {
        state.incidents[key].presentedVersion = state.incidents[key].version;
      }
    } catch (error) {
      batch.status = 'needs_review'; batch.error = errorCode(error);
      for (const key of batch.keys) if (state.incidents[key]?.messageId === messageId) state.incidents[key].status = 'needs_review';
    }
    await save(stateFile, state);
  }
  if (!due.length) { await save(stateFile, state); return { sent: 0, updated, baseline, observedAt: state.observedAt }; }
  const batchId = hash(due.map(item => `${item.key}:${item.cycle}`).sort().join('\n'));
  const batch = { status: 'sending', keys: due.map(item => item.key), startedAt: state.observedAt,
    events: Object.fromEntries(due.map(item => [item.key, state.incidents[item.key].event])) };
  state.batches[batchId] = batch;
  if (transportQuotaBlocked) {
    batch.status = 'blocked_dependency'; batch.error = 'FEISHU_MONTHLY_QUOTA';
    for (const item of due) state.incidents[item.key].status = batch.status;
    await save(stateFile, state);
    return { sent: 0, status: batch.status, observedAt: state.observedAt };
  }
  for (const item of due) state.incidents[item.key].status = 'sending';
  await save(stateFile, state);
  try {
    batch.messageId = await send(Object.values(batch.events), config, batchId);
    if (!batch.messageId?.startsWith('om_')) throw new Error('MISSING_RECEIPT');
    batch.status = 'sent';
  } catch (error) { batch.status = 'needs_review'; batch.error = errorCode(error); }
  for (const item of due) Object.assign(state.incidents[item.key], { status: batch.status, messageId: batch.messageId || null, presentedVersion: state.incidents[item.key].version });
  await save(stateFile, state);
  return { sent: batch.status === 'sent' ? due.length : 0, updated, status: batch.status, messageId: batch.messageId || null };
}

export async function runMonitoringAlerts({ baseline = false, dryRun = false, config: suppliedConfig,
  reader = createMonitoringReader({ getUsage: async () => null }), recover = processMonitoringRecovery,
  dispatch = dispatchMonitoringAlerts } = {}) {
  let config = suppliedConfig;
  try { config ||= JSON.parse(await readFile(join(CONFIG_DIR, 'monitoring.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false }; throw error; }
  if (!config.alertDelivery) return { enabled: false };
  // This independent observer needs no model and no running HTTP server.
  const snapshot = await reader({ days: 1 });
  if (snapshot.apiHealth && !dryRun) await writeDurableJson(join(CONFIG_DIR, 'feishu-api-health.json'), snapshot.apiHealth);
  // Notification and recovery have separate receipts. A reported/baselined
  // incident remains eligible for repair; an uncertain send is never replayed.
  let recovery;
  try { recovery = baseline ? { skipped: 'baseline' } : await recover({
    config: { ...config.recovery, ignoreUnits: config.alertDelivery.ignoreUnits,
      serviceConfirmationObservations: config.alertDelivery.confirmationObservations }, snapshot, dryRun }); }
  catch (error) { recovery = { enabled: config.recovery?.enabled === true, error: error.code || 'RECOVERY_UNAVAILABLE' }; }
  const alerts = await dispatch({ config: { ...config.alertDelivery, criticalAutomationIds: config.criticalAutomationIds,
    recoveryIncidents: recovery.incidents || snapshot.recovery }, snapshot, baseline, dryRun });
  return { ...alerts, recovery };
}
