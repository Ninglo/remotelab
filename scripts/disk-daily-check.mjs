// Deterministic daily evidence. Repairs and notifications stay with the existing observer.
import { statfs, stat, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { CONFIG_DIR } from '../lib/config.mjs';
import { writeDurableJson } from '../lib/durable-records.mjs';
import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';
import { renderMonitoringReport } from '../lib/monitoring-report.mjs';
const exec = promisify(execFile), GiB = 1024 ** 3;
const writeDurableText = async (file, value) => { const temp = file + '.' + process.pid + '.tmp'; await writeFile(temp, value, {mode:0o600}); await rename(temp, file); };
const args = process.argv.slice(2), output = args[args.indexOf('--output-dir') + 1];
if (!args.includes('--output-dir') || !output) throw Error('OUTPUT_DIR_REQUIRED');
const root = resolve(output), reports = join(root, 'reports'), at = new Date().toISOString();
const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const read = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const previous = await read(join(root, 'latest.json'));
await mkdir(reports, { recursive: true, mode: 0o700 });
const volumes = Object.fromEntries(await Promise.all(['/', '/data'].map(async path => {
  try {
    const [fs, st, mount] = await Promise.all([statfs(path), stat(path), exec('findmnt', ['-J', '-T', path, '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS'], { timeout: 3000, maxBuffer: 8192 })]);
    const mountInfo = JSON.parse(mount.stdout).filesystems?.[0] || null;
    const usedBytes = (fs.blocks - fs.bfree) * fs.bsize, availableBytes = fs.bavail * fs.bsize;
    const usedPercent = 100 * usedBytes / (usedBytes + availableBytes), inodeUsedPercent = fs.files ? 100 * (fs.files - fs.ffree) / fs.files : null;
    return [path, { observedAt: at, status: usedPercent >= 85 || inodeUsedPercent >= 85 || availableBytes < (path === '/' ? 15 : 50) * GiB ? 'warning' : 'healthy',
      totalBytes: fs.blocks * fs.bsize, usedBytes, availableBytes, usedPercent, inodeUsedPercent, statDevice: st.dev, writable: !!mountInfo?.options?.split(',').includes('rw'), mount: mountInfo }];
  } catch (error) { return [path, { observedAt: at, status: 'unknown', error: error.code || error.name }]; }
})));
let snapshot = null, snapshotError = null;
try {
  const result = await createRemoteLabHttpClient().request('/api/monitoring/overview?days=1', { signal: AbortSignal.timeout(10_000) });
  if (!result.response.ok || !result.json?.generatedAt) throw Error('OVERVIEW_UNAVAILABLE');
  snapshot = result.json;
} catch (error) { snapshotError = error.code || error.name; }
const comparison = Object.fromEntries(Object.entries(volumes).map(([path, current]) => [path,
  Number.isFinite(current.usedBytes) && Number.isFinite(previous?.volumes?.[path]?.usedBytes)
    && current.statDevice === previous.volumes[path].statDevice
    ? { usedBytesDelta: current.usedBytes - previous.volumes[path].usedBytes, since: previous.timestamp } : null]));
const independent = Number.isFinite(volumes['/'].statDevice) && Number.isFinite(volumes['/data'].statDevice)
  ? volumes['/'].statDevice !== volumes['/data'].statDevice : null;
const report = { schema: 2, kind: 'script_daily_disk_check', timestamp: at, scheduledDate: day, hostname: hostname(), uid: process.getuid?.(),
  volumes, dataMountIndependentWritable: independent === null ? null : independent && volumes['/data'].writable === true,
  previousTimestamp: previous?.timestamp || null, comparisonSincePrevious: comparison,
  services: snapshot?.services || null, monitoringObservedAt: snapshot?.generatedAt || null, snapshotError,
  directoryGrowth: snapshot?.diskGrowth || null,
  actions: [], migrationPerformed: false, serviceRestartPerformed: false,
  maintenance: { owner: 'existing-minute-observer', recoveryFile: join(CONFIG_DIR, 'monitoring-recovery.json'),
    note: '容量与增长风险沿原观察器执行已授权低风险脚本；本日程只保存证据，不另启动Agent或重复清理。' },
  risks: [...Object.entries(volumes).filter(([,v]) => v.status !== 'healthy').map(([path,v]) => ({ path, status: v.status })),
    ...(independent === false ? [{ path: '/data', status: 'not_independent' }] : []), ...(snapshotError ? [{ source: 'monitoring', status: 'unavailable' }] : [])],
  delivery: { mode: 'existing_daily_report', separateMessage: false } };
// Preserve the last Agent-produced baseline once before switching the pointer.
if (previous && previous.kind !== report.kind) await writeDurableJson(join(reports, `${day}-before-script.json`), previous);
const lines = [`# ${day} 磁盘检查`, '', `采样：${at}`, '', '| 路径 | 已用 | 可用 GiB | inode 已用 | 状态 |', '|---|---:|---:|---:|---|',
  ...Object.entries(volumes).map(([path,v]) => `| ${path} | ${Number.isFinite(v.usedPercent) ? v.usedPercent.toFixed(1)+'%' : '未知'} | ${Number.isFinite(v.availableBytes) ? (v.availableBytes/GiB).toFixed(2) : '未知'} | ${Number.isFinite(v.inodeUsedPercent) ? v.inodeUsedPercent.toFixed(1)+'%' : '未知'} | ${v.status} |`), '',
  `独立数据盘：${independent === null ? '未知' : independent ? '是' : '否'}。本轮未执行清理、迁移或重启；处置证据沿现有分钟观察器。`,
  `监管来源：${snapshot?.generatedAt || '读取失败：'+snapshotError}；目录增长复用已有采样，未全盘扫描。`, ''];
await writeDurableJson(join(reports, `${day}-script.json`), report);
await writeDurableText(join(reports, `${day}-script.md`), lines.join('\n'));
if (snapshot) {
  await writeDurableJson(join(reports, 'monitoring-latest.json'), snapshot);
  await writeDurableText(join(reports, 'monitoring-latest.md'), renderMonitoringReport(snapshot));
}
await writeDurableJson(join(root, 'latest.json'), report);
await writeDurableJson(join(reports, 'latest.json'), report);
console.log(JSON.stringify({ trigger: false, reason: 'daily_disk_evidence_saved_existing_observer_owns_repairs', report: join(reports, `${day}-script.json`), risks: report.risks.length }));
