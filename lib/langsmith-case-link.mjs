import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

const configPath = join(CONFIG_DIR, 'langsmith-case-link.json');

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
  if (!/^[0-9a-f-]{36}$/.test(config.projectId || '')) throw new Error('Invalid LangSmith projectId');
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
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
        || url.protocol !== 'https:' || url.username || url.password
        || !['smith.langchain.com', 'eu.smith.langchain.com'].includes(url.hostname)
        || !url.pathname.includes(`/projects/p/${config.projectId}/`)) {
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
  if (nodeId && /^[0-9a-f-]{36}$/.test(nodeId))
    url.pathname = url.pathname.replace(/\/run\/[0-9a-f-]{36}$/, `/run/${nodeId}`);
  return { status: 'available', url: url.href, traceId: latest.traceId, revision: latest.revision,
    syncedAt: latest.syncedAt, kind: latest.kind === 'historical_import' ? 'historical_import' : 'trace' };
}
