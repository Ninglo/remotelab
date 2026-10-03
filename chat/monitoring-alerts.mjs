import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { createMonitoringReader } from './monitoring.mjs';

const hash = value => createHash('sha256').update(value).digest('base64url');
const cell = value => String(value || '—').replace(/\|/g, '／').replace(/[\r\n]+/g, ' ').slice(0, 180);
const errorCode = error => error.code || 'DELIVERY_UNCERTAIN';

export async function sendMonitoringAlert(events, config, batchId) {
  if (!/^oc_[\w]+$/.test(config.chatId || '') || !/^[\w.-]+$/.test(config.profile || '')) throw new Error('INVALID_RECIPIENT');
  const rows = events.map(item => `| ${cell(item.subject)} | ${item.kind === 'disk'
    ? `可用 ${(item.availableBytes / 1024 ** 3).toFixed(2)} GiB，已用 ${item.usedPercent.toFixed(1)}%${Number.isFinite(item.inodeUsedPercent) ? `，inode 已用 ${item.inodeUsedPercent.toFixed(1)}%` : ''}` : '运行持续异常，请核对原执行记录'} |`).join('\n');
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
  send = sendMonitoringAlert, load = readRecord, save = writeDurableJson, now = Date.now(), baseline = false }) {
  const state = await load(stateFile) || { version: 1, incidents: {}, batches: {} };
  for (const batch of Object.values(state.batches)) if (batch.status === 'sending') {
    batch.status = 'needs_review';
    for (const key of batch.keys) if (state.incidents[key]) state.incidents[key].status = 'needs_review';
  }
  const current = new Set(), due = [];
  // An unreadable source cannot establish recovery and rearm the same incident.
  for (const item of [...snapshot.disks.map(item => ({ ...item, kind: 'disk' })), ...snapshot.services.map(item => ({ ...item, kind: 'service' }))]) {
    if (['unknown', 'running', 'starting'].includes(item.status)) current.add(hash(`${item.kind}:${item.path || item.unit || item.label}`));
  }
  if (snapshot.coverage.gaps.some(gap => gap.source === 'automations')) {
    for (const [key, incident] of Object.entries(state.incidents)) if (incident.kind === 'automation') current.add(key);
  }
  for (const item of snapshot.attention.filter(item => ['disk', 'service', 'automation'].includes(item.kind)
    && !(item.kind === 'service' && (config.ignoreUnits || []).includes(item.id)))) {
    const key = hash(`${item.kind}:${item.id || item.subject}`); current.add(key);
    const previous = state.incidents[key];
    const count = previous?.active ? previous.observations + 1 : 1;
    const critical = item.severity === 'critical' || item.kind === 'automation'
      && (config.criticalAutomationIds || []).includes(item.id) && count >= 3;
    const incident = !previous?.active ? { cycle: (previous?.cycle || 0) + 1, status: 'observing', observations: count, active: true } : previous;
    if (!critical && incident.lastCritical) { incident.status = 'observing'; incident.cycle++; }
    Object.assign(incident, { observations: count, active: true, subject: item.subject, kind: item.kind });
    incident.lastCritical = critical;
    if (baseline && critical) incident.status = 'baseline';
    if (critical && incident.status === 'observing') incident.status = 'pending';
    state.incidents[key] = incident;
    if (critical && incident.status === 'pending') due.push({ key, ...item, cycle: incident.cycle });
  }
  for (const [key, incident] of Object.entries(state.incidents)) if (!current.has(key)) incident.active = false;
  state.observedAt = new Date(now).toISOString();
  if (!due.length || baseline) { await save(stateFile, state); return { sent: 0, baseline, observedAt: state.observedAt }; }
  const batchId = hash(due.map(item => `${item.key}:${item.cycle}`).sort().join('\n'));
  const batch = { status: 'sending', keys: due.map(item => item.key), startedAt: state.observedAt };
  state.batches[batchId] = batch;
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

export async function runMonitoringAlerts({ baseline = false } = {}) {
  let config;
  try { config = JSON.parse(await readFile(join(CONFIG_DIR, 'monitoring.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false }; throw error; }
  if (!config.alertDelivery) return { enabled: false };
  // This independent observer needs no model and no running HTTP server.
  const snapshot = await createMonitoringReader({ getUsage: async () => null })({ days: 1 });
  return dispatchMonitoringAlerts({ config: { ...config.alertDelivery, criticalAutomationIds: config.criticalAutomationIds }, snapshot, baseline });
}
