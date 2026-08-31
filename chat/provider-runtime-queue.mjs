import { randomUUID } from 'crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_OWNER_WRITE_GRACE_MS = 10_000;
const DEFAULT_SERIAL_RUNTIME_KEYS = new Set(['pi-json:moonshotai']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizePathPart(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseConfiguredRuntimeKeys(value) {
  if (value === undefined) return DEFAULT_SERIAL_RUNTIME_KEYS;
  return new Set(String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean));
}

export function resolveProviderRuntimeQueueKey(invocation = {}, env = process.env) {
  const runtimeFamily = trimString(invocation.runtimeFamily).toLowerCase();
  const provider = trimString(invocation.provider).toLowerCase();
  if (!runtimeFamily || !provider) return '';
  const runtimeKey = `${runtimeFamily}:${provider}`;
  const configuredKeys = parseConfiguredRuntimeKeys(env?.REMOTELAB_SERIAL_PROVIDER_RUNTIMES);
  return configuredKeys.has(runtimeKey) ? runtimeKey : '';
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function readOwner(ownerPath) {
  try {
    return JSON.parse(await readFile(ownerPath, 'utf8'));
  } catch {
    return null;
  }
}

async function lockIsStale(lockDir, ownerPath, {
  isProcessAlive = processIsAlive,
  ownerWriteGraceMs = DEFAULT_OWNER_WRITE_GRACE_MS,
} = {}) {
  const owner = await readOwner(ownerPath);
  if (owner) {
    const sidecarAlive = isProcessAlive(Number(owner.sidecarPid));
    const toolAlive = isProcessAlive(Number(owner.toolProcessId));
    return !sidecarAlive && !toolAlive;
  }

  try {
    const metadata = await stat(lockDir);
    return (Date.now() - metadata.mtimeMs) >= ownerWriteGraceMs;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

export async function acquireProviderRuntimeLease({
  queueKey,
  runId,
  rootDir = join(tmpdir(), `remotelab-provider-runtime-queue-${process.getuid?.() ?? 'user'}`),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ownerWriteGraceMs = DEFAULT_OWNER_WRITE_GRACE_MS,
  isCancelled = () => false,
  isProcessAlive = processIsAlive,
  onWait = null,
} = {}) {
  const normalizedKey = sanitizePathPart(queueKey);
  if (!normalizedKey) return null;

  const queueDir = join(rootDir, normalizedKey);
  const lockDir = join(queueDir, 'active.lock');
  const ownerPath = join(lockDir, 'owner.json');
  const leaseId = randomUUID();
  const owner = {
    leaseId,
    queueKey: trimString(queueKey),
    runId: trimString(runId),
    sidecarPid: process.pid,
    toolProcessId: null,
    acquiredAt: '',
  };
  let waitNotified = false;

  await mkdir(queueDir, { recursive: true, mode: 0o700 });

  while (true) {
    if (await isCancelled()) {
      const error = new Error(`Provider runtime queue wait cancelled for ${queueKey}`);
      error.code = 'PROVIDER_RUNTIME_QUEUE_CANCELLED';
      throw error;
    }

    try {
      await mkdir(lockDir, { mode: 0o700 });
      owner.acquiredAt = new Date().toISOString();
      await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await lockIsStale(lockDir, ownerPath, { isProcessAlive, ownerWriteGraceMs })) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (!waitNotified) {
        waitNotified = true;
        await onWait?.({ queueKey, runId });
      }
      await delay(Math.max(10, pollIntervalMs));
    }
  }

  const ownsLease = async () => (await readOwner(ownerPath))?.leaseId === leaseId;
  return {
    queueKey: trimString(queueKey),
    acquiredAt: owner.acquiredAt,
    waited: waitNotified,
    async setToolProcessId(toolProcessId) {
      if (!await ownsLease()) return false;
      owner.toolProcessId = Number.isInteger(toolProcessId) && toolProcessId > 0
        ? toolProcessId
        : null;
      await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
      return true;
    },
    async release() {
      if (!await ownsLease()) return false;
      await rm(lockDir, { recursive: true, force: true });
      return true;
    },
  };
}
