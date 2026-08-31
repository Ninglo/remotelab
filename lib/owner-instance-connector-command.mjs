import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'cli.js');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeInstanceName(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || !/^[a-z0-9][a-z0-9-]*$/.test(normalized)) return '';
  return normalized;
}

async function pathExists(pathname) {
  try {
    await stat(pathname);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(pathname, fallbackValue) {
  try {
    return JSON.parse(await readFile(pathname, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallbackValue;
    throw error;
  }
}

async function resolveOwnerConfigDir(options = {}) {
  const env = options.env || process.env;
  const homeDir = trimString(options.homeDir) || homedir();
  const explicit = trimString(env.REMOTELAB_OWNER_CONFIG_DIR)
    || trimString(env.REMOTELAB_HOST_CONFIG_DIR);
  if (explicit) return resolve(explicit);

  const homeConfigDir = join(homeDir, '.config', 'remotelab');
  const candidates = [homeConfigDir];
  const instanceRoot = trimString(env.REMOTELAB_INSTANCE_ROOT);
  if (instanceRoot && basename(resolve(instanceRoot)) === 'owner' && process.platform !== 'darwin') {
    candidates.unshift('/root/.config/remotelab');
  }
  for (const candidate of candidates) {
    if (await pathExists(join(candidate, 'guest-instances.json'))) return candidate;
  }
  return homeConfigDir;
}

function summarizeConnectorArgs(argv = []) {
  const positional = [];
  const optionNames = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    optionNames.push(value.slice(2));
    if (argv[index + 1] !== undefined && !String(argv[index + 1]).startsWith('--')) {
      index += 1;
    }
  }
  return {
    command: trimString(positional[0]).toLowerCase(),
    toolName: trimString(positional[1]),
    optionNames: [...new Set(optionNames)].sort(),
  };
}

async function appendAdminConnectorAudit(ownerConfigDir, event) {
  const auditPath = join(ownerConfigDir, 'admin-audit', 'connector-actions.jsonl');
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(auditPath, 0o600).catch(() => {});
  return auditPath;
}

async function loadManagedTargetInstance(instanceName, options = {}) {
  const normalizedName = sanitizeInstanceName(instanceName);
  if (!normalizedName || normalizedName === 'owner') {
    throw new Error('Target instance must be a managed guest instance name');
  }
  const ownerConfigDir = await resolveOwnerConfigDir(options);
  const records = await readJsonFile(join(ownerConfigDir, 'guest-instances.json'), []);
  const record = Array.isArray(records)
    ? records.find((candidate) => sanitizeInstanceName(candidate?.name) === normalizedName)
    : null;
  if (!record) throw new Error(`Managed guest instance not found: ${normalizedName}`);

  const instanceRoot = trimString(record.instanceRoot);
  const configDir = trimString(record.configDir) || (instanceRoot ? join(instanceRoot, 'config') : '');
  if (!instanceRoot || !configDir) {
    throw new Error(`Managed guest instance ${normalizedName} is missing its local runtime paths`);
  }
  if (!await pathExists(join(configDir, 'connector-skill-registry.json'))) {
    throw new Error(`Managed guest instance ${normalizedName} has no active Connector registry`);
  }

  return {
    name: normalizedName,
    port: Number.parseInt(record.port, 10) || 0,
    localBaseUrl: trimString(record.localBaseUrl),
    instanceRoot: resolve(instanceRoot),
    configDir: resolve(configDir),
    memoryDir: resolve(trimString(record.memoryDir) || join(instanceRoot, 'memory')),
    ownerConfigDir,
  };
}

function buildTargetEnvironment(target, operationId, sourceEnv = process.env) {
  const env = {
    ...sourceEnv,
    HOME: target.instanceRoot,
    REMOTELAB_INSTANCE_ROOT: target.instanceRoot,
    REMOTELAB_CONFIG_DIR: target.configDir,
    REMOTELAB_MEMORY_DIR: target.memoryDir,
    REMOTELAB_WORK_ROOT_DIR: join(target.instanceRoot, 'workspace'),
    TMPDIR: join(target.instanceRoot, 'tmp'),
    REMOTELAB_ADMIN_ACTOR_INSTANCE: 'owner',
    REMOTELAB_ADMIN_OPERATION_ID: operationId,
  };
  if (target.port) env.CHAT_PORT = String(target.port);
  if (target.localBaseUrl) env.REMOTELAB_CHAT_BASE_URL = target.localBaseUrl;
  delete env.REMOTELAB_SESSION_ID;
  delete env.REMOTELAB_REQUEST_ID;
  delete env.REMOTELAB_RESPONSE_ID;
  delete env.REMOTELAB_RUN_ID;
  delete env.REMOTELAB_OWNER_CONFIG_DIR;
  delete env.REMOTELAB_HOST_CONFIG_DIR;
  return env;
}

function executeChildConnectorCommand(args, options = {}) {
  const execFileFn = options.execFileFn || execFileCallback;
  return new Promise((resolveResult) => {
    execFileFn(process.execPath, [CLI_ENTRY, 'connector', ...args], {
      cwd: PROJECT_ROOT,
      env: options.env,
      encoding: 'utf8',
      timeout: Number.isInteger(options.timeoutMs) ? options.timeoutMs : 65_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout = '', stderr = '') => {
      resolveResult({
        exitCode: Number.isInteger(error?.code) ? error.code : (error ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error,
      });
    });
  });
}

export async function runOwnerInstanceConnectorCommand(instanceName, connectorArgs = [], options = {}) {
  const operationId = randomUUID();
  const target = await loadManagedTargetInstance(instanceName, options);
  const summary = summarizeConnectorArgs(connectorArgs);
  const auditBase = {
    operationId,
    actorInstance: 'owner',
    targetInstance: target.name,
    command: summary.command,
    toolName: summary.toolName,
    optionNames: summary.optionNames.filter((name) => name !== 'instance'),
    sourceSessionId: trimString((options.env || process.env).REMOTELAB_SESSION_ID),
  };
  await appendAdminConnectorAudit(target.ownerConfigDir, {
    ...auditBase,
    type: 'admin_connector_action_started',
    timestamp: new Date().toISOString(),
  });

  const result = await executeChildConnectorCommand(connectorArgs, {
    ...options,
    env: buildTargetEnvironment(target, operationId, options.env || process.env),
  });
  await appendAdminConnectorAudit(target.ownerConfigDir, {
    ...auditBase,
    type: 'admin_connector_action_completed',
    timestamp: new Date().toISOString(),
    success: result.exitCode === 0,
    exitCode: result.exitCode,
  });

  if (result.error && !Number.isInteger(result.error?.code)) {
    const detail = trimString(result.stderr) || trimString(result.error?.message);
    const error = new Error(detail || `Connector command failed in ${target.name}`);
    error.code = 'TARGET_CONNECTOR_COMMAND_FAILED';
    error.exitCode = result.exitCode;
    throw error;
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    targetInstance: target.name,
  };
}

export {
  buildTargetEnvironment,
  loadManagedTargetInstance,
  resolveOwnerConfigDir,
  summarizeConnectorArgs,
};
