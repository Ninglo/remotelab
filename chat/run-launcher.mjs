import { execFile as execFileCallback, spawn as spawnProcess } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { CHAT_PORT } from '../lib/config.mjs';
import { serializeUserShellEnvSnapshot } from '../lib/user-shell-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerEntry = join(__dirname, 'runner-sidecar.mjs');
const execFileAsync = promisify(execFileCallback);
const SYSTEMD_MAIN_PID_RETRIES = 8;
const SYSTEMD_MAIN_PID_RETRY_DELAY_MS = 50;

export const DETACHED_RUNNER_PROCESS_LAUNCH_MODE = 'detached-process';
export const DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE = 'systemd-transient-service';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSystemdMainPid(value) {
  const pid = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function sanitizeSystemdUnitFragment(value) {
  const normalized = String(value || '').trim().replace(/[^A-Za-z0-9:_.@-]+/g, '_');
  return normalized || 'unknown';
}

export function buildDetachedRunnerUnitName(runId) {
  return `remotelab-runner-${sanitizeSystemdUnitFragment(runId)}`;
}

export function detectSystemdManagerScope(cgroupText) {
  const text = String(cgroupText || '');
  if (/(^|\n)\d+::\/system\.slice\/[^\n]+\.service(?:\n|$)/.test(text)) {
    return 'system';
  }
  if (/(^|\n)\d+::\/user\.slice\/.*\/[^\n]+\.service(?:\n|$)/.test(text)) {
    return 'user';
  }
  return null;
}

export function getCurrentSystemdManagerScope({
  platform = process.platform,
  readFileSyncImpl = readFileSync,
} = {}) {
  if (platform !== 'linux') return null;
  try {
    return detectSystemdManagerScope(readFileSyncImpl('/proc/self/cgroup', 'utf8'));
  } catch {
    return null;
  }
}

export function shouldUseSystemdDetachedRunner({
  platform = process.platform,
  env = process.env,
  scope = getCurrentSystemdManagerScope({ platform }),
} = {}) {
  return platform === 'linux'
    && env?.REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER !== '1'
    && (scope === 'system' || scope === 'user');
}

function buildDetachedRunnerEnvironment({ launchMode, unitName = null, unitScope = null } = {}) {
  const env = {
    ...process.env,
    REMOTELAB_CHAT_BASE_URL: `http://127.0.0.1:${CHAT_PORT}`,
    REMOTELAB_USER_SHELL_ENV_B64: serializeUserShellEnvSnapshot(),
    REMOTELAB_RUNNER_LAUNCH_MODE: launchMode || DETACHED_RUNNER_PROCESS_LAUNCH_MODE,
  };
  if (unitName) {
    env.REMOTELAB_RUNNER_UNIT_NAME = unitName;
  }
  if (unitScope) {
    env.REMOTELAB_RUNNER_UNIT_SCOPE = unitScope;
  }
  return env;
}

function appendSystemdEnvironmentArgs(args, env) {
  for (const [key, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value === undefined || value === null) continue;
    const normalized = String(value);
    if (normalized.includes('\0')) continue;
    args.push('--setenv', `${key}=${normalized}`);
  }
}

function buildSystemctlArgs(scope, ...args) {
  return scope === 'user'
    ? ['--user', ...args]
    : args;
}

function buildSystemdRunArgs(scope, ...args) {
  return scope === 'user'
    ? ['--user', ...args]
    : args;
}

export async function readSystemdUnitMainPid(unitName, {
  scope = 'system',
  execFileImpl = execFileAsync,
  retries = SYSTEMD_MAIN_PID_RETRIES,
  retryDelayMs = SYSTEMD_MAIN_PID_RETRY_DELAY_MS,
} = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const { stdout } = await execFileImpl(
        'systemctl',
        buildSystemctlArgs(scope, 'show', '--property=MainPID', '--value', unitName),
        { timeout: 2_000, maxBuffer: 128 * 1024 },
      );
      const pid = parseSystemdMainPid(stdout);
      if (pid) {
        return pid;
      }
    } catch {
      // Retry a few times while systemd populates the transient unit metadata.
    }
    if (attempt < (retries - 1)) {
      await sleep(retryDelayMs);
    }
  }
  return null;
}

export async function launchDetachedRunnerViaSystemd(runId, {
  scope = getCurrentSystemdManagerScope(),
  execFileImpl = execFileAsync,
  unitName = buildDetachedRunnerUnitName(runId),
  workingDirectory = process.cwd(),
  processExecPath = process.execPath,
  runnerScriptPath = runnerEntry,
} = {}) {
  const launchMode = DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE;
  const env = buildDetachedRunnerEnvironment({ launchMode, unitName, unitScope: scope });
  const args = [
    ...buildSystemdRunArgs(scope),
    '--quiet',
    '--collect',
    '--no-block',
    '--service-type=exec',
    '--unit',
    unitName,
    '--working-directory',
    workingDirectory,
    '--description',
    `RemoteLab detached runner ${runId}`,
  ];
  appendSystemdEnvironmentArgs(args, env);
  args.push(processExecPath, runnerScriptPath, runId);
  await execFileImpl('systemd-run', args, {
    env,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  const pid = await readSystemdUnitMainPid(unitName, { scope, execFileImpl });
  return {
    pid,
    unitName,
    unitScope: scope,
    launchMode,
  };
}

export function spawnDetachedRunnerAsProcess(runId, {
  spawnImpl = spawnProcess,
  processExecPath = process.execPath,
  runnerScriptPath = runnerEntry,
} = {}) {
  const launchMode = DETACHED_RUNNER_PROCESS_LAUNCH_MODE;
  const env = buildDetachedRunnerEnvironment({ launchMode });
  const child = spawnImpl(processExecPath, [runnerScriptPath, runId], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref?.();
  return {
    pid: child.pid ?? null,
    unitName: null,
    unitScope: null,
    launchMode,
  };
}

export function createDetachedRunnerSpawner({
  execFileImpl = execFileAsync,
  spawnImpl = spawnProcess,
  getScopeImpl = getCurrentSystemdManagerScope,
} = {}) {
  return async function spawnDetachedRunner(runId) {
    const scope = getScopeImpl();
    if (shouldUseSystemdDetachedRunner({ scope })) {
      try {
        return await launchDetachedRunnerViaSystemd(runId, { scope, execFileImpl });
      } catch (error) {
        console.error(`[runs] Failed to launch detached runner ${runId} via systemd-run (${scope}): ${error?.message || String(error)}; falling back to plain detached process.`);
      }
    }
    return spawnDetachedRunnerAsProcess(runId, { spawnImpl });
  };
}

export const spawnDetachedRunner = createDetachedRunnerSpawner();
