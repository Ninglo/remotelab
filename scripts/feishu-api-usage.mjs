#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/feishu-api-usage.mjs [--days 7] [--directory <log-dir>]\nCounts observed SDK requests, not the Feishu tenant billing total.');
  process.exit(0);
}
let days = 7, directory = join(CONFIG_DIR, 'feishu-api-logs');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days') days = Number(args[++i]);
  else if (args[i] === '--directory') directory = args[++i];
  else throw new Error(`Unknown option: ${args[i]}`);
}
if (!Number.isInteger(days) || days < 1 || days > 31 || !directory) throw new Error('days must be 1–31 and directory must be provided');
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const names = (await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
  .filter(name => /^\d{4}-\d{2}-\d{2}\.\d+\.[a-f0-9]+\.\d+\.jsonl$/.test(name) && name.slice(0, 10) >= since.slice(0, 10));
const totals = { calls: 0, success: 0, failed: 0, unknown: 0 }, groups = new Map();
let invalidLines = 0;
for (const name of names) {
  const lines = createInterface({ input: createReadStream(join(directory, name)), crlfDelay: Infinity });
  for await (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { invalidLines++; continue; }
    if (row.type !== 'feishu_api_call' || typeof row.ts !== 'string' || row.ts < since) continue;
    totals.calls++;
    if (row.outcome === 'success') totals.success++;
    else if (row.outcome === 'unknown') totals.unknown++;
    else totals.failed++;
    const key = JSON.stringify([row.appId, row.sourceRouteId, row.component, row.method, row.endpoint]);
    const group = groups.get(key) || { appId: row.appId, sourceRouteId: row.sourceRouteId,
      component: row.component, method: row.method, endpoint: row.endpoint, calls: 0, failed: 0,
      durationMs: 0, codes: {} };
    group.calls++; group.durationMs += row.durationMs || 0;
    if (!['success', 'unknown'].includes(row.outcome)) group.failed++;
    const code = row.code ?? row.errorCode; group.codes[code] = (group.codes[code] || 0) + 1;
    groups.set(key, group);
  }
}
console.log(JSON.stringify({ since, directory, files: names.length, invalidLines, totals,
  coverage: 'Connector/workboard SDK and display requests; direct lark-cli, other instances and billing eligibility are not inferred',
  byEndpoint: [...groups.values()].sort((a, b) => b.calls - a.calls).map(group => ({ ...group,
    averageDurationMs: Math.round(group.durationMs / group.calls) })) }, null, 2));
