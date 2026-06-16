import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { pathExists } from '../chat/fs-utils.mjs';
import {
  CHAT_PORT,
  CONFIG_DIR,
  INSTANCE_ROOT,
  IS_GUEST_INSTANCE,
  PUBLIC_BASE_URL,
} from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const WECHAT_CONNECTOR_INSTANCE_SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'wechat-connector-instance.sh');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function execFileAsync(command, args = [], options = {}) {
  return await new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readJsonIfExists(filePath, {
  pathExistsImpl = pathExists,
  readFileImpl = readFile,
} = {}) {
  if (!await pathExistsImpl(filePath)) {
    return null;
  }
  try {
    return JSON.parse(await readFileImpl(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function countLinkedAccounts(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }
  if (Array.isArray(value.accounts)) {
    return value.accounts.length;
  }
  return Object.keys(value).length;
}

export async function ensureGuestWeChatConnectorStartup({
  isGuestInstance = IS_GUEST_INSTANCE,
  instanceRoot = INSTANCE_ROOT,
  configDir = CONFIG_DIR,
  chatPort = CHAT_PORT,
  publicBaseUrl = PUBLIC_BASE_URL,
  pathExistsImpl = pathExists,
  execFileImpl = execFileAsync,
  scriptPath = WECHAT_CONNECTOR_INSTANCE_SCRIPT_PATH,
  projectRoot = PROJECT_ROOT,
} = {}) {
  if (!isGuestInstance) {
    return {
      attempted: false,
      reason: 'not_guest_instance',
    };
  }

  const normalizedInstanceRoot = trimString(instanceRoot);
  if (!normalizedInstanceRoot) {
    return {
      attempted: false,
      reason: 'missing_instance_root',
    };
  }

  const connectorDir = join(configDir, 'wechat-connector');
  const connectorConfigPath = join(connectorDir, 'config.json');
  if (!await pathExistsImpl(connectorConfigPath)) {
    return {
      attempted: false,
      reason: 'wechat_not_configured',
      connectorConfigPath,
    };
  }

  const connectorConfig = await readJsonIfExists(connectorConfigPath, {
    pathExistsImpl,
  });
  const autoStart = connectorConfig?.autoStart === true;
  const accountsPath = join(connectorDir, 'accounts.json');
  const linkedAccounts = countLinkedAccounts(await readJsonIfExists(accountsPath, {
    pathExistsImpl,
  }));
  if (!autoStart && linkedAccounts === 0) {
    return {
      attempted: false,
      reason: 'wechat_not_bound',
      connectorConfigPath,
      accountsPath,
      autoStart,
      linkedAccounts,
    };
  }

  const env = {
    ...process.env,
    REMOTELAB_INSTANCE_ROOT: normalizedInstanceRoot,
    CHAT_PORT: String(chatPort),
  };
  const normalizedPublicBaseUrl = trimString(publicBaseUrl);
  if (normalizedPublicBaseUrl) {
    env.REMOTELAB_PUBLIC_BASE_URL = normalizedPublicBaseUrl;
  }

  const result = await execFileImpl(scriptPath, ['start'], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });

  return {
    attempted: true,
    reason: 'ensured',
    connectorConfigPath,
    accountsPath,
    autoStart,
    linkedAccounts,
    stdout: trimString(result?.stdout || ''),
    stderr: trimString(result?.stderr || ''),
  };
}
