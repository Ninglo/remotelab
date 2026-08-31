import { execFile } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const LARK_CLI_TIMEOUT_MS = 30_000;
const LARK_CLI_MAX_BUFFER = 4 * 1024 * 1024;
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
    REMOTELAB_MACHINE_CODEX_HOME: join(normalizedInstanceRoot, '.codex'),
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

  await runCommand({
    ...sharedRequest,
    args: ['config', 'init', '--app-id', appId, '--app-secret-stdin', '--brand', brand],
    stdin: `${appSecret}\n`,
  });
  await chmod(join(configDir, 'config.json'), 0o600).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await runCommand({
    ...sharedRequest,
    args: ['config', 'strict-mode', 'bot', '--global'],
  });
  await runCommand({
    ...sharedRequest,
    args: ['config', 'default-as', 'bot'],
  });

  return {
    configDir,
    identity: 'bot',
    strictMode: 'bot',
  };
}
