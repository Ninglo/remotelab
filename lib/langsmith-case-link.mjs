import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

const configPath = join(CONFIG_DIR, 'langsmith-case-link.json');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function readLangSmithCaseConfig() {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (config?.enabled !== true) return null;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(config.stateDir || '')) throw new Error('Invalid LangSmith stateDir');
  for (const key of ['backfillStateDir', 'historyStateDir']) {
    if (config[key] && !/^[a-zA-Z0-9_-]{1,100}$/.test(config[key]))
      throw new Error(`Invalid LangSmith ${key}`);
  }
  if (!uuid.test(config.projectId || '')) throw new Error('Invalid LangSmith projectId');
  if (config.workspaceId && !uuid.test(config.workspaceId)) throw new Error('Invalid LangSmith workspaceId');
  return config;
}

export async function getLatestLangSmithCase(sessionId, config, { runId = '' } = {}) {
  const result = await getLangSmithCaseStatus(sessionId, config, { runId });
  return result.url ? result : null;
}

export async function getLangSmithCaseStatus(sessionId, config, { runId = '' } = {}) {
  if (!config) return { status: 'disabled' };
  if (!/^[0-9a-f]{32}$/.test(sessionId)) return { status: 'missing' };
  const candidates = [];
  const statuses = new Set();
  let unavailable = false;
  for (const dir of [config.stateDir, config.backfillStateDir, config.historyStateDir].filter(Boolean)) {
    let state;
    try { state = JSON.parse(await readFile(join(CONFIG_DIR, dir, 'state.json'), 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') unavailable = true; continue; }
    if (state?.projectId !== config.projectId) { unavailable = true; continue; }
    const record = state?.tracked?.[sessionId] || state?.sessions?.[sessionId];
    if (!record) continue;
    statuses.add(record.status || (record.lastError ? 'failed' : 'pending'));
    const snapshot = record.latestSnapshot;
    if (!snapshot) continue;
    try {
      const url = new URL(snapshot.rootUrl);
      // Accept only a concrete root run in the configured project. Both URL
      // forms are returned by LangSmith; a project overview is not a case link.
      const path = url.pathname.match(/^\/o\/([^/]+)\/projects\/p\/([^/]+)\/(?:r\/([^/]+)|trace\/([^/]+)\/run\/([^/]+))$/);
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
        || url.protocol !== 'https:' || url.username || url.password
        || !['smith.langchain.com', 'eu.smith.langchain.com'].includes(url.hostname)
        || !uuid.test(snapshot.traceId || '') || !path || path[2] !== config.projectId
        || (config.workspaceId && path[1] !== config.workspaceId)
        || (path[3] || path[5]) !== snapshot.traceId
        || (path[4] && path[4] !== snapshot.traceId)
        || (url.searchParams.has('trace_id') && url.searchParams.get('trace_id') !== snapshot.traceId)) {
        unavailable = true;
        continue;
      }
      candidates.push(snapshot);
    } catch { unavailable = true; }
  }
  const latest = candidates.sort((a,b) => (b.runIds?.length || 0) - (a.runIds?.length || 0)
    || String(b.syncedAt || '').localeCompare(String(a.syncedAt || '')))[0];
  if (!latest) {
    const status = ['waiting', 'pending', 'unsupported_timestamp', 'unsupported', 'failed', 'empty']
      .find(value => statuses.has(value));
    return { status: status || (unavailable || statuses.size ? 'unavailable' : 'missing') };
  }
  const url = new URL(latest.rootUrl);
  const nodeId = /^run_[a-zA-Z0-9_-]+$/.test(runId) ? latest.runNodeIds?.[runId] : null;
  if (nodeId && uuid.test(nodeId))
    url.pathname = url.pathname.replace(/\/(r|run)\/[^/]+$/, `/$1/${nodeId}`);
  return { status: 'available', url: url.href, traceId: latest.traceId, revision: latest.revision,
    syncedAt: latest.syncedAt, kind: latest.kind === 'historical_import' ? 'historical_import' : 'trace' };
}
