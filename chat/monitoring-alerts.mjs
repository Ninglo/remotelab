import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { createMonitoringReader } from './monitoring.mjs';
import { processMonitoringRecovery } from './monitoring-recovery.mjs';
import { diskRiskStage } from '../lib/monitoring-actions.mjs';

const hash = value => createHash('sha256').update(value).digest('base64url');
const cell = (value, limit = 180) => String(value || '—').replace(/\|/g, '／').replace(/[\r\n]+/g, ' ').slice(0, limit);
const errorCode = error => error.code || 'DELIVERY_UNCERTAIN';

function accountAlerts(snapshot, config) {
  if (config.accountAlerts?.enabled !== true) return [];
  return snapshot.attention.filter(item => item.kind === 'accountContinuity');
}

export function renderMonitoringAlert(events, config) {
  const rows = events.map(item => {
    const recovery = config.recoveryIncidents?.slice().reverse().find(record => record.kind === item.kind && record.id === item.id);
    const problem = item.kind === 'disk'
      ? `可用 ${(item.availableBytes / 1024 ** 3).toFixed(2)} GiB，已用 ${item.usedPercent.toFixed(1)}%${Number.isFinite(item.inodeUsedPercent) ? `，inode 已用 ${item.inodeUsedPercent.toFixed(1)}%` : ''}`
      : item.detail || '运行持续异常，请核对原执行记录';
    const plan = recovery?.plan || item.action;
    const fallback = item.kind === 'disk' ? '先定位增长和写入者，按已授权维护流程处理可再生缓存、核验过的重复副本；逐项复测。迁移、删除唯一数据或扩容先出具体方案。'
      : '先核对原执行和已有结果，只自动处理可验证的低风险问题；涉及业务中断或新增影响先提交方案确认。';
    const handling = plan?.requiresConfirmation ? `待确认：${plan.summary}`
      : recovery?.status === 'blocked' ? `低风险处理受阻：${recovery.reason}；需补齐具体处置方案`
      : recovery ? `${recovery.label}；${plan?.summary || fallback}` : plan?.summary || fallback;
    return `| ${cell(item.subject)} | ${cell(problem)} | ${cell(handling)} |`;
  }).join('\n');
  const plans = events.flatMap(item => {
    const record = config.recoveryIncidents?.slice().reverse().find(r => r.kind === item.kind && r.id === item.id);
    const plan = record?.plan;
    if (!plan?.requiresConfirmation) return [];
    return [`**${cell(item.subject)}：${plan.risk === 'high' ? '高' : '中'}风险方案，确认前不执行**\n`
      + `方案：${cell(plan.summary, 1200)}\n对象：${cell(plan.target, 1200)}\n影响：${cell(plan.impact, 1200)}\n恢复：${cell(plan.rollback, 1200)}\n验收：${cell(plan.verification, 1200)}\n`
      + (record.sessionId && config.overviewUrl ? `在原处理会话确认：${new URL(`/?session=${encodeURIComponent(record.sessionId)}`, config.overviewUrl).href}` : '')];
  }).join('\n\n');
  return `**监管：风险与处置**\n\n| 对象 | 业务风险 | 已有处置／待确认事项 |\n|---|---|---|\n${rows}\n\n${plans}\n\n${config.overviewUrl || ''}\n低风险处理自行完成并留存验收；中高风险方案经人确认后执行。正常账号消耗不要求人处理。`;
}

export async function sendMonitoringAlert(events, config, batchId) {
  if (!/^oc_[\w]+$/.test(config.chatId || '') || !/^[\w.-]+$/.test(config.profile || '')) throw new Error('INVALID_RECIPIENT');
  const message = renderMonitoringAlert(events, config);
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
    && !(provider.notificationDelivery?.status === 'available'
      && provider.notificationDelivery.evidence
      && Date.parse(provider.notificationDelivery.observedAt) > Date.parse(provider.quotaRejectedAt)
      && Date.parse(provider.notificationDelivery.observedAt) <= now + 5000)
    && (!config.feishuAppId || provider.appId === config.feishuAppId));
  for (const batch of Object.values(state.batches)) if (batch.status === 'sending') {
    batch.status = 'needs_review';
    for (const key of batch.keys) if (state.incidents[key]) state.incidents[key].status = 'needs_review';
  }
  const current = new Set(), recovered = new Set(), due = [];
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
    const count = previous?.active ? previous.observations + 1 : 1;
    const eligible = item.severity === 'critical' || ['disk', 'accountContinuity'].includes(item.kind) || item.kind === 'automation'
      && (config.criticalAutomationIds || []).includes(item.id);
    const configuredCount = Number(config.confirmationObservations);
    const confirmationCount = Number.isInteger(configuredCount) && configuredCount >= 1 && configuredCount <= 10 ? configuredCount : 1;
    const requiredCount = item.kind === 'disk' || item.kind === 'api' && item.code === 99991403 ? 1 : item.kind === 'automation' ? 3
      : item.kind === 'accountContinuity' ? Math.max(3, confirmationCount) : confirmationCount;
    const critical = eligible && count >= requiredCount;
    const incident = !previous?.active ? { cycle: (previous?.cycle || 0) + 1, status: 'observing', observations: count, active: true } : previous;
    const repair = config.recoveryIncidents?.slice().reverse().find(r => r.kind === item.kind && r.id === item.id);
    const stage = diskRiskStage(item);
    const actionVersion = hash(JSON.stringify({ plan: repair?.plan || item.action || null,
      blocked: repair?.status === 'blocked' ? repair.reason : null }));
    if ((incident.actionVersion && actionVersion !== incident.actionVersion || stage > (incident.riskStage || stage))
      && ['sent', 'baseline', 'blocked_dependency'].includes(incident.status)) {
      incident.status = 'observing'; incident.cycle++;
    }
    incident.actionVersion = actionVersion;
    incident.riskStage = stage;
    if (!critical && incident.lastCritical) { incident.status = 'observing'; incident.cycle++; }
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
  for (const [key, incident] of Object.entries(state.incidents)) if (!current.has(key) && recovered.has(key)) incident.active = false;
  for (const batch of Object.values(state.batches)) if (batch.status === 'blocked_dependency'
    && batch.keys.every(key => state.incidents[key]?.active === false || state.incidents[key]?.status === 'sent')) {
    batch.status = 'superseded'; batch.closedAt = new Date(now).toISOString();
  }
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
