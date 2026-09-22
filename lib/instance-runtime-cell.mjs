import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LARK_CLI_TIMEOUT_MS = 30_000;
const LARK_CLI_MAX_BUFFER = 4 * 1024 * 1024;
const LARK_CLI_CONFIG_LOCK_TIMEOUT_MS = 30_000;
const LARK_CLI_CONFIG_LOCK_STALE_MS = 60_000;
const LARK_CLI_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJsonFile(pathname) {
  try {
    return JSON.parse(await readFile(pathname, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeStaleLock(lockPath) {
  try {
    const [lockStat, lockText] = await Promise.all([
      stat(lockPath),
      readFile(lockPath, 'utf8').catch(() => ''),
    ]);
    let ownerPid = 0;
    try {
      ownerPid = Number.parseInt(JSON.parse(lockText)?.pid, 10) || 0;
    } catch {}
    const staleByAge = Date.now() - lockStat.mtimeMs > LARK_CLI_CONFIG_LOCK_STALE_MS;
    if ((ownerPid && !isProcessAlive(ownerPid)) || (!ownerPid && staleByAge)) {
      await unlink(lockPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      return true;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  return false;
}

async function acquireConfigLock(configDir) {
  const locksDir = join(configDir, 'locks');
  const lockPath = join(locksDir, 'remotelab-profile-config.lock');
  await mkdir(locksDir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LARK_CLI_CONFIG_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      await handle.close();
      return async () => {
        await unlink(lockPath).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the instance lark-cli config lock: ${lockPath}`);
      }
      await delay(50);
    }
  }
}

async function writeJsonAtomically(pathname, value) {
  const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, pathname);
    await chmod(pathname, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

async function mergeLegacyUsers({ configDir, legacyConfigDir, appId }) {
  if (!trimString(legacyConfigDir) || resolve(legacyConfigDir) === configDir) return 0;
  const targetPath = join(configDir, 'config.json');
  const legacyPath = join(resolve(legacyConfigDir), 'config.json');
  const [targetConfig, legacyConfig] = await Promise.all([
    readJsonFile(targetPath),
    readJsonFile(legacyPath),
  ]);
  if (!targetConfig || !legacyConfig) return 0;
  const targetApp = Array.isArray(targetConfig.apps)
    ? targetConfig.apps.find((app) => trimString(app?.appId) === appId)
    : null;
  const legacyApp = Array.isArray(legacyConfig.apps)
    ? legacyConfig.apps.find((app) => trimString(app?.appId) === appId)
    : null;
  if (!targetApp || !legacyApp || !Array.isArray(legacyApp.users) || legacyApp.users.length === 0) return 0;

  const targetUsers = Array.isArray(targetApp.users) ? [...targetApp.users] : [];
  const knownOpenIds = new Set(targetUsers.map((user) => trimString(user?.userOpenId)).filter(Boolean));
  let added = 0;
  for (const user of legacyApp.users) {
    const userOpenId = trimString(user?.userOpenId);
    if (!userOpenId || knownOpenIds.has(userOpenId)) continue;
    targetUsers.push(user);
    knownOpenIds.add(userOpenId);
    added += 1;
  }
  if (!added) return 0;
  targetApp.users = targetUsers;
  await writeJsonAtomically(targetPath, targetConfig);
  return added;
}

export function buildInstanceRuntimeCellEnvironment({
  instanceRoot = '',
  projectRoot = '',
} = {}) {
  const normalizedInstanceRoot = resolve(trimString(instanceRoot));
  if (!trimString(instanceRoot)) {
    throw new Error('instanceRoot is required to build an instance runtime cell');
  }
  const normalizedProjectRoot = trimString(projectRoot) ? resolve(projectRoot) : '';
  return {
    HOME: normalizedInstanceRoot,
    REMOTELAB_INSTANCE_ROOT: normalizedInstanceRoot,
    ...(normalizedProjectRoot ? { REMOTELAB_PROJECT_ROOT: normalizedProjectRoot } : {}),
    REMOTELAB_MACHINE_PI_AGENT_DIR: join(normalizedInstanceRoot, '.pi', 'agent'),
    LARKSUITE_CLI_CONFIG_DIR: join(normalizedInstanceRoot, 'config', 'lark-cli'),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  };
}

export function buildInstanceLarkCliEnvironment(configDir, baseEnv = process.env) {
  const environment = {};
  for (const name of LARK_CLI_ENV_KEYS) {
    const value = trimString(baseEnv?.[name]);
    if (value) environment[name] = value;
  }
  environment.LARKSUITE_CLI_CONFIG_DIR = resolve(configDir);
  environment.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  environment.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  return environment;
}

export function runInstanceLarkCliCommand(request = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = execFile(
      request.command,
      Array.isArray(request.args) ? request.args : [],
      {
        cwd: request.cwd,
        env: request.env,
        encoding: 'utf8',
        maxBuffer: Number.isInteger(request.maxBuffer) ? request.maxBuffer : LARK_CLI_MAX_BUFFER,
        timeout: Number.isInteger(request.timeoutMs) ? request.timeoutMs : LARK_CLI_TIMEOUT_MS,
      },
      (error, stdout = '', stderr = '') => {
        if (error) {
          error.stdout = String(stdout || '');
          error.stderr = String(stderr || '');
          rejectCommand(error);
          return;
        }
        resolveCommand({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(typeof request.stdin === 'string' ? request.stdin : '');
  });
}

export async function ensureInstanceLarkCliBotProfile(options = {}) {
  const appId = trimString(options.appId);
  const appSecret = trimString(options.appSecret);
  const requestedProfileName = trimString(options.profileName) || appId;
  const configDir = resolve(trimString(options.configDir));
  const cliPath = resolve(trimString(options.cliPath));
  const brand = trimString(options.brand).toLowerCase() === 'lark' ? 'lark' : 'feishu';
  const runCommand = typeof options.runCommand === 'function'
    ? options.runCommand
    : runInstanceLarkCliCommand;

  if (!appId || !appSecret) {
    throw new Error('Feishu Bot appId and appSecret are required to initialize the instance lark-cli profile');
  }
  if (!trimString(options.configDir) || !trimString(options.cliPath)) {
    throw new Error('configDir and cliPath are required to initialize the instance lark-cli profile');
  }

  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  const env = buildInstanceLarkCliEnvironment(configDir, options.baseEnv || process.env);
  const sharedRequest = {
    command: cliPath,
    cwd: configDir,
    env,
    timeoutMs: LARK_CLI_TIMEOUT_MS,
    maxBuffer: LARK_CLI_MAX_BUFFER,
  };

  const releaseConfigLock = await acquireConfigLock(configDir);
  let profileName = requestedProfileName;
  let importedUsers = 0;
  try {
    const currentConfig = await readJsonFile(join(configDir, 'config.json'));
    const apps = Array.isArray(currentConfig?.apps) ? currentConfig.apps : [];
    const existingApp = apps.find((app) => trimString(app?.appId) === appId);
    if (existingApp) {
      const existingName = trimString(existingApp.name);
      if (existingName) {
        profileName = existingName;
      } else {
        const conflictingProfile = apps.find((app) => (
          trimString(app?.name) === requestedProfileName && trimString(app?.appId) !== appId
        ));
        if (conflictingProfile) {
          throw new Error(`lark-cli profile name ${requestedProfileName} is already used by another app`);
        }
        await runCommand({
          ...sharedRequest,
          args: ['profile', 'rename', appId, requestedProfileName],
        });
      }
    }

    await runCommand({
      ...sharedRequest,
      args: [
        'config', 'init',
        '--app-id', appId,
        '--app-secret-stdin',
        '--brand', brand,
        '--name', profileName,
      ],
      stdin: `${appSecret}\n`,
    });
    await chmod(join(configDir, 'config.json'), 0o600).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    importedUsers = await mergeLegacyUsers({
      configDir,
      legacyConfigDir: options.legacyConfigDir,
      appId,
    });
  } finally {
    await releaseConfigLock();
  }
  // Binding the connector's app credentials must not constrain the CLI's user
  // identity or overwrite an owner-selected default on every connector restart.
  // Instance isolation comes from configDir, not a forced Bot-only policy.

  return {
    configDir,
    appId,
    profileName,
    importedUsers,
  };
}
