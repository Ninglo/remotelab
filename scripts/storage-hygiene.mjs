#!/usr/bin/env node

import {
  access,
  readFile,
  readdir,
  rm,
  stat,
} from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_RUN_STATES = new Set(['cancelled', 'completed', 'failed']);
const scriptDir = dirname(fileURLToPath(import.meta.url));

function parseNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseOptions(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    json: false,
    nowMs: Date.now(),
    runRetentionDays: 60,
    providerSessionRetentionDays: 60,
    fileAssetCacheRetentionDays: 14,
    apiLogRetentionDays: 30,
    tempRetentionDays: 7,
    publicStagingRetentionDays: 3,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--run-retention-days') {
      options.runRetentionDays = parseNonNegativeNumber(argv[index += 1], options.runRetentionDays);
    } else if (arg === '--provider-session-retention-days') {
      options.providerSessionRetentionDays = parseNonNegativeNumber(
        argv[index += 1],
        options.providerSessionRetentionDays,
      );
    } else if (arg === '--file-asset-cache-retention-days') {
      options.fileAssetCacheRetentionDays = parseNonNegativeNumber(
        argv[index += 1],
        options.fileAssetCacheRetentionDays,
      );
    } else if (arg === '--api-log-retention-days') {
      options.apiLogRetentionDays = parseNonNegativeNumber(
        argv[index += 1],
        options.apiLogRetentionDays,
      );
    } else if (arg === '--temp-retention-days') {
      options.tempRetentionDays = parseNonNegativeNumber(argv[index += 1], options.tempRetentionDays);
    } else if (arg === '--public-staging-retention-days') {
      options.publicStagingRetentionDays = parseNonNegativeNumber(
        argv[index += 1],
        options.publicStagingRetentionDays,
      );
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return `Usage: node scripts/storage-hygiene.mjs [options]

Safely prune regenerable RemoteLab runtime data. The default is a dry run.

Options:
  --apply                              Delete matching data
  --dry-run                            Report only (default)
  --json                               Emit JSON
  --run-retention-days <days>          Terminal chat-run retention (default: 60)
  --provider-session-retention-days <days>
                                       Raw provider transcript retention (default: 60)
  --file-asset-cache-retention-days <days>
                                       Regenerable localized attachment cache retention (default: 14)
  --api-log-retention-days <days>      Daily API request log retention (default: 30)
  --temp-retention-days <days>         Instance temp retention (default: 7)
  --public-staging-retention-days <days>
                                       Published temporary-dir retention (default: 3)
  -h, --help                           Show this help`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirectories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

async function inspectTree(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { bytes: 0, files: 0, latestMtimeMs: 0 };
  }

  if (!info.isDirectory()) {
    return {
      bytes: info.size,
      files: 1,
      latestMtimeMs: info.mtimeMs,
    };
  }

  let entries = [];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0, latestMtimeMs: info.mtimeMs };
  }

  const children = await Promise.all(entries.map((entry) => inspectTree(join(path, entry.name))));
  return children.reduce((summary, child) => ({
    bytes: summary.bytes + child.bytes,
    files: summary.files + child.files,
    latestMtimeMs: Math.max(summary.latestMtimeMs, child.latestMtimeMs),
  }), { bytes: 0, files: 0, latestMtimeMs: info.mtimeMs });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function discoverRoots() {
  const home = resolve(process.env.REMOTELAB_STORAGE_HYGIENE_HOME || homedir());
  const instanceRoot = resolve(
    process.env.REMOTELAB_STORAGE_HYGIENE_INSTANCE_ROOT || join(home, '.remotelab', 'instances'),
  );
  const guestRoot = resolve(
    process.env.REMOTELAB_STORAGE_HYGIENE_GUEST_ROOT || '/var/lib/remotelab-guests',
  );
  const publicPagesRoot = resolve(
    process.env.REMOTELAB_STORAGE_HYGIENE_PUBLIC_PAGES_ROOT
      || join(scriptDir, '..', 'static', 'public-pages'),
  );
  const instanceHomes = [
    ...(await listDirectories(instanceRoot)),
    ...(await listDirectories(guestRoot)),
  ];
  const configRoots = new Set([join(home, '.config', 'remotelab')]);
  const tempRoots = new Set();
  const providerSessionRoots = new Set([join(home, '.codex', 'sessions')]);

  for (const instanceHome of instanceHomes) {
    const configRoot = join(instanceHome, 'config');
    if (await pathExists(configRoot)) configRoots.add(configRoot);
    const tempRoot = join(instanceHome, 'tmp');
    if (await pathExists(tempRoot)) tempRoots.add(tempRoot);
    const providerSessions = join(instanceHome, '.codex', 'sessions');
    if (await pathExists(providerSessions)) providerSessionRoots.add(providerSessions);
  }

  for (const configRoot of configRoots) {
    const managedProviderSessions = join(configRoot, 'provider-runtime-homes', 'codex', 'sessions');
    if (await pathExists(managedProviderSessions)) providerSessionRoots.add(managedProviderSessions);
  }

  return {
    configRoots: [...configRoots],
    providerSessionRoots: [...providerSessionRoots],
    publicPagesRoot,
    tempRoots: [...tempRoots],
  };
}

function olderThan(latestMtimeMs, days, nowMs) {
  return latestMtimeMs > 0 && latestMtimeMs < nowMs - (days * DAY_MS);
}

async function addCandidate(candidates, category, path, inspection, metadata = {}) {
  candidates.push({ category, path, ...inspection, ...metadata });
}

async function collectRunCandidates(candidates, configRoots, options) {
  for (const configRoot of configRoots) {
    const runsRoot = join(configRoot, 'chat-runs');
    for (const runPath of await listDirectories(runsRoot)) {
      const status = await readJson(join(runPath, 'status.json'));
      if (!TERMINAL_RUN_STATES.has(String(status?.state || '').toLowerCase())) continue;
      const inspection = await inspectTree(runPath);
      const statusTime = Date.parse(status?.updatedAt || status?.completedAt || status?.finalizedAt || '');
      const latestMtimeMs = Number.isFinite(statusTime)
        ? Math.max(inspection.latestMtimeMs, statusTime)
        : inspection.latestMtimeMs;
      if (!olderThan(latestMtimeMs, options.runRetentionDays, options.nowMs)) continue;
      await addCandidate(candidates, 'terminal-chat-run', runPath, {
        ...inspection,
        latestMtimeMs,
      }, { state: status.state });
    }
  }
}

async function collectOldFiles(candidates, root, category, retentionDays, options) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectOldFiles(candidates, path, category, retentionDays, options);
      continue;
    }
    if (!entry.isFile()) continue;
    const inspection = await inspectTree(path);
    if (olderThan(inspection.latestMtimeMs, retentionDays, options.nowMs)) {
      await addCandidate(candidates, category, path, inspection);
    }
  }
}

async function collectTempCandidates(candidates, tempRoots, options) {
  for (const tempRoot of tempRoots) {
    let entries = [];
    try {
      entries = await readdir(tempRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(tempRoot, entry.name);
      const inspection = await inspectTree(path);
      if (olderThan(inspection.latestMtimeMs, options.tempRetentionDays, options.nowMs)) {
        await addCandidate(candidates, 'instance-temp', path, inspection);
      }
    }
  }
}

function isPublishedStagingName(name) {
  return name === 'tmp' || name === 'tmp-qa' || name.startsWith('tmp-');
}

async function collectPublishedStagingCandidates(candidates, publicPagesRoot, options) {
  for (const pageRoot of await listDirectories(publicPagesRoot)) {
    let entries = [];
    try {
      entries = await readdir(pageRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isPublishedStagingName(entry.name)) continue;
      const path = join(pageRoot, entry.name);
      const inspection = await inspectTree(path);
      if (olderThan(inspection.latestMtimeMs, options.publicStagingRetentionDays, options.nowMs)) {
        await addCandidate(candidates, 'published-staging', path, inspection);
      }
    }
  }
}

function summarize(candidates) {
  const categories = {};
  for (const candidate of candidates) {
    const category = categories[candidate.category] || { bytes: 0, files: 0, paths: 0 };
    category.bytes += candidate.bytes;
    category.files += candidate.files;
    category.paths += 1;
    categories[candidate.category] = category;
  }
  return {
    bytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
    files: candidates.reduce((total, candidate) => total + candidate.files, 0),
    paths: candidates.length,
    categories,
  };
}

async function run(options) {
  const roots = await discoverRoots();
  const candidates = [];
  await collectRunCandidates(candidates, roots.configRoots, options);
  for (const providerRoot of roots.providerSessionRoots) {
    await collectOldFiles(
      candidates,
      providerRoot,
      'raw-provider-session',
      options.providerSessionRetentionDays,
      options,
    );
  }
  for (const configRoot of roots.configRoots) {
    await collectOldFiles(
      candidates,
      join(configRoot, 'file-assets-cache'),
      'file-asset-cache',
      options.fileAssetCacheRetentionDays,
      options,
    );
    await collectOldFiles(
      candidates,
      join(configRoot, 'api-logs'),
      'api-log',
      options.apiLogRetentionDays,
      options,
    );
  }
  await collectTempCandidates(candidates, roots.tempRoots, options);
  await collectPublishedStagingCandidates(candidates, roots.publicPagesRoot, options);

  const before = summarize(candidates);
  const failures = [];
  if (options.apply) {
    for (const candidate of candidates) {
      try {
        await rm(candidate.path, { recursive: true, force: true });
      } catch (error) {
        failures.push({ path: candidate.path, error: error.message });
      }
    }
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    retentionDays: {
      terminalChatRuns: options.runRetentionDays,
      rawProviderSessions: options.providerSessionRetentionDays,
      fileAssetCache: options.fileAssetCacheRetentionDays,
      apiLogs: options.apiLogRetentionDays,
      instanceTemp: options.tempRetentionDays,
      publishedStaging: options.publicStagingRetentionDays,
    },
    summary: before,
    failures,
  };
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function main() {
  const options = parseOptions();
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await run(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.mode}: ${result.summary.paths} paths, ${result.summary.files} files, ${formatBytes(result.summary.bytes)}`);
  for (const [category, summary] of Object.entries(result.summary.categories)) {
    console.log(`- ${category}: ${summary.paths} paths, ${summary.files} files, ${formatBytes(summary.bytes)}`);
  }
  if (result.failures.length > 0) {
    console.error(`Failures: ${result.failures.length}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
