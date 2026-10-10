import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

// An allowlist keeps opaque IDs, paths supplied by people, queries and payloads
// out of the ledger. Extend it when adding a new provider resource.
const routeWords = new Set(('open-apis auth im contact bot drive docx doc wiki bitable calendar task vc '
  + 'info messages read_users reply replies reactions batch_query chats members users files '
  + 'comments subscribe unsubscribe subscriptions documents blocks children tasks tasklists '
  + 'calendars events instances apps tables records fields views spaces nodes permissions '
  + 'public collaborators media images resources download upload batches batch_get bots join '
  + 'tenant_access_token app_access_token internal token access_token refresh_access_token '
  + 'search mget read_status primary instance_view authen oauth user_info device_authorization').split(' '));
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : 'unknown';
const numeric = value => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

export function feishuApiEndpoint(url) {
  try {
    const { pathname } = new URL(url, 'https://open.feishu.cn');
    return pathname.split('/').map(part => !part || routeWords.has(part) || /^v\d+$/.test(part) ? part : ':id').join('/');
  } catch { return 'unknown'; }
}

export function createFeishuApiLogger({ directory = join(CONFIG_DIR, 'feishu-api-logs'),
  appId, sourceRouteId, component = 'connector', now = () => new Date(),
  retentionDays = 31, maxFileBytes = 16 * 1024 * 1024, maxPending = 2048,
  onError = () => console.warn('[feishu-api-log] Call logging unavailable; API handling continues.') } = {}) {
  const writerId = `${process.pid}.${randomBytes(6).toString('hex')}`;
  let queue = Promise.resolve(), pending = 0, currentDate = '', segment = 0, bytes = 0, warned = false;
  const warn = () => { if (!warned) { warned = true; try { onError(); } catch { /* Fail open. */ } } };
  return {
    record(event) {
      if (pending >= maxPending) { warn(); return Promise.resolve(false); }
      // Select fields here too: callers cannot accidentally persist a request.
      const timestamp = new Date(event.ts);
      const record = { type: 'feishu_api_call', ts: Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : now().toISOString(), requestId: label(event.requestId),
        pid: process.pid, appId: label(appId), sourceRouteId: label(sourceRouteId), component: label(component),
        method: label(event.method), endpoint: feishuApiEndpoint(event.url),
        durationMs: Math.max(0, Math.round(Number(event.durationMs) || 0)),
        httpStatus: numeric(event.httpStatus), code: numeric(event.code), outcome: label(event.outcome),
        errorCode: label(event.errorCode), logId: label(event.logId) };
      const line = `${JSON.stringify(record)}\n`;
      pending++;
      const task = queue.then(async () => {
        const date = now().toISOString().slice(0, 10);
        if (date !== currentDate) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const cutoff = new Date(now().getTime() - retentionDays * 86_400_000).toISOString().slice(0, 10);
          for (const name of await readdir(directory)) {
            if (/^\d{4}-\d{2}-\d{2}\.\d+\.[a-f0-9]+\.\d+\.jsonl$/.test(name) && name.slice(0, 10) < cutoff)
              await rm(join(directory, name), { force: true });
          }
          currentDate = date; segment = 0; bytes = 0;
        }
        const size = Buffer.byteLength(line);
        if (bytes && bytes + size > maxFileBytes) { segment++; bytes = 0; }
        await appendFile(join(directory, `${currentDate}.${writerId}.${segment}.jsonl`), line, { mode: 0o600 });
        bytes += size;
        return true;
      }).catch(() => { warn(); return false; }).finally(() => { pending--; });
      queue = task;
      return task;
    },
    async flush() { await queue; },
  };
}
