#!/usr/bin/env node

import { access, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runGithubCiAutoRepair } from './github-ci-auto-repair.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'remotelab', 'github-ci-auto-repair');
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.json');
const DEFAULT_LAST_RUN_PATH = join(DEFAULT_CONFIG_DIR, 'last-run.json');
const DEFAULT_LOCK_DIR = join(DEFAULT_CONFIG_DIR, 'run.lock');
const DEFAULT_INTERVAL_SECONDS = 300;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function splitCsv(value) {
  return trimString(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function expandHomePath(value) {
  const normalized = trimString(value);
  if (!normalized) return '';
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/')) return join(homedir(), normalized.slice(2));
  return normalized;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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

function parseArgs(argv = []) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--config':
        options.configPath = argv[index + 1] || '';
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.configPath = expandHomePath(options.configPath) || DEFAULT_CONFIG_PATH;
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/github-ci-auto-repair-runner.mjs [options]

Options:
  --config <path>            Config file path (default: ${DEFAULT_CONFIG_PATH})
  --json                     Print machine-readable summary for runner-specific outcomes
  -h, --help                 Show this help
`);
}

function normalizeConfig(rawConfig = {}) {
  const branches = unique(
    Array.isArray(rawConfig.branches) ? rawConfig.branches.map((value) => trimString(value)) : splitCsv(rawConfig.branches)
  );
  const events = unique(
    Array.isArray(rawConfig.events) ? rawConfig.events.map((value) => trimString(value)) : splitCsv(rawConfig.events)
  );
  const workflows = unique(
    Array.isArray(rawConfig.workflows) ? rawConfig.workflows.map((value) => trimString(value)) : splitCsv(rawConfig.workflows)
  );

  return {
    enabled: rawConfig.enabled !== false,
    repo: trimString(rawConfig.repo),
    branches,
    events,
    workflows,
    chatBaseUrl: trimString(rawConfig.chatBaseUrl),
    sessionFolder: expandHomePath(rawConfig.sessionFolder || PROJECT_ROOT) || PROJECT_ROOT,
    sessionTool: trimString(rawConfig.sessionTool),
    model: trimString(rawConfig.model),
    effort: trimString(rawConfig.effort),
    thinking: rawConfig.thinking === true,
    bootstrapHours: parsePositiveInteger(rawConfig.bootstrapHours, 24),
    limit: parsePositiveInteger(rawConfig.limit, 20),
    settleMinutes: parseNonNegativeInteger(rawConfig.settleMinutes ?? 5, 5),
    maxLogLines: parsePositiveInteger(rawConfig.maxLogLines, 120),
    maxLogChars: parsePositiveInteger(rawConfig.maxLogChars, 12000),
    stateFile: expandHomePath(rawConfig.stateFile),
    snapshotDir: expandHomePath(rawConfig.snapshotDir),
    ghBin: expandHomePath(rawConfig.ghBin),
    intervalSeconds: parsePositiveInteger(rawConfig.intervalSeconds, DEFAULT_INTERVAL_SECONDS),
  };
}

export function buildMonitorArgv(config) {
  const argv = [];
  if (config.repo) {
    argv.push('--repo', config.repo);
  }
  for (const branch of config.branches || []) {
    argv.push('--branch', branch);
  }
  for (const event of config.events || []) {
    argv.push('--event', event);
  }
  for (const workflow of config.workflows || []) {
    argv.push('--workflow', workflow);
  }
  if (config.chatBaseUrl) argv.push('--chat-base-url', config.chatBaseUrl);
  if (config.sessionFolder) argv.push('--session-folder', config.sessionFolder);
  if (config.sessionTool) argv.push('--session-tool', config.sessionTool);
  if (config.model) argv.push('--model', config.model);
  if (config.effort) argv.push('--effort', config.effort);
  if (config.thinking === true) argv.push('--thinking');
  if (config.bootstrapHours) argv.push('--bootstrap-hours', String(config.bootstrapHours));
  if (config.limit) argv.push('--limit', String(config.limit));
  if (config.settleMinutes >= 0) argv.push('--settle-minutes', String(config.settleMinutes));
  if (config.maxLogLines) argv.push('--max-log-lines', String(config.maxLogLines));
  if (config.maxLogChars) argv.push('--max-log-chars', String(config.maxLogChars));
  if (config.stateFile) argv.push('--state-file', config.stateFile);
  if (config.snapshotDir) argv.push('--snapshot-dir', config.snapshotDir);
  argv.push('--json');
  return argv;
}

function lockInfoPath(lockDir) {
  return join(lockDir, 'owner.json');
}

async function acquireLock(lockDir) {
  try {
    await mkdir(lockDir, { recursive: false });
    const info = {
      pid: process.pid,
      startedAt: nowIso(),
    };
    await writeJson(lockInfoPath(lockDir), info);
    return {
      acquired: true,
      async release() {
        await rm(lockDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readJson(lockInfoPath(lockDir), {});
    const pid = Number.parseInt(String(existing?.pid || ''), 10);
    if (isProcessAlive(pid)) {
      return {
        acquired: false,
        reason: 'already_running',
        pid,
      };
    }
    await rm(lockDir, { recursive: true, force: true });
    return acquireLock(lockDir);
  }
}

async function loadConfig(configPath) {
  const raw = await readJson(configPath, null);
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Failed to load CI auto-repair config: ${configPath}`);
  }
  return normalizeConfig(raw);
}

function buildRunnerSummary(base = {}) {
  return {
    source: 'github-ci-auto-repair-runner',
    ...base,
  };
}

export async function runGithubCiAutoRepairRunner(argv = []) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const config = await loadConfig(options.configPath);
  const configDir = dirname(options.configPath);
  const lockDir = join(configDir, 'run.lock');
  const lastRunPath = join(configDir, 'last-run.json');

  if (config.ghBin) {
    process.env.GH_BIN = config.ghBin;
  }

  if (config.enabled !== true) {
    const summary = buildRunnerSummary({
      status: 'disabled',
      configPath: options.configPath,
      finishedAt: nowIso(),
    });
    await writeJson(lastRunPath, summary);
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  const lock = await acquireLock(lockDir);
  if (!lock.acquired) {
    const summary = buildRunnerSummary({
      status: 'skipped',
      reason: lock.reason,
      pid: lock.pid,
      configPath: options.configPath,
      finishedAt: nowIso(),
    });
    await writeJson(lastRunPath, summary);
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  try {
    const startedAt = nowIso();
    const summary = await runGithubCiAutoRepair(buildMonitorArgv(config));
    const finalSummary = buildRunnerSummary({
      status: 'ok',
      startedAt,
      finishedAt: nowIso(),
      configPath: options.configPath,
      monitor: summary,
    });
    await writeJson(lastRunPath, finalSummary);
    if (options.json) console.log(JSON.stringify(finalSummary, null, 2));
    return finalSummary;
  } catch (error) {
    const failedSummary = buildRunnerSummary({
      status: 'error',
      configPath: options.configPath,
      finishedAt: nowIso(),
      error: error?.stack || error?.message || String(error),
    });
    await writeJson(lastRunPath, failedSummary);
    throw error;
  } finally {
    await lock.release();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runGithubCiAutoRepairRunner(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
