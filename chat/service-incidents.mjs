import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';

const exec = promisify(execFile);
const signature = 'FATAL ERROR:|Main process exited,|Failed with result|Scheduled restart job';
export const SERVICE_STABLE_MS = 30 * 60_000;

// A process may recover between observations. The journal is the evidence,
// not the instantaneous ActiveState. Preserve one evidence record per invocation;
// human-facing incidents group these records into service failure cycles.
export function mergeServiceJournal(previous, rows, unit) {
  const events = new Map((previous || []).map(event => [event.id, event]));
  for (const row of rows) {
    const message = typeof row.MESSAGE === 'string' ? row.MESSAGE : '';
    if (!message || !row.__CURSOR) continue;
    const fatal = message.startsWith('FATAL ERROR:');
    const manager = row.UNIT === unit || row.USER_UNIT === unit;
    if (!fatal && !manager) continue;
    if (!fatal && !/Main process exited,|Failed with result '(?!success)|Scheduled restart job/.test(message)) continue;
    if (/Main process exited, code=exited, status=0\/SUCCESS/.test(message)) continue;
    const invocation = row.INVOCATION_ID || row._SYSTEMD_INVOCATION_ID || row.__CURSOR;
    const id = createHash('sha256').update(`${unit}:${invocation}`).digest('hex');
    const at = new Date(Number(row.__REALTIME_TIMESTAMP) / 1000).toISOString();
    const event = events.get(id) || { id, unit, invocation, at, evidence: [] };
    if (!event.evidence.some(e => e.cursor === row.__CURSOR)) event.evidence.push({
      cursor: row.__CURSOR, at, message: message.slice(0, 1000), pid: row._PID || null,
    });
    event.evidence = event.evidence.slice(-8);
    if (fatal) event.reason = /heap out of memory|Allocation failed/i.test(message) ? 'javascript_heap_oom' : 'fatal_error';
    event.reason ||= /oom-kill/.test(message) ? 'os_oom' : 'abnormal_exit';
    if (/Scheduled restart job/.test(message)) event.automaticRestart = true;
    events.set(id, event);
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-256);
}

export function mergeServiceCycles(previous = [], events = []) {
  const cycles = structuredClone(previous);
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    let cycle = cycles.find(c => c.eventIds.includes(event.id));
    if (!cycle) {
      cycle = cycles.findLast(c => c.unit === event.unit && Date.parse(event.at) >= Date.parse(c.lastAt)
        && Date.parse(event.at) - Date.parse(c.lastAt) < SERVICE_STABLE_MS);
      if (!cycle) {
        cycle = { id: event.id, unit: event.unit, at: event.at, lastAt: event.at, count: 0, eventIds: [] };
        cycles.push(cycle);
      }
      cycle.count++;
      // Raw evidence is archived separately. This dedup set covers the entire
      // bounded journal projection, so long crash loops retain a stable cycle ID.
      cycle.eventIds = [...cycle.eventIds, event.id].slice(-256);
    }
    if (event.at >= cycle.lastAt) Object.assign(cycle, {
      lastAt: event.at, reason: event.reason, automaticRestart: event.automaticRestart,
      evidence: event.evidence,
    });
  }
  return cycles.sort((a, b) => a.at.localeCompare(b.at)).slice(-256);
}

export async function collectServiceIncidents({ services = [], config = {},
  directory = join(CONFIG_DIR, 'service-incidents'), execute = exec,
  load = readRecord, save = writeDurableJson, now = Date.now(), dryRun = false } = {}) {
  if (config.enabled !== true) return { events: [], gaps: [] };
  const file = join(directory, 'state.json');
  const state = await load(file) || { version: 1, since: new Date(now).toISOString(), units: {}, events: [] };
  const gaps = [];
  for (const service of services.filter(s => s.unit?.endsWith('.service') && (!config.units || config.units.includes(s.unit)))) {
    if (!/^[\w@.-]+\.service$/.test(service.unit) || !['system', 'user'].includes(service.scope)) continue;
    const prior = state.units[service.unit];
    const args = [...(service.scope === 'user' ? ['--user'] : []), '-u', service.unit,
      '--no-pager', '--no-tail', '-o', 'json', '--grep', signature,
      ...(prior?.cursor ? ['--after-cursor', prior.cursor] : ['--since', state.since])];
    try {
      const sudo = config.systemJournalSudo === true && service.scope === 'system';
      const { stdout } = await execute(sudo ? 'sudo' : 'journalctl', sudo ? ['-n', 'journalctl', ...args] : args,
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).catch(error => {
          // journalctl --grep returns 1 for a successful query with no matches.
          if (error.code === 1 && !String(error.stderr || '').trim() && !String(error.stdout || '').trim()) return { stdout: '' };
          throw error;
        });
      const rows = stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
      const before = new Map(state.events.map(e => [e.id, JSON.stringify(e)]));
      state.events = mergeServiceJournal(state.events, rows, service.unit);
      if (!dryRun) for (const event of state.events) if (before.get(event.id) !== JSON.stringify(event)) {
        await save(join(directory, 'events', `${event.id}.json`), event);
      }
      if (rows.length) state.units[service.unit] = { cursor: rows.at(-1).__CURSOR };
    } catch (error) {
      // Never advance a failed/truncated read. Missing journal coverage is not health.
      gaps.push({ source: `serviceJournal:${service.unit}`, code: error.code || 'JOURNAL_UNAVAILABLE' });
    }
  }
  state.observedAt = new Date(now).toISOString();
  state.cycles = mergeServiceCycles(state.cycles, state.events);
  state.gaps = gaps;
  if (!dryRun) await save(file, state);
  return { events: state.events, cycles: state.cycles, gaps, observedAt: state.observedAt };
}

export function serviceIncidentAttention(events, services, { now = Date.now(), gaps = [] } = {}) {
  const cycles = events.every(e => Array.isArray(e.eventIds)) ? events : mergeServiceCycles([], events);
  return cycles.map(event => {
    const service = services.find(s => s.unit === event.unit);
    const available = service?.status === 'healthy';
    const stableSince = Math.max(Date.parse(event.lastAt), Date.parse(service?.lastRunAt) || 0);
    const recovered = available && now - stableSince >= SERVICE_STABLE_MS
      && !gaps.some(g => g.source === 'serviceIncidents' || g.source === `serviceJournal:${event.unit}`);
    return { kind: 'serviceCrash', severity: 'critical', id: event.id, unit: event.unit,
      subject: service?.label || event.unit, occurredAt: event.at, lastOccurredAt: event.lastAt,
      crashCount: event.count, eventIds: event.eventIds, recovered,
      recoveryObservation: recovered ? '服务已连续稳定运行30分钟，根因修复待确认' : undefined,
      detail: `本轮累计崩溃${event.count}次，最近一次 ${event.lastAt}：${event.reason}；${recovered ? '已稳定恢复，根因修复待确认' : available ? '服务目前已运行，根因尚未认定修复' : '服务当前状态待核查'}。`,
      signals: { reason: event.reason, automaticRestart: event.automaticRestart === true, available,
        unavailable: service?.status === 'failed', count: event.count, lastAt: event.lastAt },
      evidence: event.evidence };
  });
}

export async function recordRuntimeSample(sample, directory = join(CONFIG_DIR, 'runtime-health-history')) {
  if (!sample?.observedAt || !Number.isFinite(Date.parse(sample.observedAt))) return;
  await mkdir(directory, { recursive: true });
  const day = sample.observedAt.slice(0, 10);
  await appendFile(join(directory, `${day}.jsonl`), JSON.stringify(sample) + '\n', { mode: 0o600 });
  const cutoff = new Date(Date.parse(sample.observedAt) - 30 * 86400_000).toISOString().slice(0, 10);
  for (const name of await readdir(directory)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) {
    await unlink(join(directory, name));
  }
}
