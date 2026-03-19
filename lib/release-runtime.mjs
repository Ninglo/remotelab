import { execFileSync } from 'child_process';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SOURCE_PROJECT_ROOT = resolve(__dirname, '..');
export const RELEASE_RUNTIME_DIR = join(SOURCE_PROJECT_ROOT, '.remotelab-runtime');
export const RELEASES_DIR = join(RELEASE_RUNTIME_DIR, 'releases');
export const ACTIVE_RELEASE_FILE = join(RELEASE_RUNTIME_DIR, 'active-release.json');
export const RELEASE_METADATA_FILENAME = '.remotelab-release.json';
export const RELEASE_RUNTIME_ENTRIES = [
  'chat-server.mjs',
  'chat',
  'lib',
  'static',
  'templates',
  'package.json',
  'memory',
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(trimString(value).toLowerCase());
}

export function shouldUseActiveRelease() {
  if (isTruthyEnv(process.env.REMOTELAB_DISABLE_ACTIVE_RELEASE)) {
    return false;
  }
  if (isTruthyEnv(process.env.REMOTELAB_ENABLE_ACTIVE_RELEASE)) {
    return true;
  }
  const configuredPort = trimString(process.env.CHAT_PORT);
  return !configuredPort || configuredPort === '7690';
}

export function sanitizeReleaseId(value) {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'release';
}

export function formatMtimeFingerprint(mtimeMs, fallbackSeed = Date.now()) {
  const numericValue = Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : fallbackSeed;
  return Math.round(numericValue).toString(36);
}

export function createReleaseId({ createdAt = new Date(), version = '', commit = '' } = {}) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const stamp = [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
    'T',
    date.getUTCHours().toString().padStart(2, '0'),
    date.getUTCMinutes().toString().padStart(2, '0'),
    date.getUTCSeconds().toString().padStart(2, '0'),
    'Z',
  ].join('');
  const suffix = sanitizeReleaseId(commit || version || 'release').slice(0, 12);
  return `${stamp}-${suffix}`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writeJsonAtomic(path, payload) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

async function validateSnapshotRoot(snapshotRoot, manifest = {}) {
  const resolvedRoot = resolve(snapshotRoot);
  const entryPath = join(resolvedRoot, 'chat-server.mjs');
  if (!await pathExists(entryPath)) {
    return null;
  }
  const metadata = await readReleaseMetadata(resolvedRoot);
  return {
    releaseId: trimString(manifest.releaseId || metadata?.releaseId || resolvedRoot.split('/').pop()),
    snapshotRoot: resolvedRoot,
    sourceRoot: trimString(manifest.sourceRoot || metadata?.sourceRoot || SOURCE_PROJECT_ROOT),
    createdAt: trimString(manifest.createdAt || metadata?.createdAt),
    activatedAt: trimString(manifest.activatedAt),
  };
}

export function resolveActiveReleaseManifestPath() {
  const explicitPath = trimString(process.env.REMOTELAB_ACTIVE_RELEASE_FILE);
  return explicitPath ? resolve(explicitPath) : ACTIVE_RELEASE_FILE;
}

export async function readActiveReleaseManifest() {
  const explicitSnapshotRoot = trimString(process.env.REMOTELAB_ACTIVE_RELEASE_ROOT);
  if (explicitSnapshotRoot) {
    return validateSnapshotRoot(explicitSnapshotRoot, {
      releaseId: trimString(process.env.REMOTELAB_ACTIVE_RELEASE_ID),
      sourceRoot: trimString(process.env.REMOTELAB_SOURCE_PROJECT_ROOT || SOURCE_PROJECT_ROOT),
    });
  }

  const manifestPath = resolveActiveReleaseManifestPath();
  const manifest = await readJsonFile(manifestPath);
  if (!manifest || typeof manifest !== 'object') {
    return null;
  }

  const snapshotRoot = trimString(manifest.snapshotRoot);
  if (!snapshotRoot) {
    return null;
  }
  return validateSnapshotRoot(snapshotRoot, manifest);
}

export async function activateRelease(releaseMetadata) {
  const manifest = {
    releaseId: trimString(releaseMetadata?.releaseId),
    snapshotRoot: resolve(trimString(releaseMetadata?.snapshotRoot || '')),
    sourceRoot: trimString(releaseMetadata?.sourceRoot || SOURCE_PROJECT_ROOT),
    createdAt: trimString(releaseMetadata?.createdAt),
    activatedAt: new Date().toISOString(),
  };
  if (!manifest.releaseId || !manifest.snapshotRoot) {
    throw new Error('Cannot activate a release without releaseId and snapshotRoot');
  }
  await writeJsonAtomic(ACTIVE_RELEASE_FILE, manifest);
  return manifest;
}

export async function clearActiveRelease() {
  await rm(ACTIVE_RELEASE_FILE, { force: true });
}

async function getLatestMtimeMs(path) {
  let entryStat;
  try {
    entryStat = await stat(path);
  } catch {
    return 0;
  }

  const ownMtime = Number.isFinite(entryStat.mtimeMs) ? entryStat.mtimeMs : 0;
  if (!entryStat.isDirectory()) {
    return ownMtime;
  }

  let entries = [];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return ownMtime;
  }

  const nestedTimes = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => getLatestMtimeMs(join(path, entry.name))),
  );

  return Math.max(ownMtime, ...nestedTimes, 0);
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: SOURCE_PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function hasDirtyRepoPaths(paths) {
  try {
    return execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all', '--', ...paths],
      {
        cwd: SOURCE_PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim().length > 0;
  } catch {
    return false;
  }
}

export async function collectSourceReleaseMetadata() {
  const packageJson = await readJsonFile(join(SOURCE_PROJECT_ROOT, 'package.json'));
  const sourceVersion = trimString(packageJson?.version) || 'dev';
  const sourceCommit = gitOutput(['rev-parse', '--short', 'HEAD']);
  const sourceDirty = hasDirtyRepoPaths(RELEASE_RUNTIME_ENTRIES);
  let latestMtimeMs = 0;
  for (const entry of RELEASE_RUNTIME_ENTRIES) {
    latestMtimeMs = Math.max(latestMtimeMs, await getLatestMtimeMs(join(SOURCE_PROJECT_ROOT, entry)));
  }
  return {
    sourceRoot: SOURCE_PROJECT_ROOT,
    sourceVersion,
    sourceCommit,
    sourceDirty,
    sourceFingerprint: formatMtimeFingerprint(latestMtimeMs),
  };
}

export async function createReleaseSnapshot(options = {}) {
  const metadata = {
    ...(await collectSourceReleaseMetadata()),
    ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}),
  };
  const createdAt = new Date().toISOString();
  const releaseId = sanitizeReleaseId(
    options.releaseId || createReleaseId({
      createdAt,
      version: metadata.sourceVersion,
      commit: metadata.sourceCommit,
    }),
  );
  const snapshotRoot = join(RELEASES_DIR, releaseId);

  await mkdir(RELEASES_DIR, { recursive: true });
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(snapshotRoot, { recursive: true });

  for (const entry of RELEASE_RUNTIME_ENTRIES) {
    await cp(join(SOURCE_PROJECT_ROOT, entry), join(snapshotRoot, entry), {
      recursive: true,
      force: true,
    });
  }

  const releaseMetadata = {
    releaseId,
    createdAt,
    snapshotRoot,
    ...metadata,
  };
  await writeJsonAtomic(join(snapshotRoot, RELEASE_METADATA_FILENAME), releaseMetadata);
  return releaseMetadata;
}

export async function readReleaseMetadata(snapshotRoot) {
  const metadata = await readJsonFile(join(snapshotRoot, RELEASE_METADATA_FILENAME));
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  return {
    ...metadata,
    releaseId: trimString(metadata.releaseId),
    snapshotRoot: resolve(trimString(metadata.snapshotRoot || snapshotRoot)),
    sourceRoot: trimString(metadata.sourceRoot || SOURCE_PROJECT_ROOT),
    createdAt: trimString(metadata.createdAt),
  };
}

export async function listReleaseSnapshots() {
  let entries = [];
  try {
    entries = await readdir(RELEASES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const snapshotRoot = join(RELEASES_DIR, entry.name);
    const metadata = await readReleaseMetadata(snapshotRoot);
    if (metadata?.releaseId) {
      releases.push(metadata);
    }
  }

  releases.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || '') || 0;
    const rightTime = Date.parse(right.createdAt || '') || 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return right.releaseId.localeCompare(left.releaseId);
  });
  return releases;
}
