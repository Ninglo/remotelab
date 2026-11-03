// Called by the existing resource-alert observer. No timer, model or scheduler writes.
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
const exec = promisify(execFile);
export const POOL_SNAPSHOT = join(CONFIG_DIR, 'pool-observation.json');
const at = value => Date.parse(value || '');
const fresh = (value, now, seconds = 180) => Number.isFinite(at(value)) && at(value) <= now + 5000 && now - at(value) <= seconds * 1000;
const healthy = (source, now) => source && !source.failed && !source.stale && fresh(source.observedAt, now, source.maxAgeSeconds || 180);

export function assessPool(previous, sample, { now = Date.now(), sourceGraceMs = 180000, stallMs = 1800000, errorIncrease = 10 } = {}) {
  const time = new Date(now).toISOString(), attention = [], recovered = [], sources = {}, tasks = {};
  function source(id, label, ok, detail) {
    const old = previous?.sources?.[id];
    sources[id] = { ok, failedSince: ok ? null : old?.failedSince || time };
    if (ok) recovered.push({ kind: 'poolSource', id });
    else if (now - at(sources[id].failedSince) >= sourceGraceMs) attention.push({ kind: 'poolSource', id,
      subject: label, severity: 'warning', confirmed: true, detail, signals: { unavailable: true } });
  }
  const resources = sample.resources, queue = sample.queue;
  source('controller', '卡池控制面', !resources?.controllerStale && fresh(resources?.observedAt, now),
    '连续三分钟未取得有效卡池控制面状态；接单与分配显示未知，原调度器仍独立运行。');
  const queueFresh = fresh(queue?._readAt, now);
  source('queue', '评测队列状态', queueFresh, '连续三分钟未取得有效队列状态；暂停卡顿判断，保留上次成功时间。');
  for (const machine of resources?.machines || []) {
    if (machine.observation) source(`device:${machine.id}`, machine.name || machine.id, healthy(machine.observation, now),
      `设备采样持续不可用，占用显示未知；${machine.observation.error || '采样已过期'}。任务与云配额按各自来源判断。`);
    if (machine.cloudObservation) source(`cloud:${machine.id}`, `${machine.name || machine.id} 云队列`, healthy(machine.cloudObservation, now),
      '云配额与任务列表持续不可用；旧数据保留原采样时间，不计作当前空闲容量。');
  }
  // Only fresh consecutive successful observations establish a task progress window.
  // A telemetry gap, a generation change or an accepted result resets the window.
  if (queueFresh) for (const run of queue.runs || []) {
    const id = run.run_id, old = previous?.tasks?.[id], accepted = run.progress?.accepted;
    const infra = run.progress?.infra_failed ?? 0;
    const running = run.state === 'running';
    const continuous = running && old?.state === 'running' && old.generation === run.generation
      && old.accepted === accepted && fresh(old.observedAt, now) && Number.isFinite(accepted);
    const row = { state: run.state, generation: run.generation, accepted, infra, observedAt: queue._readAt,
      since: continuous ? old.since : time, infraBase: continuous ? old.infraBase : infra, alerted: false };
    row.alerted = continuous && now - at(row.since) >= stallMs && infra - row.infraBase >= errorIncrease;
    tasks[id] = row;
    if (row.alerted) attention.push({ kind: 'poolTask', id, subject: id, severity: 'warning', confirmed: true,
      detail: `已接受结果 ${accepted}/${run.progress?.expected ?? '?'}，连续 ${Math.floor((now - at(row.since)) / 60000)} 分钟未增加，期间基础设施失败局数增加 ${infra - row.infraBase}；需检查是否停止或释放资源。`,
      signals: { noProgressWithErrors: true } });
    else if (old?.alerted && (accepted > old.accepted || run.generation !== old.generation || !running)) recovered.push({ kind: 'poolTask', id });
    // An observation gap is not evidence that an incident recovered.
    else if (old?.alerted) row.alerted = true;
  }
  for (const [id, old] of Object.entries(previous?.tasks || {})) if (!tasks[id] && old.alerted) tasks[id] = old;
  for (const run of sample.terminals || []) if (['completed', 'stopped', 'cancelled', 'failed'].includes(run.state)) {
    recovered.push({ kind: 'poolTask', id: run.run_id }); delete tasks[run.run_id];
  }
  return { schema: 1, observedAt: time, sources, tasks, attention, recovered };
}

async function jsonFetch(fetchImpl, url) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) throw Error('POOL_SOURCE_NOT_LOCAL');
  const response = await fetchImpl(target, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw Error(`HTTP_${response.status}`);
  return response.json();
}

export async function observePool({ config, dryRun = false, now = Date.now(), fetchImpl = fetch,
  file = POOL_SNAPSHOT, load = readRecord, save = writeDurableJson } = {}) {
  if (!config?.enabled) return null;
  const previous = await load(file), sample = { resources: previous?.resources, queue: previous?.queue, errors: [], terminals: [] };
  await Promise.all([
    ['resources', `${config.resourceUrl}${dryRun ? '' : '?refresh=1'}`, value => Array.isArray(value.machines)],
    ['queue', config.queueUrl, value => Array.isArray(value.runs)],
  ].map(async ([key, url, valid]) => {
    try {
      const value = await jsonFetch(fetchImpl, url);
      if (!valid(value)) throw Error('INVALID_SCHEMA');
      sample[key] = key === 'queue' ? { active: value.active, runs: value.runs.map(run => Object.fromEntries(
        ['run_id', 'state', 'generation', 'progress', 'admission', 'priority', 'created_at', 'spec_sha256', 'submitter', 'project_metadata'].filter(key => key in run).map(key => [key, run[key]]))),
        _readAt: new Date(now).toISOString() } : value;
    } catch { sample.errors.push(`${key}读取失败，保留上次成功时间`); }
  }));
  const absent = Object.entries(previous?.assessment?.tasks || {}).filter(([id, task]) => task.alerted
    && fresh(sample.queue?._readAt, now) && !sample.queue.runs.some(run => run.run_id === id));
  for (const [id] of absent) {
    try {
      const url = new URL(`/v1/runs/${encodeURIComponent(id)}`, config.queueUrl);
      const value = await jsonFetch(fetchImpl, url);
      const run = value.run || value;
      if (run.run_id === id) sample.terminals.push(run);
    } catch { sample.errors.push(`任务 ${id} 终态未核实`); }
  }
  const assessment = assessPool(previous?.assessment, sample, { now, ...config.thresholds });
  const result = { schema: 1, observedAt: new Date(now).toISOString(), ...sample, assessment, cloud: previous?.cloud || null };
  const cloudMachine = sample.resources?.machines?.find(machine => machine.cloudObservation);
  if (config.enrichmentScript && healthy(cloudMachine?.cloudObservation, now) && !dryRun) {
    // Reuse the existing receipt/training metadata reader with the shared quota input.
    // It does not run a second quota collector and cannot create or stop Jobs.
    const input = { jobs: cloudMachine.jobs || [], nodes: cloudMachine.nodes || [],
      cards: Array.from({ length: cloudMachine.quota?.total || 0 }, (_, i) => ({ id: `名额 ${i + 1}`, state: i < cloudMachine.quota.allocated ? 'used' : i < cloudMachine.quota.allocated + cloudMachine.quota.available ? 'free' : 'unknown' })),
      monitoringJobs: cloudMachine.monitoringJobs || [], observedAt: cloudMachine.cloudObservation.observedAt };
    try {
      const child = exec('python3', [config.enrichmentScript, '--snapshot-json', JSON.stringify(input)], { timeout: 28000, maxBuffer: 2 * 1024 * 1024 });
      result.cloud = JSON.parse((await child).stdout);
    } catch { result.errors.push('任务归属与训练进度补充失败，保留原记录'); }
  }
  if (!dryRun) await save(file, result);
  return result;
}
