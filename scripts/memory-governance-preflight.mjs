#!/usr/bin/env node
// Manual preparation only: no collector, model calls, worker launch or production writer.
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = data => createHash('sha256').update(data).digest('hex');
const labelPattern = /^[a-z0-9_-]{1,64}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maxSourceBytes = 5 * 1024 * 1024;
const maxBaselineBytes = 50 * 1024 * 1024;
const maxSources = 128;
const permissions = ['collection', 'foregroundRetrieval', 'formalWrites', 'delivery', 'skillPromotion', 'businessActions'];
const resources = ['modelCalls', 'workerConcurrency', 'backfillTokens', 'dailyTokens'];
const activationBlockedReasons = [
  'This tool supports preparation only; no collector or runtime activation is implemented.',
  'All registered projects and source gaps need a verified coverage inventory.',
  'A real execution boundary must deny production writes and unauthorized delivery.',
  'Foreground-priority resource budgets and one writer per overlapping source need runtime enforcement.',
  'Matched quality/performance evaluation and independent switch-off/fallback need verification.',
];

function within(root, path) {
  const r = relative(root, path);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
}

async function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Paths must be explicit and absolute.');
  const suffix = [];
  let parent = resolve(path);
  while (true) {
    try { return join(await realpath(parent), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (dirname(parent) === parent) throw error;
      suffix.push(parent.slice(dirname(parent).length + (dirname(parent) === sep ? 0 : 1)));
      parent = dirname(parent);
    }
  }
}

export async function validateWorkspace(workspace, protectedRoots) {
  if (!Array.isArray(protectedRoots) || !protectedRoots.length) throw new Error('Protected roots must be supplied.');
  const root = await canonical(workspace);
  const protectedPaths = await Promise.all(protectedRoots.map(canonical));
  if (protectedPaths.some(p => within(p, root) || within(root, p))) {
    throw new Error('Workspace overlaps a protected production or native-memory location.');
  }
  return { root, protectedPaths };
}

function exactKeys(value, keys, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) {
    throw new Error('Invalid ' + description + ' fields.');
  }
}

export function validatePreparationPolicy(policy) {
  exactKeys(policy, ['schemaVersion', 'stage', 'permissions', 'resources', 'foreground', 'scope'], 'policy');
  if (policy.schemaVersion !== 1 || policy.stage !== 'prepared') throw new Error('Only prepared stage is supported.');
  exactKeys(policy.permissions, permissions, 'permission');
  if (permissions.some(k => policy.permissions[k] !== false)) throw new Error('All activation permissions must remain false.');
  exactKeys(policy.resources, resources, 'resource');
  if (resources.some(k => policy.resources[k] !== 0)) throw new Error('Preparation permits zero model calls, workers and token budgets.');
  exactKeys(policy.foreground, ['extraRequiredModelCalls', 'unrelatedProjectInjection'], 'foreground');
  if (Object.values(policy.foreground).some(v => v !== 0)) throw new Error('Foreground additions must remain zero.');
  exactKeys(policy.scope, ['allRegisteredProjectsRequired', 'coverage'], 'scope');
  if (policy.scope.allRegisteredProjectsRequired !== true || policy.scope.coverage !== 'unverified') {
    throw new Error('Preparation cannot certify collection coverage.');
  }
}

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Snapshot files must be regular, independent files.');
  if (info.size > maxSourceBytes) throw new Error('Preparation file exceeds the 5 MiB limit.');
}

async function newFile(path, data) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(data); }
  finally { await handle.close(); }
}

export async function prepareMemoryWorkspace({ workspace, protectedRoots, sources }) {
  const { root, protectedPaths } = await validateWorkspace(workspace, protectedRoots);
  if (!Array.isArray(sources) || !sources.length || sources.length > maxSources) throw new Error('Preparation requires 1 to 128 explicit baseline sources.');
  const labels = new Set();
  const normalized = [];
  for (const source of sources) {
    if (!labelPattern.test(source.label || '') || labels.has(source.label)) throw new Error('Invalid or duplicate source label.');
    labels.add(source.label);
    const path = await canonical(source.path);
    if (!protectedPaths.some(p => within(p, path))) throw new Error('Baseline source must belong to a protected location.');
    normalized.push({ label: source.label, path });
  }
  try {
    if ((await readdir(root)).length) throw new Error('Preparation workspace must be empty; existing material is never replaced.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new Error('Workspace path changed during preparation.');
  await chmod(root, 0o700);
  await mkdir(join(root, 'baseline'), { mode: 0o700 });
  const entries = [];
  let capturedBytes = 0;
  for (const source of normalized) {
    let data;
    try {
      const before = await stat(source.path);
      if (!before.isFile()) throw new Error('Baseline source must be a regular file: ' + source.label);
      if (before.size > maxSourceBytes || capturedBytes + before.size > maxBaselineBytes) throw new Error('Preparation baseline size limit exceeded.');
      data = await readFile(source.path);
      const after = await stat(source.path);
      if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== after.size) {
        throw new Error('Baseline source changed during capture: ' + source.label);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries.push({ ...source, missing: true }); continue;
    }
    capturedBytes += data.length;
    const sha256 = hash(data);
    await newFile(join(root, 'baseline', source.label + '-' + sha256 + '.blob'), data);
    entries.push({ ...source, missing: false, sha256, bytes: data.length, capturedAt: new Date().toISOString() });
  }
  if (!entries.some(e => !e.missing)) throw new Error('No baseline source was captured.');
  const policy = {
    schemaVersion: 1, stage: 'prepared',
    permissions: Object.fromEntries(permissions.map(k => [k, false])),
    resources: Object.fromEntries(resources.map(k => [k, 0])),
    foreground: { extraRequiredModelCalls: 0, unrelatedProjectInjection: 0 },
    scope: { allRegisteredProjectsRequired: true, coverage: 'unverified' },
  };
  await newFile(join(root, 'baseline.json'), JSON.stringify({ schemaVersion: 1, workspace: root, entries }, null, 2) + '\n');
  await newFile(join(root, 'policy.json'), JSON.stringify(policy, null, 2) + '\n');
  return checkMemoryWorkspace({ workspace: root, protectedRoots });
}

export async function checkMemoryWorkspace({ workspace, protectedRoots }) {
  const { root, protectedPaths } = await validateWorkspace(workspace, protectedRoots);
  for (const name of ['policy.json', 'baseline.json']) await regularFile(join(root, name));
  const policy = JSON.parse(await readFile(join(root, 'policy.json'), 'utf8'));
  validatePreparationPolicy(policy);
  const baseline = JSON.parse(await readFile(join(root, 'baseline.json'), 'utf8'));
  if (baseline.schemaVersion !== 1 || baseline.workspace !== root || !Array.isArray(baseline.entries) || !baseline.entries.length || baseline.entries.length > maxSources) {
    throw new Error('Invalid baseline manifest.');
  }
  if (!baseline.entries.some(e => e.missing === false)) throw new Error('Baseline has no captured source.');
  const dir = await lstat(join(root, 'baseline'));
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Baseline directory cannot be a link.');
  const changedSources = [], missingSources = [], seen = new Set();
  let capturedBytes = 0;
  for (const entry of baseline.entries) {
    if (!labelPattern.test(entry.label || '') || seen.has(entry.label)) throw new Error('Invalid baseline label.');
    seen.add(entry.label);
    if (typeof entry.missing !== 'boolean' || await canonical(entry.path) !== entry.path
        || !protectedPaths.some(p => within(p, entry.path))) throw new Error('Invalid baseline source location.');
    if (entry.missing) {
      missingSources.push(entry.label);
      try { await lstat(entry.path); changedSources.push(entry.label); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    if (!hashPattern.test(entry.sha256 || '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maxSourceBytes) throw new Error('Invalid baseline fingerprint.');
    capturedBytes += entry.bytes;
    if (capturedBytes > maxBaselineBytes) throw new Error('Preparation baseline size limit exceeded.');
    const blob = join(root, 'baseline', entry.label + '-' + entry.sha256 + '.blob');
    await regularFile(blob);
    const data = await readFile(blob);
    if (data.length !== entry.bytes || hash(data) !== entry.sha256) throw new Error('Baseline snapshot integrity failed.');
    try {
      const current = await stat(entry.path);
      if (!current.isFile() || current.size !== entry.bytes || hash(await readFile(entry.path)) !== entry.sha256) changedSources.push(entry.label);
    }
    catch (error) { if (error.code === 'ENOENT') changedSources.push(entry.label); else throw error; }
  }
  return {
    ok: changedSources.length === 0, stage: 'prepared', workspace: root,
    snapshotCount: baseline.entries.length - missingSources.length,
    changedSources, missingSources, readyForCollection: false, activationBlockedReasons,
    boundary: 'This tool checks its preparation writes and snapshots. It is not a filesystem sandbox for an unrestricted Agent, a rollback command, or a runtime admission mechanism.',
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Preparation only; never launches collection or changes production.\nUsage: node scripts/memory-governance-preflight.mjs prepare --workspace <absolute-empty-dir> --sources <json-file>\n       node scripts/memory-governance-preflight.mjs check --workspace <absolute-dir>\nSources file: [{"label":"project-ledger","path":"/absolute/protected/file"}].\nReturns readyForCollection=false even when preparation is valid.');
    return;
  }
  const [command, ...rest] = args, options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--workspace', '--sources'].includes(rest[i]) || !rest[i + 1] || options[rest[i]]) throw new Error('Invalid or repeated arguments.');
    options[rest[i]] = rest[i + 1];
  }
  if (!['prepare', 'check'].includes(command) || !options['--workspace']) throw new Error('Use --help for preparation commands.');
  if (command === 'check' && options['--sources']) throw new Error('check cannot replace baseline sources.');
  const repo = fileURLToPath(new URL('../', import.meta.url)), home = homedir();
  const protectedRoots = [
    process.env.REMOTELAB_CONFIG_DIR || join(home, '.config/remotelab'),
    process.env.REMOTELAB_MEMORY_DIR || join(home, '.remotelab/memory'),
    join(home, '.codex'), repo,
    process.env.REMOTELAB_PROJECT_ROOT || repo,
    join(home, '.remotelab/workspace/project-knowledge'),
  ];
  const params = { workspace: options['--workspace'], protectedRoots };
  const report = command === 'prepare'
    ? await prepareMemoryWorkspace({ ...params, sources: JSON.parse(await readFile(options['--sources'], 'utf8')) })
    : await checkMemoryWorkspace(params);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, readyForCollection: false, error: error.message })); process.exitCode = 2; });
}
