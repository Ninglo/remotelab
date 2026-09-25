import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR, PUBLIC_BASE_URL } from './config.mjs';

const configPath = join(CONFIG_DIR, 'langsmith-case-link.json');

export async function readLangSmithCaseConfig() {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (config?.enabled !== true) return null;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(config.stateDir || '')) throw new Error('Invalid LangSmith stateDir');
  if (!/^[0-9a-f-]{36}$/.test(config.projectId || '')) throw new Error('Invalid LangSmith projectId');
  return config;
}

export function buildLangSmithCaseEntry(session, config, { publicBaseUrl = PUBLIC_BASE_URL, runId = '' } = {}) {
  if (!config || session?.tool !== 'codex' || !/^[0-9a-f]{32}$/.test(session?.id || '')) return null;
  const base = String(publicBaseUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  const query = /^run_[a-zA-Z0-9_-]+$/.test(runId) ? `?runId=${encodeURIComponent(runId)}` : '';
  return { label: '查看 Agent Case', url: `${base}/api/sessions/${session.id}/langsmith${query}` };
}

export async function getLatestLangSmithCase(sessionId, config, { runId = '' } = {}) {
  if (!config || !/^[0-9a-f]{32}$/.test(sessionId)) return null;
  let state;
  try { state = JSON.parse(await readFile(join(CONFIG_DIR, config.stateDir, 'state.json'), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (state?.projectId !== config.projectId) return null;
  const latest = state?.tracked?.[sessionId]?.latestSnapshot;
  if (!latest || !Number.isSafeInteger(latest.revision) || latest.revision < 1) return null;
  const url = new URL(latest.rootUrl);
  if (url.protocol !== 'https:' || !['smith.langchain.com', 'eu.smith.langchain.com'].includes(url.hostname)
    || !url.pathname.includes(`/projects/p/${config.projectId}/`)) return null;
  const nodeId = /^run_[a-zA-Z0-9_-]+$/.test(runId) ? latest.runNodeIds?.[runId] : null;
  if (nodeId && /^[0-9a-f-]{36}$/.test(nodeId))
    url.pathname = url.pathname.replace(/\/run\/[0-9a-f-]{36}$/, `/run/${nodeId}`);
  return { url: url.href, traceId: latest.traceId, revision: latest.revision, syncedAt: latest.syncedAt };
}
