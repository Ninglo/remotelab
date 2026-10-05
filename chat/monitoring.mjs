import { readFile, stat, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { codexAccounts } from '../lib/codex-accounts.mjs';
import { queryUsageLedger } from './usage-ledger.mjs';
import { listAutomationTasks } from './automation-tasks.mjs';
import { readRecord } from '../lib/durable-records.mjs';
import { RECOVERY_FILE, projectRecovery } from './monitoring-recovery.mjs';

const exec = promisify(execFile);
const GiB = 1024 ** 3;
const freshMs = 10 * 60_000;
const text = value => String(value || '').slice(0, 180);
const mask = value => text(value).replace(/([\w.+-])[\w.+-]*(@[\w.-]+)/g, '$1***$2');
const dateMs = value => Date.parse(value || '');
const fresh = (value, now) => Number.isFinite(dateMs(value)) && now - dateMs(value) <= freshMs && dateMs(value) <= now + 5000;

export function projectAccounts(runtime, fleet, now = Date.now()) {
  const sources = new Map();
  function add(id, sample) {
    if (!sources.has(id)) sources.set(id, []);
    sources.get(id).push(sample);
  }
  for (const item of runtime?.accounts || []) if (item.account || item.usage || item.identityId || item.label) add(item.identityId || item.id, {
    label: item.label || item.account?.email || 'Codex', active: item.id === runtime.activeId,
    status: item.usage?.status, quota: item.usage?.buckets || [], observedAt: item.usage?.checkedAt,
    ready: fresh(item.usage?.checkedAt, now), source: 'instance',
  });
  for (const [adapterId, entry] of Object.entries(fleet?.adapters || {})) {
    for (const item of entry.snapshot?.subscriptions || []) if (item.identityId) add(item.identityId, {
      label: item.label, status: item.status, quota: item.quota || [], observedAt: item.observedAt,
      ready: fresh(entry.receivedAt, now) && fresh(item.observedAt, now), source: adapterId,
    });
  }
  return [...sources.entries()].map(([id, samples]) => {
    const usable = samples.filter(sample => sample.ready && sample.status === 'ready' && sample.quota.some(bucket => bucket.id === 'codex'))
      .sort((a, b) => dateMs(b.observedAt) - dateMs(a.observedAt));
    const sample = usable[0] || samples.slice().sort((a, b) => (dateMs(b.observedAt) || 0) - (dateMs(a.observedAt) || 0))[0];
    const rawWindows = usable[0]?.quota.filter(bucket => bucket.id === 'codex').flatMap(bucket => [bucket.primary, bucket.secondary]).filter(Boolean) || [];
    const conflicts = usable.some(other => other.quota.filter(bucket => bucket.id === 'codex').flatMap(bucket => [bucket.primary, bucket.secondary]).filter(Boolean)
      .some(window => rawWindows.some(current => current.windowDurationMins === window.windowDurationMins
        && Math.abs(current.remainingPercent - window.remainingPercent) > 5)));
    const valid = rawWindows.length > 0 && !conflicts && rawWindows.every(window => Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0
      && Number.isFinite(window.remainingPercent)
      && window.remainingPercent >= 0 && window.remainingPercent <= 100
      && (!window.resetsAt || dateMs(window.resetsAt) > now));
    const windows = valid ? rawWindows.map(window => ({ minutes: window.windowDurationMins,
      remainingPercent: window.remainingPercent, resetsAt: window.resetsAt || null })) : [];
    return { id, label: mask(sample.label), active: samples.some(item => item.active),
      status: conflicts ? 'conflicting' : !valid ? 'unknown' : windows.some(window => window.remainingPercent === 0) ? 'exhausted' : 'available',
      windows, observedAt: sample.observedAt || null, sources: [...new Set(samples.map(item => item.source))] };
  });
}

export async function readService(item, execute = exec) {
  if (!/^[\w@.-]+\.(service|timer)$/.test(item.unit || '') || !['user', 'system'].includes(item.scope)) throw new Error('INVALID_UNIT');
  const { stdout } = await execute('systemctl', [...(item.scope === 'user' ? ['--user'] : []), 'show', item.unit,
    '--property=LoadState,ActiveState,SubState,Result,Type,ExecMainStatus,ExecMainStartTimestamp,LastTriggerUSec'], { timeout: 3000, maxBuffer: 8192 });
  const state = Object.fromEntries(stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const known = state.LoadState === 'loaded';
  const neverRan = state.Type === 'oneshot' && state.ActiveState === 'inactive' && !state.ExecMainStartTimestamp;
  const healthy = known && (state.ActiveState === 'active' || !neverRan && state.Type === 'oneshot' && state.ActiveState === 'inactive' && state.Result === 'success');
  const starting = known && state.ActiveState === 'activating' && state.Result === 'success';
  return { label: text(item.label || item.unit), unit: item.unit, status: !known || neverRan ? 'unknown' : healthy ? 'healthy' : starting ? 'running' : 'failed',
    state: state.ActiveState, lastResult: state.Result || null, lastRunAt: state.ExecMainStartTimestamp || state.LastTriggerUSec || null,
    observedAt: new Date().toISOString() };
}

export function analyzeResources({ accounts, disks, automations, services, recovery = [] }) {
  const attention = [];
  for (const disk of disks) if (disk.status === 'critical' || disk.status === 'warning') attention.push({ kind: 'disk', severity: disk.status,
    id: disk.path, subject: disk.label, availableBytes: disk.availableBytes, usedPercent: disk.usedPercent, inodeUsedPercent: disk.inodeUsedPercent });
  const available = accounts.filter(account => account.status === 'available');
  const exhausted = accounts.filter(account => account.status === 'exhausted');
  if (exhausted.length) attention.push({ kind: 'quota', severity: !available.length || exhausted.some(account => account.active) ? 'critical' : 'warning',
    subject: exhausted.map(account => account.label).join('、'), availableAccounts: available.length });
  const low = available.filter(account => account.windows.some(window => window.remainingPercent <= 10));
  if (low.length) attention.push({ kind: 'lowQuota', severity: 'warning', subject: low.map(account => account.label).join('、') });
  for (const task of automations.items) if (!['completed', 'cancelled', 'paused'].includes(task.state)
    && (task.lastExecution?.state === 'failed' || task.lastError)
    && !(task.lastExecution?.runId && !task.lastError && recovery.some(item => item.kind === 'automation'
      && item.id === task.id && item.originRunId === task.lastExecution.runId && item.status === 'resolved'))) attention.push({ kind: 'automation',
    severity: 'warning', subject: task.title, id: task.id, sessionId: task.lastExecution?.sessionId || null });
  for (const service of services) if (service.status === 'failed') attention.push({ kind: 'service', severity: 'critical', id: service.unit, subject: service.label });
  const capacity = available.filter(account => account.windows.some(window => Math.abs(window.minutes - 10080) <= 60 && window.remainingPercent >= 50));
  const opportunities = capacity.length ? [{ kind: 'capacity', accounts: capacity.map(account => ({ label: account.label,
    ...account.windows.find(window => Math.abs(window.minutes - 10080) <= 60) })) }] : [];
  return { attention, opportunities };
}

export function createMonitoringReader({ configFile = join(CONFIG_DIR, 'monitoring.json'), getUsage = queryUsageLedger,
  getTasks = listAutomationTasks, getAccounts = () => codexAccounts.read(), getService = readService,
  getFs = statfs, getStat = stat, read = readFile, now = Date.now } = {}) {
  const cache = new Map();
  return async function overview({ days = 7 } = {}) {
    if (![1, 7, 30].includes(days)) days = 7;
    const cached = cache.get(days);
    if (cached && now() - cached.startedAt < 15_000) return cached.promise;
    const promise = collect(days);
    cache.set(days, { startedAt: now(), promise });
    try { return await promise; } catch (error) { cache.delete(days); throw error; }
  };
  async function collect(days) {
    const generatedAt = new Date(now()).toISOString();
    const gaps = [];
    let config = {};
    try {
      const value = JSON.parse(await read(configFile, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CONFIG');
      config = value;
    }
    catch (error) { if (error.code !== 'ENOENT') gaps.push({ source: 'configuration', code: error.code || 'INVALID_CONFIG' }); }
    async function observe(source, fn, fallback) {
      try { return await fn(); } catch (error) { gaps.push({ source, code: error.code || 'UNAVAILABLE' }); return fallback; }
    }
    const [usage, tasks, runtime, fleet, requests, disks, services, recovery] = await Promise.all([
      observe('usage', () => getUsage({ days, top: Math.max(5, days + 1), includeTopRuns: false }), null),
      observe('automations', getTasks, []), observe('accounts', getAccounts, null),
      config.fleetStateFile ? observe('fleet', async () => {
        const value = JSON.parse(await read(config.fleetStateFile, 'utf8'));
        if (value.schemaVersion !== 2 || !value.adapters) throw new Error('INVALID_FLEET');
        return value;
      }, null) : null,
      config.autoRequestStateFile ? observe('automaticRequests', async () => JSON.parse(await read(config.autoRequestStateFile, 'utf8')), null) : null,
      Promise.all((Array.isArray(config.disks) && config.disks.length ? config.disks : [{ path: '/', label: 'System disk', system: true }]).slice(0, 10).map(async item => {
        const value = await observe(`disk:${item.path}`, async () => {
          const [fs, info] = await Promise.all([getFs(item.path), getStat(item.path)]);
          const totalBytes = Number(fs.blocks) * Number(fs.bsize), availableBytes = Number(fs.bavail) * Number(fs.bsize);
          if (!(totalBytes > 0) || !Number.isFinite(availableBytes)) throw new Error('INVALID_DISK');
          const usedBlocks = Number(fs.blocks) - Number(fs.bfree);
          const usedPercent = usedBlocks / (usedBlocks + Number(fs.bavail)) * 100;
          const inodeUsedPercent = Number(fs.files) > 0 ? (Number(fs.files) - Number(fs.ffree)) / Number(fs.files) * 100 : null;
          const status = usedPercent >= 92 || item.system && availableBytes < 8 * GiB || inodeUsedPercent >= 92 ? 'critical'
            : usedPercent >= 85 || item.system && availableBytes < 15 * GiB || inodeUsedPercent >= 85 ? 'warning' : 'healthy';
          return { path: item.path, label: text(item.label || item.path), totalBytes, availableBytes, usedPercent, inodeUsedPercent,
            device: info.dev, status, observedAt: generatedAt };
        }, { path: item.path, label: text(item.label || item.path), status: 'unknown', observedAt: generatedAt });
        return value;
      })),
      Promise.all((Array.isArray(config.services) ? config.services : []).slice(0, 20).map(item => observe(`service:${item.label || item.unit}`, () => getService(item),
        { label: text(item.label || item.unit), unit: item.unit, status: 'unknown', observedAt: generatedAt }))),
      config.recovery?.enabled ? observe('recovery', () => readRecord(RECOVERY_FILE), null) : null,
    ]);
    const accounts = projectAccounts(runtime, fleet, now());
    for (const disk of disks) {
      const same = disks.find(other => other !== disk && other.device !== undefined && other.device === disk.device);
      if (same) disk.sharedFilesystem = same.label;
    }
    for (const disk of disks) delete disk.device;
    const activeStates = ['active', 'accepted', 'running', 'starting', 'scheduled', 'pending'];
    const recent = value => dateMs(value) <= now() && now() - dateMs(value) < 24 * 3600_000;
    const unverifiedAdmissions = tasks.filter(task => task.kind === 'one_time' && task.state === 'admitted').length;
    if (!gaps.some(gap => gap.source === 'automations')) for (const id of config.criticalAutomationIds || []) {
      if (!tasks.some(task => task.id === id)) gaps.push({ source: `automation:${id}`, code: 'NOT_FOUND' });
    }
    const liveTasks = tasks.filter(task => task.kind === 'recurring' || activeStates.includes(task.state)
      || task.state === 'admitted' && recent(task.lastExecution?.admittedAt || task.lastExecution?.scheduledAt)
      || task.lastExecution?.state === 'failed' && recent(task.lastExecution.completedAt || task.lastExecution.attemptedAt || task.updatedAt));
    const automations = { total: tasks.length, active: liveTasks.filter(task => activeStates.includes(task.state)).length,
      items: liveTasks.map(task => ({ id: task.id, title: text(task.title), state: task.state, nextRunAt: task.nextRunAt,
        check: task.check ? { at: task.check.at, reason: task.check.reason } : null,
        lastError: task.lastError ? text(task.lastError) : null, lastExecution: task.lastExecution ? {
          runId: task.lastExecution.runId, state: task.lastExecution.state, completedAt: task.lastExecution.completedAt, sessionId: task.lastExecution.sessionId,
          scheduledAt: task.lastExecution.scheduledAt, error: task.lastExecution.error ? text(task.lastExecution.error) : null } : null })) };
    const automaticRequests = Object.entries(requests?.attempts || {}).map(([accountId, item]) => ({ accountId,
      label: accounts.find(account => account.id === accountId)?.label || accountId.slice(0, 8), status: item.status,
      completedAt: item.completedAt || item.startedAt, model: item.model }));
    const recoveryItems = projectRecovery(recovery);
    const analysis = analyzeResources({ accounts, disks, automations, services, recovery: recoveryItems });
    return { generatedAt, windowDays: days,
      usage: usage ? { window: usage.window, totals: usage.totals, byDay: usage.byDay, byModel: usage.byModel?.slice(0, 5),
        byOperation: usage.byOperation?.slice(0, 5), byOperationGroup: usage.byOperationGroup?.slice(0, 5) } : null,
      accounts, disks, automations, services, automaticRequests, ...analysis, recovery: recoveryItems,
      coverage: { scope: 'instance_usage_and_connected_accounts', fleetConnected: Boolean(config.fleetStateFile), servicesConfigured: services.length,
        unknownAccounts: accounts.filter(account => ['unknown', 'conflicting'].includes(account.status)).length, unverifiedAdmissions, gaps } };
  }
}

export const readMonitoringOverview = createMonitoringReader();
