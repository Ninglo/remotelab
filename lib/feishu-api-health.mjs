import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { feishuApiEndpoint } from './feishu-api-log.mjs';

const hour = 3_600_000;
const stamp = value => Date.parse(value || '') || 0;
const safeId = value => /^[\w.:-]{1,100}$/.test(value || '') ? value : 'unknown';

// Observe existing requests only. Opening the page or running the observer
// must never spend provider quota. Historical quota rejection survives idle
// periods, log rotation and restart until an operator verifies restoration.
export async function readFeishuApiHealth({ directory, config = {}, previous = {}, now = Date.now(),
  maxBytes = 32 * 1024 * 1024, maxFiles = 512 } = {}) {
  const providers = new Map();
  function provider(id) {
    if (!providers.has(id)) {
      const saved = previous.providers?.find(item => item.appId === id);
      providers.set(id, { id: `feishu:${id}`, appId: id,
        label: (config.apps || []).find(item => item.appId === id)?.label || '飞书 API',
        calls24h: 0, failed24h: 0, calls5m: 0, failed5m: 0, slow5m: 0,
        firstObservedAt: saved?.firstObservedAt || null, lastObservedAt: saved?.lastObservedAt || null,
        quotaRejectedAt: saved?.quotaRejectedAt || null, routes: new Set(), endpoints: new Map() });
    }
    return providers.get(id);
  }
  for (const item of config.apps || []) provider(safeId(item.appId));
  for (const item of previous.providers || []) if (item.quotaRejectedAt) provider(safeId(item.appId));
  const cutoff = new Date(now - 31 * 24 * hour).toISOString().slice(0, 10);
  const names = (await readdir(directory)).filter(name =>
    /^\d{4}-\d{2}-\d{2}\.\d+\.[a-f0-9]+\.\d+\.jsonl$/.test(name) && name.slice(0, 10) >= cutoff).sort().reverse();
  let scannedBytes = 0, invalidLines = 0, files = 0, complete = names.length <= maxFiles;
  for (const name of names.slice(0, maxFiles)) {
    const path = join(directory, name), info = await stat(path);
    if (scannedBytes + info.size > maxBytes) { complete = false; continue; }
    scannedBytes += info.size; files++;
    const input = createReadStream(path, { end: Math.max(0, info.size - 1) });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let row; try { row = JSON.parse(line); } catch { invalidLines++; continue; }
        const ts = stamp(row.ts);
        if (row.type !== 'feishu_api_call' || !ts || ts > now + 5000 || ts < now - 31 * 24 * hour) continue;
        const item = provider(safeId(row.appId));
        if (!item.firstObservedAt || ts < stamp(item.firstObservedAt)) item.firstObservedAt = row.ts;
        if (ts > stamp(item.lastObservedAt)) item.lastObservedAt = row.ts;
        item.routes.add(safeId(row.sourceRouteId));
        if (Number(row.code) === 99991403 && ts > stamp(item.quotaRejectedAt)) item.quotaRejectedAt = row.ts;
        const failed = !['success', 'unknown'].includes(row.outcome);
        if (ts >= now - 24 * hour) {
          item.calls24h++; if (failed) item.failed24h++;
          const key = `${safeId(row.method)} ${feishuApiEndpoint(row.endpoint)}`;
          const endpoint = item.endpoints.get(key) || { endpoint: key, calls: 0, failed: 0 };
          endpoint.calls++; if (failed) endpoint.failed++; item.endpoints.set(key, endpoint);
        }
        if (ts >= now - 300_000) {
          item.calls5m++; if (failed) item.failed5m++;
          if (Number(row.durationMs) >= 5000) item.slow5m++;
        }
      }
    } finally { lines.close(); input.destroy(); }
  }
  complete &&= invalidLines === 0;
  const burstLimit = Number(config.callsPer5m) > 0 ? Number(config.callsPer5m) : 100;
  const restoredAt = stamp(config.quotaRestoredAt);
  const items = [...providers.values()].map(item => {
    if (restoredAt <= now + 5000 && restoredAt > stamp(item.quotaRejectedAt) && config.quotaRestorationEvidence) item.quotaRejectedAt = null;
    const burst = item.calls5m >= burstLimit;
    const errors = item.failed5m >= 5 && item.failed5m / item.calls5m >= 0.2;
    const slow = item.slow5m >= 5 && item.slow5m / item.calls5m >= 0.2;
    return { ...item, routes: [...item.routes], endpoints: [...item.endpoints.values()].sort((a, b) => b.calls - a.calls).slice(0, 5),
      status: item.quotaRejectedAt ? 'quota_exhausted' : !complete || !item.lastObservedAt || now - stamp(item.lastObservedAt) > 15 * 60_000
        ? 'unknown' : burst || errors || slow ? 'degraded' : 'observed', burst, errors, slow,
      detail: item.quotaRejectedAt ? '月度 API 额度已拒绝调用；需管理员恢复并核验受影响接口，重启不能恢复额度'
        : burst ? `5 分钟已观察到 ${item.calls5m} 次调用，超过配置阈值 ${burstLimit}`
        : errors ? `5 分钟 ${item.failed5m}/${item.calls5m} 次调用失败，请核对接口与授权`
        : slow ? `5 分钟 ${item.slow5m} 次调用耗时至少 5 秒`
        : '仅反映已记录接口；没有新调用时保留未知，不主动探测' };
  });
  const quota = config.tenantQuota;
  const validQuota = quota?.source === 'feishu_admin' && quota?.evidence && stamp(quota.observedAt) <= now + 5000
    && now - stamp(quota.observedAt) <= 24 * hour && Number.isFinite(quota.used) && quota.used >= 0
    && Number.isFinite(quota.limit) && quota.limit > 0;
  return { observedAt: new Date(now).toISOString(), providers: items,
    tenantQuota: validQuota ? { used: quota.used, limit: quota.limit, observedAt: quota.observedAt,
      usedPercent: quota.used / quota.limit * 100 } : null,
    coverage: { complete, files, invalidLines, callsAreBillingTotal: false,
      detail: '本实例 SDK 与副屏已记录调用；直接 CLI、其他实例和计费归属未覆盖，企业剩余额度以管理员后台为准' } };
}

export function feishuApiAttention(health) {
  const events = (health?.providers || []).flatMap(item => item.status === 'quota_exhausted'
    ? [{ kind: 'api', severity: 'critical', id: `${item.id}:quota`, subject: item.label, code: 99991403, detail: item.detail }]
    : item.status === 'degraded' ? [{ kind: 'api', severity: 'critical', id: `${item.id}:traffic`, subject: item.label, detail: item.detail }] : []);
  if (health?.tenantQuota?.usedPercent >= 80) events.push({ kind: 'api', id: 'feishu:tenant-quota',
    subject: '飞书企业月度 API 额度', severity: health.tenantQuota.usedPercent >= 90 ? 'critical' : 'warning',
    detail: `管理员实测额度已用 ${health.tenantQuota.usedPercent.toFixed(1)}%，请提前处理容量` });
  return events;
}
