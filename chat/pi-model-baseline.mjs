import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { PI_AGENT_DIR } from '../lib/config.mjs';
import { getPiBaselineModels } from '../lib/codex-model-catalog.mjs';
import { acquireProviderRuntimeLease } from './provider-runtime-queue.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergePiBaselineConfig(config) {
  if (!isObject(config) || (config.providers !== undefined && !isObject(config.providers))) {
    throw new Error('Invalid Pi models.json: expected a providers object');
  }
  const providers = config.providers || {};
  const provider = providers['openai-codex'] === undefined ? {} : providers['openai-codex'];
  if (!isObject(provider) || (provider.models !== undefined && !Array.isArray(provider.models))) {
    throw new Error('Invalid Pi models.json: openai-codex.models must be an array');
  }
  const models = provider.models || [];
  const existingIds = new Set(models.map((model) => model?.id));
  const missing = getPiBaselineModels().filter((model) => !existingIds.has(model.id));
  if (missing.length === 0) return config;
  // Add missing definitions only. Keep user endpoints, credentials, overrides,
  // custom models and other providers untouched; Pi merges native models itself.
  return {
    ...config,
    providers: {
      ...providers,
      'openai-codex': { ...provider, models: [...models, ...missing] },
    },
  };
}

export async function ensurePiModelBaseline(agentDir = PI_AGENT_DIR) {
  const dir = resolve(agentDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  // Discovery and detached runners are separate processes. Share a short,
  // crash-recoverable lease for their read/modify/write window.
  const lease = await acquireProviderRuntimeLease({
    queueKey: 'pi-model-baseline',
    rootDir: join(dir, '.remotelab-locks'),
    isCancelled: () => Date.now() >= deadline,
    pollIntervalMs: 25,
  });
  const path = join(dir, 'models.json');
  const tempPath = `${path}.tmp-${randomUUID()}`;
  try {
    let original = null;
    try {
      original = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const config = original === null ? {} : JSON.parse(original);
    const merged = mergePiBaselineConfig(config);
    if (merged === config) return;
    await writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path);
  } finally {
    try {
      await rm(tempPath, { force: true });
    } finally {
      await lease.release();
    }
  }
}
