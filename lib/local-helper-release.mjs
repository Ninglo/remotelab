import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { mkdir, readFile, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

import { CONFIG_DIR } from './config.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const LOCAL_HELPER_DIR = join(PROJECT_ROOT, 'local-helper');
const LOCAL_HELPER_RELEASES_DIR = join(CONFIG_DIR, 'local-helper-releases');
const LOCAL_HELPER_RELEASE_VERSION = '0.2.0';
const SUPPORTED_RELEASES = new Map([
  ['darwin:arm64', { platform: 'darwin', arch: 'arm64' }],
  ['darwin:amd64', { platform: 'darwin', arch: 'amd64' }],
  ['linux:arm64', { platform: 'linux', arch: 'arm64' }],
  ['linux:amd64', { platform: 'linux', arch: 'amd64' }],
  ['windows:amd64', { platform: 'windows', arch: 'amd64' }],
]);

const inflightBuilds = new Map();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatform(platform) {
  return trimString(platform).toLowerCase();
}

function normalizeArch(arch) {
  const normalized = trimString(arch).toLowerCase();
  if (normalized === 'x64') return 'amd64';
  if (normalized === 'aarch64') return 'arm64';
  return normalized;
}

function releaseKey(platform, arch) {
  return `${normalizePlatform(platform)}:${normalizeArch(arch)}`;
}

function resolveSupportedRelease(platform, arch) {
  const supported = SUPPORTED_RELEASES.get(releaseKey(platform, arch)) || null;
  if (!supported) {
    const error = new Error(`Unsupported helper release target: ${platform}/${arch}`);
    error.statusCode = 400;
    throw error;
  }
  return supported;
}

function buildReleaseFilename(platform, arch) {
  const suffix = platform === 'windows' ? '.exe' : '';
  return `remotelab-helper-${platform}-${arch}${suffix}`;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function buildReleaseBinary(target) {
  const filename = buildReleaseFilename(target.platform, target.arch);
  const outputDir = join(
    LOCAL_HELPER_RELEASES_DIR,
    LOCAL_HELPER_RELEASE_VERSION,
    target.platform,
    target.arch,
  );
  const binaryPath = join(outputDir, filename);

  try {
    const stats = await stat(binaryPath);
    return {
      version: LOCAL_HELPER_RELEASE_VERSION,
      platform: target.platform,
      arch: target.arch,
      filename,
      binaryPath,
      sizeBytes: stats.size,
      publishedAt: stats.mtime.toISOString(),
      sha256: await sha256File(binaryPath),
    };
  } catch {}

  await mkdir(outputDir, { recursive: true });
  await execFileAsync('go', ['build', '-o', binaryPath, './cmd/remotelab-helper'], {
    cwd: LOCAL_HELPER_DIR,
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOOS: target.platform,
      GOARCH: target.arch,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });

  const stats = await stat(binaryPath);
  return {
    version: LOCAL_HELPER_RELEASE_VERSION,
    platform: target.platform,
    arch: target.arch,
    filename,
    binaryPath,
    sizeBytes: stats.size,
    publishedAt: stats.mtime.toISOString(),
    sha256: await sha256File(binaryPath),
  };
}

export async function ensureLocalHelperRelease(platform, arch) {
  const target = resolveSupportedRelease(platform, arch);
  const key = releaseKey(target.platform, target.arch);
  const running = inflightBuilds.get(key);
  if (running) return running;

  const promise = buildReleaseBinary(target).finally(() => {
    inflightBuilds.delete(key);
  });
  inflightBuilds.set(key, promise);
  return promise;
}

export function buildLocalHelperReleaseDownloadPath(release) {
  return `/api/local-bridge/helper/releases/download?platform=${encodeURIComponent(release.platform)}&arch=${encodeURIComponent(release.arch)}&version=${encodeURIComponent(release.version)}`;
}

export function buildLocalHelperReleaseManifest(release, baseUrl = '') {
  const downloadPath = buildLocalHelperReleaseDownloadPath(release);
  const normalizedBaseUrl = trimString(baseUrl).replace(/\/+$/, '');
  const downloadUrl = normalizedBaseUrl ? `${normalizedBaseUrl}${downloadPath}` : downloadPath;
  return {
    release: {
      version: release.version,
      platform: release.platform,
      arch: release.arch,
      filename: release.filename,
      sizeBytes: release.sizeBytes,
      sha256: release.sha256,
      publishedAt: release.publishedAt,
      downloadPath,
      downloadUrl,
    },
  };
}
