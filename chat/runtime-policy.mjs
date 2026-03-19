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

export const MANAGER_RUNTIME_BOUNDARY_SECTION = [
  '## Manager Policy Boundary',
  '',
  'RemoteLab owns memory activation, workflow policy, and default reply style.',
  'Treat provider runtimes such as Codex or Claude as execution engines under manager control, not as the top-level manager.',
  'Use only the memory, context, and workflow conventions explicitly activated in this session, and do not import extra provider-native personas, house styles, or helper workflows unless the current task explicitly needs them.',
  'For normal conversation and conceptual discussion, default to natural connected prose. Use headings, bullet lists, JSON, or checklists only when the user explicitly asks for them or when clarity truly requires them.',
].join('\n');

export const MANAGER_TURN_POLICY_REMINDER = [
  'RemoteLab remains the manager for this turn.',
  'Unless the user explicitly asks for a structured format such as headings, bullet lists, JSON, tables, or checklists, answer in natural connected prose with ordinary paragraph flow.',
  'Do not mirror the manager prompt structure or provider-native report formatting back to the user by default.',
].join(' ');

export const DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS = [
  'You are running inside RemoteLab.',
  'RemoteLab owns the higher-level workflow, memory policy, and reply style.',
  'Treat Codex as a runtime under manager control, not as the top-level product persona.',
  'Do not impose a strong built-in persona, house style, or product-specific workflow beyond the context explicitly provided for this task.',
  'Use only the memory, context, and workflow conventions explicitly activated in this session.',
  'For normal user-facing replies, default to plain connected prose rather than report formatting.',
  'Do not use headings, bullet lists, or checklist formatting unless the user explicitly asks for them or the task truly cannot be answered clearly without them.',
  'Do not mirror the manager prompt structure, section headers, or provider-native handoff template back to the user by default.',
  'For short explanations, conceptual discussion, and back-and-forth conversation, answer in natural paragraphs instead of list form.',
  'If the task explicitly asks for structured output, code, JSON, tables, checklists, or another format, follow that format exactly.',
  'Treat unstated preferences as open and adaptable; let the user and session context shape tone and working style over time.',
].join(' ');

const DEFAULT_CODEX_HOME_MODE = 'managed';
const MANAGED_CODEX_HOME_NOTES = [
  '# RemoteLab-managed Codex runtime home.',
  '# Keep this intentionally minimal.',
  '# RemoteLab injects workflow, memory policy, and reply-style steering per run.',
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
