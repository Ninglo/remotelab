#!/usr/bin/env node

import { execFile as execFileCallback } from 'child_process';
import { copyFile, mkdir, readFile, realpath, rename, symlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { buildLaunchAgentPlist } from '../lib/guest-instance.mjs';
import { serializeUserShellEnvSnapshot } from '../lib/user-shell-env.mjs';

const execFileAsync = promisify(execFileCallback);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const HOME_DIR = homedir();
const OWNER_INSTANCE_ROOT = join(HOME_DIR, '.remotelab', 'instances', 'owner');
const LEGACY_CONFIG_DIR = join(HOME_DIR, '.config', 'remotelab');
const LEGACY_MEMORY_DIR = join(HOME_DIR, '.remotelab', 'memory');
const OWNER_LAUNCH_AGENT_PATH = join(HOME_DIR, 'Library', 'LaunchAgents', 'com.chatserver.claude.plist');
const OWNER_BUILD_INFO_URL = 'http://127.0.0.1:7690/api/build-info';
const DEFAULT_OWNER_PORT = '7690';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
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

async function reloadOwnerLaunchAgent() {
  try {
    await execFileAsync('launchctl', ['unload', OWNER_LAUNCH_AGENT_PATH], { stdio: 'ignore' });
  } catch {}
  await execFileAsync('launchctl', ['load', OWNER_LAUNCH_AGENT_PATH], { stdio: 'ignore' });
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

  const aliases = [
    await ensurePathAlias(join(OWNER_INSTANCE_ROOT, 'config'), LEGACY_CONFIG_DIR, options),
    await ensurePathAlias(join(OWNER_INSTANCE_ROOT, 'memory'), LEGACY_MEMORY_DIR, options),
  ];

  const currentPlist = await readPlistJson(OWNER_LAUNCH_AGENT_PATH);
  const currentContent = await readFile(OWNER_LAUNCH_AGENT_PATH, 'utf8');
  const environmentVariables = {
    ...(currentPlist.EnvironmentVariables && typeof currentPlist.EnvironmentVariables === 'object'
      ? currentPlist.EnvironmentVariables
      : {}),
    HOME: trimString(currentPlist.EnvironmentVariables?.HOME) || HOME_DIR,
    CHAT_PORT: trimString(currentPlist.EnvironmentVariables?.CHAT_PORT) || DEFAULT_OWNER_PORT,
    REMOTELAB_INSTANCE_ROOT: OWNER_INSTANCE_ROOT,
    REMOTELAB_SESSION_DISPATCH: 'on',
    REMOTELAB_USER_SHELL_ENV_B64: trimString(currentPlist.EnvironmentVariables?.REMOTELAB_USER_SHELL_ENV_B64)
      || serializeUserShellEnvSnapshot(),
  };

  const nextContent = buildLaunchAgentPlist({
    label: trimString(currentPlist.Label) || 'com.chatserver.claude',
    nodePath: trimString(currentPlist.ProgramArguments?.[0]) || process.execPath,
    chatServerPath: trimString(currentPlist.ProgramArguments?.[1]) || join(PROJECT_ROOT, 'chat-server.mjs'),
    workingDirectory: PROJECT_ROOT,
    standardOutPath: trimString(currentPlist.StandardOutPath) || join(HOME_DIR, 'Library', 'Logs', 'chat-server.log'),
    standardErrorPath: trimString(currentPlist.StandardErrorPath) || join(HOME_DIR, 'Library', 'Logs', 'chat-server.error.log'),
    environmentVariables,
  });

  const plistChanged = currentContent !== nextContent;
  let backupPath = '';
  if (!options.dryRun && plistChanged) {
    backupPath = await backupFile(OWNER_LAUNCH_AGENT_PATH);
    await writeTextAtomic(OWNER_LAUNCH_AGENT_PATH, nextContent);
  }

  let restarted = false;
  let buildInfo = null;
  if (!options.dryRun && !options.noRestart) {
    await reloadOwnerLaunchAgent();
    restarted = true;
    buildInfo = await waitForBuildInfo(OWNER_BUILD_INFO_URL);
  }

  const result = {
    ownerInstanceRoot: OWNER_INSTANCE_ROOT,
    aliases,
    plistChanged,
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
