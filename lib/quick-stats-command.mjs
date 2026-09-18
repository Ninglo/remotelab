import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CHAT_RUNS_DIR, CONFIG_DIR } from './config.mjs';

const METRICS = Object.freeze([
  'ingressToAcceptedMs',
  'acceptedToRunnerMs',
  'timeToFirstAnswerMs',
  'timeToCompleteMs',
  'modelRunMs',
  'answerReadyToDeliveredMs',
  'endToEndMs',
]);

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function listJsonRecords(directory) {
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return (await Promise.all(names.filter(name => name.endsWith('.json'))
    .map(name => readJson(join(directory, name))))).filter(Boolean);
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return NaN;
  if (/^\d{10,13}$/.test(raw)) {
    const parsed = Number(raw);
    return raw.length === 10 ? parsed * 1000 : parsed;
  }
  return Date.parse(raw);
}

function duration(start, end) {
  const startMs = timestamp(start);
  const endMs = timestamp(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? endMs - startMs
    : null;
}

async function findFirstAnswerAt(spoolPath) {
  let text;
  try { text = await readFile(spoolPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const item = record?.json?.item;
      if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.length > 0) {
        return record.ts || '';
      }
    } catch { /* Ignore a partial final spool line. */ }
  }
  return '';
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeMetric(samples, key) {
  const values = samples.map(sample => sample[key]).filter(Number.isFinite);
  return {
    n: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: values.length ? Math.min(...values) : null,
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function summarize(samples) {
  return Object.fromEntries(METRICS.map(metric => [metric, summarizeMetric(samples, metric)]));
}

export async function collectQuickSessionStats({
  days = 7,
  now = new Date(),
  configDir = CONFIG_DIR,
  runsDir = configDir === CONFIG_DIR ? CHAT_RUNS_DIR : join(configDir, 'chat-runs'),
} = {}) {
  const endMs = now instanceof Date ? now.getTime() : timestamp(now);
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const requestRoot = join(configDir, 'requests');
  const records = (await Promise.all([
    listJsonRecords(join(requestRoot, 'active')),
    listJsonRecords(join(requestRoot, 'archive')),
  ])).flat().filter(record => record?.options?.executionProfile === 'quick'
    && timestamp(record.acceptedAt) >= startMs
    && timestamp(record.acceptedAt) <= endMs);

  const samples = await Promise.all(records.map(async record => {
    const runRoot = join(runsDir, record.runId);
    const [status, firstAnswerAt] = await Promise.all([
      readJson(join(runRoot, 'status.json')),
      findFirstAnswerAt(join(runRoot, 'spool.jsonl')),
    ]);
    const sourceContext = record.options?.sourceContext || {};
    const source = sourceContext.connector || 'webui';
    const delivery = (record.deliveries || []).find(candidate => candidate.kind === 'content'
      && candidate.state === 'delivered' && candidate.deliveredAt);
    const completedAt = status?.completedAt || status?.result?.completedAt || record.settledAt;
    return {
      requestId: record.requestId,
      sessionId: record.sessionId,
      runId: record.runId,
      source,
      acceptedAt: record.acceptedAt,
      completedAt: completedAt || '',
      deliveredAt: delivery?.deliveredAt || '',
      ingressToAcceptedMs: duration(sourceContext.createTime, record.acceptedAt),
      acceptedToRunnerMs: duration(record.acceptedAt, status?.startedAt),
      timeToFirstAnswerMs: duration(record.acceptedAt, firstAnswerAt),
      timeToCompleteMs: duration(record.acceptedAt, completedAt),
      modelRunMs: duration(status?.startedAt, completedAt),
      answerReadyToDeliveredMs: duration(record.settledAt || completedAt, delivery?.deliveredAt),
      endToEndMs: duration(sourceContext.createTime || record.acceptedAt, delivery?.deliveredAt || completedAt),
    };
  }));

  const sources = [...new Set(samples.map(sample => sample.source))].sort();
  return {
    generatedAt: new Date(endMs).toISOString(),
    window: { days, startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString() },
    total: samples.length,
    overall: summarize(samples),
    bySource: Object.fromEntries(sources.map(source => [source, {
      total: samples.filter(sample => sample.source === source).length,
      metrics: summarize(samples.filter(sample => sample.source === source)),
    }])),
    samples: samples.sort((left, right) => timestamp(right.acceptedAt) - timestamp(left.acceptedAt)).slice(0, 50),
  };
}

function parseArgs(argv) {
  const options = { days: 7, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--days') {
      const days = Number.parseInt(argv[index + 1] || '', 10);
      if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('Invalid --days value');
      options.days = days;
      index += 1;
    } else if (argv[index] === '--json') options.json = true;
    else if (['--help', '-h'].includes(argv[index])) options.help = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(2)}s` : '—';
}

function renderGroup(label, total, metrics) {
  return [
    `${label}: ${total} turns`,
    `  accepted -> runner       p50 ${formatMs(metrics.acceptedToRunnerMs.p50Ms)}  p95 ${formatMs(metrics.acceptedToRunnerMs.p95Ms)}`,
    `  accepted -> first answer p50 ${formatMs(metrics.timeToFirstAnswerMs.p50Ms)}  p95 ${formatMs(metrics.timeToFirstAnswerMs.p95Ms)}`,
    `  accepted -> complete     p50 ${formatMs(metrics.timeToCompleteMs.p50Ms)}  p95 ${formatMs(metrics.timeToCompleteMs.p95Ms)}`,
    `  ready -> delivered       p50 ${formatMs(metrics.answerReadyToDeliveredMs.p50Ms)}  p95 ${formatMs(metrics.answerReadyToDeliveredMs.p95Ms)}`,
    `  source -> end            p50 ${formatMs(metrics.endToEndMs.p50Ms)}  p95 ${formatMs(metrics.endToEndMs.p95Ms)}`,
  ].join('\n');
}

export async function runQuickStatsCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write('Usage: remotelab quick-stats [--days N] [--json]\n');
    return 0;
  }
  const stats = await collectQuickSessionStats({ days: options.days });
  if (options.json) stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  else {
    const groups = [renderGroup('Quick overall', stats.total, stats.overall),
      ...Object.entries(stats.bySource).map(([source, group]) => renderGroup(`Quick ${source}`, group.total, group.metrics))];
    stdout.write(`${groups.join('\n\n')}\nWindow: ${stats.window.startAt} -> ${stats.window.endAt}\n`);
  }
  return 0;
}
