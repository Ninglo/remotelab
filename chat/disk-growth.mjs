import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';

const GiB = 1024 ** 3, minute = 60_000, hour = 60 * minute;
export const DISK_GROWTH_FILE = join(CONFIG_DIR, 'disk-growth-history.json');
export const diskGrowthDefaults = {
  paths: ['/'], windows: [{ minutes: 15, bytes: GiB }, { minutes: 60, bytes: 2 * GiB }, { minutes: 1440, bytes: 5 * GiB }],
  reserveBytes: 15 * GiB, forecastHours: 72, minimumForecastMinutes: 60, minimumForecastBytes: GiB / 4,
};
const valid = sample => sample && typeof sample.path === 'string' && sample.filesystemId != null
  && Number.isFinite(sample.totalBytes) && sample.totalBytes > 0
  && Number.isFinite(sample.availableBytes) && sample.availableBytes >= 0
  && Number.isFinite(Date.parse(sample.observedAt));
const same = (a, b) => a.path === b.path && a.filesystemId === b.filesystemId && a.totalBytes === b.totalBytes;

// Capacity status is unchanged. Growth is a separate, opt-in observation.
export function assessDiskGrowth(disks, history, config, now = Date.now()) {
  if (config?.enabled !== true) return [];
  const settings = { ...diskGrowthDefaults, ...config };
  return disks.filter(d => settings.paths.includes(d.path)).map(disk => {
    const row = { path: disk.path, label: disk.label, observedAt: disk.observedAt, status: 'unknown' };
    const at = Date.parse(disk.observedAt);
    if (!valid(disk) || at > now + 5000 || now - at > 3 * minute || disk.status === 'unknown') return row;
    const samples = (history?.samples || []).filter(p => valid(p) && same(p, disk)
      && Date.parse(p.observedAt) <= at - minute && Date.parse(p.observedAt) >= at - 24 * hour);
    if (!samples.length) return row;
    const change = p => ({ baselineAt: p.observedAt, elapsedMinutes: (at - Date.parse(p.observedAt)) / minute,
      growthBytes: p.availableBytes - disk.availableBytes });
    for (const window of settings.windows) {
      const candidates = samples.filter(p => at - Date.parse(p.observedAt) <= window.minutes * minute);
      const baseline = candidates.sort((a, b) => b.availableBytes - a.availableBytes)[0];
      if (!baseline) continue;
      const growth = change(baseline);
      if (growth.growthBytes >= window.bytes) return { ...row, status: 'warning', rule: `window:${window.minutes}`,
        ...growth, detail: `${growth.elapsedMinutes.toFixed(0)}分钟净增 ${(growth.growthBytes / GiB).toFixed(2)} GiB；${window.minutes}分钟增长预警线 ${(window.bytes / GiB).toFixed(2)} GiB。` };
    }
    // A multi-hour measured net rate supports a dated forecast; no invented zero samples.
    const baseline = samples.filter(p => at - Date.parse(p.observedAt) >= settings.minimumForecastMinutes * minute)
      .sort((a, b) => Math.abs(at - Date.parse(a.observedAt) - 6 * hour) - Math.abs(at - Date.parse(b.observedAt) - 6 * hour))[0];
    if (baseline && disk.availableBytes > settings.reserveBytes) {
      const growth = change(baseline), bytesPerHour = growth.growthBytes / (growth.elapsedMinutes / 60);
      const hoursToReserve = (disk.availableBytes - settings.reserveBytes) / bytesPerHour;
      if (growth.growthBytes >= settings.minimumForecastBytes && hoursToReserve > 0 && hoursToReserve <= settings.forecastHours) {
        return { ...row, status: 'warning', rule: 'forecast', ...growth, bytesPerHour, hoursToReserve,
          detail: `${(growth.elapsedMinutes / 60).toFixed(1)}小时净增 ${(growth.growthBytes / GiB).toFixed(2)} GiB；按此净增长速度，约 ${hoursToReserve.toFixed(1)}小时触及 ${(settings.reserveBytes / GiB).toFixed(0)} GiB余量。` };
      }
    }
    return { ...row, status: 'healthy' };
  });
}

export function diskGrowthAttention(rows, disks) {
  return rows.filter(row => row.status === 'warning').map(row => {
    const disk = disks.find(d => d.path === row.path);
    return { kind: 'diskGrowth', id: row.path, subject: row.label, severity: 'warning', detail: row.detail,
      availableBytes: disk.availableBytes, usedPercent: disk.usedPercent, growth: row,
      // Stable rule identity avoids a new edit/confirmation for every byte fluctuation.
      signals: { growthRule: row.rule } };
  });
}

export async function recordDiskSamples(disks, config, { file = DISK_GROWTH_FILE, load = readRecord, save = writeDurableJson, now = Date.now() } = {}) {
  if (config?.enabled !== true) return;
  const paths = config.paths || diskGrowthDefaults.paths;
  const current = disks.filter(d => paths.includes(d.path) && valid(d) && d.status !== 'unknown'
    && Date.parse(d.observedAt) <= now + 5000 && now - Date.parse(d.observedAt) < 3 * minute)
    .map(({ path, filesystemId, totalBytes, availableBytes, observedAt }) => ({ path, filesystemId, totalBytes, availableBytes, observedAt }));
  const previous = await load(file);
  const samples = (previous?.samples || []).filter(p => valid(p) && Date.parse(p.observedAt) >= now - 48 * hour
    && Date.parse(p.observedAt) <= now + 5000 && !current.some(c => same(c, p)
      && Math.floor(Date.parse(c.observedAt) / minute) === Math.floor(Date.parse(p.observedAt) / minute)));
  samples.push(...current);
  await save(file, { version: 1, observedAt: new Date(now).toISOString(), samples: samples.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).slice(-6000) });
}
