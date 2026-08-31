#!/usr/bin/env node

import { execFile as execFileCallback } from 'child_process';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { buildLaunchAgentPlist } from '../lib/guest-instance.mjs';
import { syncGuestPlatformSkills } from '../lib/guest-instance-command.mjs';
import { serializeUserShellEnvSnapshot } from '../lib/user-shell-env.mjs';

const execFileAsync = promisify(execFileCallback);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const HOME_DIR = homedir();
const OWNER_INSTANCE_ROOT = join(HOME_DIR, '.remotelab', 'instances', 'owner');
const OWNER_WORKSPACE_DIR = join(OWNER_INSTANCE_ROOT, 'workspace');
const OWNER_TMP_DIR = join(OWNER_INSTANCE_ROOT, 'tmp');
const LEGACY_CONFIG_DIR = join(HOME_DIR, '.config', 'remotelab');
const LEGACY_MEMORY_DIR = join(HOME_DIR, '.remotelab', 'memory');
const OWNER_LAUNCH_AGENT_PATH = join(HOME_DIR, 'Library', 'LaunchAgents', 'com.chatserver.claude.plist');
const OWNER_SYSTEMD_ENV_FILE = '/etc/remotelab/remotelab.env';
const OWNER_SYSTEMD_SERVICE_NAME = 'remotelab.service';
const OWNER_BUILD_INFO_URL = 'http://127.0.0.1:7690/api/build-info';
const DEFAULT_OWNER_PORT = '7690';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv = []) {
  return {
    dryRun: argv.includes('--dry-run'),
    noRestart: argv.includes('--no-restart'),
    json: argv.includes('--json'),
  };
}

function unescapePlistXml(value) {
  return String(value || '')
    .replace(/&apos;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseStringValues(block = '') {
  return Array.from(String(block || '').matchAll(/<string>([\s\S]*?)<\/string>/g))
    .map((match) => unescapePlistXml(match[1] || ''));
}

function parseStringDict(block = '') {
  const entries = Array.from(
    String(block || '').matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g),
  );
  return Object.fromEntries(
    entries.map(([, key, value]) => [
      unescapePlistXml(key || ''),
      unescapePlistXml(value || ''),
    ]),
  );
}

function parseEnvFile(content = '') {
  const env = {};
  for (const line of String(content || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    env[trimmed.slice(0, separatorIndex).trim()] = trimmed.slice(separatorIndex + 1).trim();
  }
  return env;
}

function serializeEnvFile(env = {}) {
  return Object.entries(env)
    .filter(([key, value]) => trimString(key) && trimString(value))
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n';
}

function parseLaunchAgentPlistFallback(content = '') {
  const source = String(content || '');
  const extractBlock = (key) => {
    const pattern = new RegExp(
      `<key>${escapeRegex(key)}</key>\\s*(<string>[\\s\\S]*?<\\/string>|<array>[\\s\\S]*?<\\/array>|<dict>[\\s\\S]*?<\\/dict>)`,
    );
    return source.match(pattern)?.[1] || '';
  };
  const readString = (key) => parseStringValues(extractBlock(key))[0] || '';
  return {
    Label: readString('Label'),
    ProgramArguments: parseStringValues(extractBlock('ProgramArguments')),
    EnvironmentVariables: parseStringDict(extractBlock('EnvironmentVariables')),
    WorkingDirectory: readString('WorkingDirectory'),
    StandardOutPath: readString('StandardOutPath'),
    StandardErrorPath: readString('StandardErrorPath'),
  };
}

async function readPlistJson(plistPath) {
  try {
    const result = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
    });
    return JSON.parse(result.stdout || '{}');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  const content = await readFile(plistPath, 'utf8');
  return parseLaunchAgentPlistFallback(content);
}

async function writeTextAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, value, 'utf8');
  await rename(tempPath, path);
}

async function backupFile(path) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
  const backupPath = `${path}.bak.${timestamp}`;
  await copyFile(path, backupPath);
  return backupPath;
}

async function ensurePathAlias(linkPath, targetPath, options = {}) {
  const dryRun = options.dryRun === true;
  const targetRealPath = await realpath(targetPath);
  try {
    const existing = await lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      return { path: linkPath, target: targetPath, changed: false, reason: 'existing-path' };
    }
    const linkRealPath = await realpath(linkPath);
    if (linkRealPath === targetRealPath) {
      return { path: linkPath, target: targetPath, changed: false };
    }
    throw new Error(`${linkPath} already exists but does not point to ${targetPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (!dryRun) {
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(targetPath, linkPath);
  }
  return { path: linkPath, target: targetPath, changed: true };
}

async function ensureRemoteLabCliShim(homeDir, options = {}) {
  const dryRun = options.dryRun === true;
  const linkPath = join(homeDir, '.local', 'bin', 'remotelab');
  const targetPath = join(PROJECT_ROOT, 'cli.js');
  const targetRealPath = await realpath(targetPath);

  try {
    const existing = await lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      return { path: linkPath, target: targetPath, changed: false, reason: 'existing-path' };
    }
    try {
      const linkRealPath = await realpath(linkPath);
      if (linkRealPath === targetRealPath) {
        return { path: linkPath, target: targetPath, changed: false };
      }
    } catch {}
    if (!dryRun) {
      await rm(linkPath, { force: true });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (!dryRun) {
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(targetPath, linkPath);
  }
  return { path: linkPath, target: targetPath, changed: true };
}

async function copyMissingTree(sourceDir, targetDir, options = {}) {
  if (!await pathExists(sourceDir)) {
    return { changed: false, copiedFiles: 0 };
  }

  const dryRun = options.dryRun === true;
  let copiedFiles = 0;
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      if (!dryRun) {
        await mkdir(targetPath, { recursive: true });
      }
      const nested = await copyMissingTree(sourcePath, targetPath, options);
      copiedFiles += nested.copiedFiles;
      continue;
    }
    if (!entry.isFile()) continue;
    if (await pathExists(targetPath)) continue;
    copiedFiles += 1;
    if (!dryRun) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }

  return {
    changed: copiedFiles > 0,
    copiedFiles,
  };
}

async function reloadOwnerLaunchAgent() {
  try {
    await execFileAsync('launchctl', ['unload', OWNER_LAUNCH_AGENT_PATH], { stdio: 'ignore' });
  } catch {}
  await execFileAsync('launchctl', ['load', OWNER_LAUNCH_AGENT_PATH], { stdio: 'ignore' });
}

async function restartOwnerSystemdService() {
  await execFileAsync('systemctl', ['restart', OWNER_SYSTEMD_SERVICE_NAME], { stdio: 'ignore' });
}

async function fetchBuildInfo(url) {
  const result = await execFileAsync('curl', [
    '-sS',
    '--max-time',
    '2',
    '-H',
    'Accept: application/json',
    url,
  ], {
    encoding: 'utf8',
  });
  return JSON.parse(result.stdout || '{}');
}

async function waitForBuildInfo(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchBuildInfo(url);
    } catch (error) {
      lastError = error?.message || String(error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
  }
  throw new Error(lastError || `Timed out waiting for ${url}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  await mkdir(OWNER_INSTANCE_ROOT, { recursive: true });
  await mkdir(OWNER_WORKSPACE_DIR, { recursive: true });
  await mkdir(OWNER_TMP_DIR, { recursive: true });
  const cliShim = await ensureRemoteLabCliShim(OWNER_INSTANCE_ROOT, options);

  const aliases = [
    await ensurePathAlias(join(OWNER_INSTANCE_ROOT, 'config'), LEGACY_CONFIG_DIR, options),
    await ensurePathAlias(join(OWNER_INSTANCE_ROOT, 'memory'), LEGACY_MEMORY_DIR, options),
  ];
  const memoryBackfill = aliases[1]?.reason === 'existing-path'
    ? await copyMissingTree(LEGACY_MEMORY_DIR, join(OWNER_INSTANCE_ROOT, 'memory'), options)
    : { changed: false, copiedFiles: 0 };
  const platformSkills = await syncGuestPlatformSkills(join(OWNER_INSTANCE_ROOT, 'memory'), {
    dryRun: options.dryRun,
    homeDir: HOME_DIR,
  });
  const usesLaunchAgent = await pathExists(OWNER_LAUNCH_AGENT_PATH);

  let plistChanged = false;
  let envChanged = false;
  let backupPath = '';
  if (usesLaunchAgent) {
    const currentPlist = await readPlistJson(OWNER_LAUNCH_AGENT_PATH);
    const currentContent = await readFile(OWNER_LAUNCH_AGENT_PATH, 'utf8');
    const environmentVariables = {
      ...(currentPlist.EnvironmentVariables && typeof currentPlist.EnvironmentVariables === 'object'
        ? currentPlist.EnvironmentVariables
        : {}),
      HOME: OWNER_INSTANCE_ROOT,
      CHAT_PORT: trimString(currentPlist.EnvironmentVariables?.CHAT_PORT) || DEFAULT_OWNER_PORT,
      REMOTELAB_INSTANCE_ROOT: OWNER_INSTANCE_ROOT,
      TMPDIR: OWNER_TMP_DIR,
      REMOTELAB_USER_SHELL_ENV_B64: trimString(currentPlist.EnvironmentVariables?.REMOTELAB_USER_SHELL_ENV_B64)
        || serializeUserShellEnvSnapshot(),
    };
    delete environmentVariables.REMOTELAB_SESSION_DISPATCH;

    const nextContent = buildLaunchAgentPlist({
      label: trimString(currentPlist.Label) || 'com.chatserver.claude',
      nodePath: trimString(currentPlist.ProgramArguments?.[0]) || process.execPath,
      chatServerPath: trimString(currentPlist.ProgramArguments?.[1]) || join(PROJECT_ROOT, 'chat-server.mjs'),
      workingDirectory: PROJECT_ROOT,
      standardOutPath: trimString(currentPlist.StandardOutPath) || join(HOME_DIR, 'Library', 'Logs', 'chat-server.log'),
      standardErrorPath: trimString(currentPlist.StandardErrorPath) || join(HOME_DIR, 'Library', 'Logs', 'chat-server.error.log'),
      environmentVariables,
    });

    plistChanged = currentContent !== nextContent;
    if (!options.dryRun && plistChanged) {
      backupPath = await backupFile(OWNER_LAUNCH_AGENT_PATH);
      await writeTextAtomic(OWNER_LAUNCH_AGENT_PATH, nextContent);
    }
  } else {
    const currentContent = await readFile(OWNER_SYSTEMD_ENV_FILE, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    const environmentVariables = parseEnvFile(currentContent);
    environmentVariables.HOME = OWNER_INSTANCE_ROOT;
    environmentVariables.PATH = trimString(environmentVariables.PATH) || trimString(process.env.PATH) || '/usr/local/bin:/usr/bin:/bin';
    environmentVariables.CHAT_PORT = trimString(environmentVariables.CHAT_PORT) || DEFAULT_OWNER_PORT;
    environmentVariables.REMOTELAB_INSTANCE_ROOT = OWNER_INSTANCE_ROOT;
    environmentVariables.TMPDIR = OWNER_TMP_DIR;
    delete environmentVariables.REMOTELAB_SESSION_DISPATCH;
    const nextContent = serializeEnvFile(environmentVariables);
    envChanged = currentContent !== nextContent;
    if (!options.dryRun && envChanged) {
      backupPath = await backupFile(OWNER_SYSTEMD_ENV_FILE);
      await writeTextAtomic(OWNER_SYSTEMD_ENV_FILE, nextContent);
    }
  }

  let restarted = false;
  let buildInfo = null;
  if (!options.dryRun && !options.noRestart) {
    if (usesLaunchAgent) {
      await reloadOwnerLaunchAgent();
    } else {
      await restartOwnerSystemdService();
    }
    restarted = true;
    buildInfo = await waitForBuildInfo(OWNER_BUILD_INFO_URL);
  }

  const result = {
    ownerInstanceRoot: OWNER_INSTANCE_ROOT,
    cliShim,
    aliases,
    memoryBackfill,
    platformSkills,
    plistChanged,
    envChanged,
    backupPath,
    restarted,
    buildInfoOk: !!buildInfo,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write([
    `ownerInstanceRoot: ${OWNER_INSTANCE_ROOT}`,
    `aliasesChanged: ${aliases.some((entry) => entry.changed) ? 'yes' : 'no'}`,
    `plistChanged: ${plistChanged ? 'yes' : 'no'}`,
    `restarted: ${restarted ? 'yes' : 'no'}`,
  ].join('\n'));
  process.stdout.write('\n');
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
