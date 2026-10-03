import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { renderMonitoringReport } from '../lib/monitoring-report.mjs';

const args = process.argv.slice(2);
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (args.includes('--help')) {
  console.log('Create the local monitoring source for an existing daily report.\nUsage: node scripts/monitoring-report.mjs --output <prefix> [--base-url <instance>] [--days 1|7|30]\nWrites JSON and Markdown; never publishes or sends a message.');
} else {
  const output = argument('--output', null), days = Number(argument('--days', '1'));
  if (!output || ![1, 7, 30].includes(days)) throw new Error('Provide --output and days 1, 7 or 30');
  const baseUrl = argument('--base-url', null);
  const { stdout } = await promisify(execFile)('remotelab', ['api', 'GET', `/api/monitoring/overview?days=${days}`,
    ...(baseUrl ? ['--base-url', baseUrl] : [])], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const snapshot = JSON.parse(stdout);
  if (!snapshot.generatedAt || !Array.isArray(snapshot.attention)) throw new Error('Monitoring response is unavailable');
  const prefix = resolve(output); await mkdir(dirname(prefix), { recursive: true });
  for (const [extension, body] of [['json', JSON.stringify(snapshot, null, 2)], ['md', renderMonitoringReport(snapshot)]]) {
    const temporary = `${prefix}.${extension}.${process.pid}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 }); await rename(temporary, `${prefix}.${extension}`);
  }
  console.log(JSON.stringify({ generatedAt: snapshot.generatedAt, risks: snapshot.attention.length,
    json: `${prefix}.json`, markdown: `${prefix}.md`, published: false }));
}
