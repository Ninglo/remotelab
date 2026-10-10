import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { createMonitoringReader } from './monitoring.mjs';
import { processMonitoringRecovery } from './monitoring-recovery.mjs';

const hash = value => createHash('sha256').update(value).digest('base64url');
const cell = value => String(value || '—').replace(/\|/g, '／').replace(/[\r\n]+/g, ' ').slice(0, 180);
const errorCode = error => error.code || 'DELIVERY_UNCERTAIN';

function accountAlerts(snapshot, config) {
  if (config.accountAlerts?.enabled !== true) return [];
  const sources = config.accountAlerts.sources || [];
  return (snapshot.accounts || []).filter(account => !sources.length || account.sources?.some(source => sources.includes(source)))
    .flatMap(account => {
      if (['unknown', 'conflicting'].includes(account.status)) return [{ kind: 'account', id: account.id,
        subject: account.label, severity: 'critical' }];
      if (account.status === 'exhausted') return [{ kind: 'quota', id: account.id,
        subject: account.label, severity: 'critical' }];
      return [];
    });
}

export async function sendMonitoringAlert(events, config, batchId) {
  if (!/^oc_[\w]+$/.test(config.chatId || '') || !/^[\w.-]+$/.test(config.profile || '')) throw new Error('INVALID_RECIPIENT');
  const rows = events.map(item => {
    const recovery = config.recoveryIncidents?.slice().reverse().find(record => record.kind === item.kind && record.id === item.id);
    const problem = item.kind === 'disk'
      ? `可用 ${(item.availableBytes / 1024 ** 3).toFixed(2)} GiB，已用 ${item.usedPercent.toFixed(1)}%${Number.isFinite(item.inodeUsedPercent) ? `，inode 已用 ${item.inodeUsedPercent.toFixed(1)}%` : ''}`
      : item.kind === 'account' ? '额度持续无法核实，请核对采集或登录状态；不能据此判断账号已耗尽'
      : item.kind === 'quota' ? '额度已耗尽，请选择有可用额度的账号'
      : item.detail || '运行持续异常，请核对原执行记录';
    return `| ${cell(item.subject)} | ${problem}${recovery ? `；${cell(recovery.label)}${recovery.reason ? `：${cell(recovery.reason)}` : ''}` : ''} |`;
  }).join('\n');
  const message = `**监管：需要及时处理**\n\n| 对象 | 当前问题 |\n|---|---|\n${rows}\n\n${config.overviewUrl || ''}\n日常状态继续并入日报，本条只报告新出现的紧急问题。`;
  const { stdout } = await promisify(execFile)('lark-cli', ['--profile', config.profile, 'im', '+messages-send',
    '--chat-id', config.chatId, '--as', 'bot', '--markdown', message, '--idempotency-key', batchId], {
    timeout: 25_000, maxBuffer: 100_000, env: { ...process.env,
      ...(config.configDir ? { LARKSUITE_CLI_CONFIG_DIR: config.configDir } : {}),
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
  });
  const value = JSON.parse(stdout), receipt = value.data?.message_id || value.message_id;
  if (!receipt?.startsWith('om_')) throw new Error('MISSING_RECEIPT');
  return receipt;
}

export async function dispatchMonitoringAlerts({ config, snapshot, stateFile = join(CONFIG_DIR, 'monitoring-alerts.json'),
  send = sendMonitoringAlert, load = readRecord, save = writeDurableJson, now = Date.now(), baseline = false, dryRun = false }) {
  const state = await load(stateFile) || { version: 1, incidents: {}, batches: {} };
  const transportQuotaBlocked = snapshot.apiHealth?.providers?.some(provider => provider.quotaRejectedAt
    && (!config.feishuAppId || provider.appId === config.feishuAppId));
  for (const batch of Object.values(state.batches)) if (batch.status === 'sending') {
    batch.status = 'needs_review';
    for (const key of batch.keys) if (state.incidents[key]) state.incidents[key].status = 'needs_review';
  }
  const current = new Set(), recovered = new Set(), due = [];
  // Absence after a source change, an unreadable source and an unfinished Run
  // are not recovery. Rearm only an explicitly observed healthy or stopped item.
  for (const item of snapshot.disks) if (item.status === 'healthy') recovered.add(hash(`disk:${item.path || item.label}`));
  for (const item of snapshot.services) if (item.status === 'healthy') recovered.add(hash(`service:${item.unit || item.label}`));
  for (const account of snapshot.accounts || []) {
    if (['available', 'exhausted'].includes(account.status)) recovered.add(hash(`account:${account.id}`));
    if (account.status === 'available') recovered.add(hash(`quota:${account.id}`));
  }
  for (const provider of snapshot.apiHealth?.providers || []) {
    if (!provider.quotaRejectedAt && snapshot.apiHealth.coverage.complete) recovered.add(hash(`api:${provider.id}:quota`));
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
    const count = previous?.active ? previous.observations + 1 : 1;
    const eligible = item.severity === 'critical' || item.kind === 'automation'
      && (config.criticalAutomationIds || []).includes(item.id);
    const configuredCount = Number(config.confirmationObservations);
    const confirmationCount = Number.isInteger(configuredCount) && configuredCount >= 1 && configuredCount <= 10 ? configuredCount : 1;
    const requiredCount = item.kind === 'disk' || item.kind === 'api' && item.code === 99991403 ? 1 : item.kind === 'automation' ? 3
      : ['account', 'quota'].includes(item.kind) ? Math.max(3, confirmationCount) : confirmationCount;
    const critical = eligible && count >= requiredCount;
    const incident = !previous?.active ? { cycle: (previous?.cycle || 0) + 1, status: 'observing', observations: count, active: true } : previous;
    if (!critical && incident.lastCritical) { incident.status = 'observing'; incident.cycle++; }
    Object.assign(incident, { observations: count, active: true, subject: item.subject, kind: item.kind });
    incident.lastCritical = critical;
    if (baseline && eligible
      && !['sent', 'needs_review'].includes(incident.status)) incident.status = 'baseline';
    if (critical && incident.status === 'observing') incident.status = 'pending';
    state.incidents[key] = incident;
    if (incident.status === 'blocked_dependency' && !transportQuotaBlocked
      && snapshot.apiHealth?.coverage.complete) incident.status = 'pending';
    if (critical && incident.status === 'pending') due.push({ key, ...item, cycle: incident.cycle });
  }
  for (const [key, incident] of Object.entries(state.incidents)) if (!current.has(key) && recovered.has(key)) incident.active = false;
  state.observedAt = new Date(now).toISOString();
  if (dryRun) return { sent: 0, dryRun: true, baseline, wouldSend: baseline ? 0 : due.length,
    subjects: baseline ? [] : due.map(item => item.subject), observedAt: state.observedAt };
  if (!due.length || baseline) { await save(stateFile, state); return { sent: 0, baseline, observedAt: state.observedAt }; }
  const batchId = hash(due.map(item => `${item.key}:${item.cycle}`).sort().join('\n'));
  const batch = { status: 'sending', keys: due.map(item => item.key), startedAt: state.observedAt };
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
    batch.messageId = await send(due, config, batchId);
    if (!batch.messageId?.startsWith('om_')) throw new Error('MISSING_RECEIPT');
    batch.status = 'sent';
  } catch (error) { batch.status = 'needs_review'; batch.error = errorCode(error); }
  for (const item of due) Object.assign(state.incidents[item.key], { status: batch.status, messageId: batch.messageId || null });
  await save(stateFile, state);
  return { sent: batch.status === 'sent' ? due.length : 0, status: batch.status, messageId: batch.messageId || null };
}

export async function runMonitoringAlerts({ baseline = false, dryRun = false } = {}) {
  let config;
  try { config = JSON.parse(await readFile(join(CONFIG_DIR, 'monitoring.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false }; throw error; }
  if (!config.alertDelivery) return { enabled: false };
  // This independent observer needs no model and no running HTTP server.
  const snapshot = await createMonitoringReader({ getUsage: async () => null })({ days: 1 });
  if (snapshot.apiHealth && !dryRun) await writeDurableJson(join(CONFIG_DIR, 'feishu-api-health.json'), snapshot.apiHealth);
  // Notification and recovery have separate receipts. A reported/baselined
  // incident remains eligible for repair; an uncertain send is never replayed.
  let recovery;
  try { recovery = baseline ? { skipped: 'baseline' } : await processMonitoringRecovery({
    config: { ...config.recovery, ignoreUnits: config.alertDelivery.ignoreUnits,
      serviceConfirmationObservations: config.alertDelivery.confirmationObservations }, snapshot, dryRun }); }
  catch (error) { recovery = { enabled: config.recovery?.enabled === true, error: error.code || 'RECOVERY_UNAVAILABLE' }; }
  const alerts = await dispatchMonitoringAlerts({ config: { ...config.alertDelivery, criticalAutomationIds: config.criticalAutomationIds,
    recoveryIncidents: recovery.incidents }, snapshot, baseline, dryRun });
  return { ...alerts, recovery };
}
