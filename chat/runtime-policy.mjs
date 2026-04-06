import { copyFile, lstat, readlink, symlink, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { CODEX_MANAGED_HOME_DIR } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  pathExists,
  writeTextAtomic,
} from './fs-utils.mjs';
import { readPromptAsset } from './prompt-asset-loader.mjs';

async function readInlinePromptAsset(relativePath) {
  return (await readPromptAsset(relativePath)).replace(/\s+/g, ' ').trim();
}

export const MANAGER_RUNTIME_BOUNDARY_SECTION = (await readPromptAsset('runtime/manager-boundary.md')).trim();
export const MANAGER_TURN_POLICY_REMINDER = await readInlinePromptAsset('runtime/manager-turn-reminder.txt');
export const DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS = await readInlinePromptAsset('runtime/codex-developer-instructions.txt');

const DEFAULT_CODEX_HOME_MODE = 'managed';
const MANAGED_CODEX_HOME_NOTES = [
  '# RemoteLab-managed Codex runtime home.',
  '# Keep this intentionally minimal.',
  '# RemoteLab injects workflow, memory policy, and reply-style steering per run.',
  '# Plugins stay off here because RemoteLab does not rely on the Codex plugin',
  '# marketplace, and startup syncs can trigger extra ChatGPT-side auth/challenge',
  '# traffic in proxied environments.',
  '',
  '[features]',
  'plugins = false',
  '',
].join('\n');

const PERSONAL_CODEX_HOME = join(homedir(), '.codex');
const PERSONAL_CODEX_AUTH_FILE = join(PERSONAL_CODEX_HOME, 'auth.json');
const managedCodexHomeQueue = createSerialTaskQueue();

function normalizeCodexHomeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'personal' || normalized === 'inherit') {
    return 'personal';
  }
  return DEFAULT_CODEX_HOME_MODE;
}

async function ensureSymlinkOrCopy(sourcePath, targetPath) {
  if (!await pathExists(sourcePath)) {
    return false;
  }

  try {
    const existing = await lstat(targetPath);
    if (existing.isSymbolicLink()) {
      const currentTarget = await readlink(targetPath);
      if (currentTarget === sourcePath) {
        return true;
      }
    }
    await unlink(targetPath);
  } catch {
  }

  try {
    await symlink(sourcePath, targetPath);
    return true;
  } catch {
  }

  try {
    await copyFile(sourcePath, targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureManagedCodexHome(options = {}) {
  return managedCodexHomeQueue(async () => {
    const homeDir = typeof options.homeDir === 'string' && options.homeDir.trim()
      ? options.homeDir.trim()
      : CODEX_MANAGED_HOME_DIR;
    const authSource = typeof options.authSource === 'string' && options.authSource.trim()
      ? options.authSource.trim()
      : PERSONAL_CODEX_AUTH_FILE;

    await ensureDir(homeDir);
    await writeTextAtomic(join(homeDir, 'config.toml'), MANAGED_CODEX_HOME_NOTES);
    await writeTextAtomic(join(homeDir, 'AGENTS.md'), '');
    await ensureSymlinkOrCopy(authSource, join(homeDir, 'auth.json'));
    return homeDir;
  });
}

export async function applyManagedRuntimeEnv(toolId, baseEnv = {}, options = {}) {
  const env = { ...baseEnv };
  const runtimeFamily = typeof options.runtimeFamily === 'string'
    ? options.runtimeFamily.trim()
    : '';
  const isCodexRuntime = toolId === 'codex' || runtimeFamily === 'codex-json';
  if (!isCodexRuntime) {
    return env;
  }

  const mode = normalizeCodexHomeMode(options.codexHomeMode || process.env.REMOTELAB_CODEX_HOME_MODE);
  if (mode === 'personal') {
    return env;
  }

  const managedHome = await ensureManagedCodexHome({
    homeDir: options.codexHomeDir,
    authSource: options.codexAuthSource,
  });
  delete env.CODEX_HOME;
  env.CODEX_HOME = managedHome;
  return env;
}
