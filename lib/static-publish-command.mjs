import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'fs/promises';
import { randomBytes } from 'crypto';
import { basename, extname, join, relative, resolve, sep } from 'path';

import {
  CHAT_BIND_HOST,
  CHAT_PORT,
  PUBLIC_PAGES_BASE_URL,
  PUBLIC_PAGES_DIR,
} from './config.mjs';

const DEFAULT_ENTRY = 'index.html';
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const SKIP_NAMES = new Set(['.git', '.hg', '.svn', 'node_modules', '__pycache__', '_publish']);
const METADATA_FILE = '_remote_publish.json';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function usage() {
  return `Usage:
  remotelab publish static --source <file-or-directory> [options]
  remotelab publish list [--json]
  remotelab publish delete <slug> [--json]

Static options:
  --slug <slug>            Stable path name (default: source name + UTC timestamp)
  --entry <path>           Directory entry file or HTML output name (default: index.html)
  --replace                Replace an existing slug atomically
  --max-bytes <bytes>      Maximum publishable source size (default: ${DEFAULT_MAX_BYTES})
  --allow-large            Allow a source above the size limit after explicit review
  --public-base <url>      Override the configured /public-pages URL base
  --no-verify              Skip URL verification
  --json                   Print JSON

Published files are stored in the instance data directory, never in the RemoteLab Git checkout.`;
}

function normalizeSlug(value) {
  const slug = trimString(value).toLowerCase();
  if (!slug || !/^[a-z0-9][a-z0-9._-]*$/.test(slug) || slug === '.' || slug === '..') {
    throw new Error(`Invalid static publish slug: ${value || '(missing)'}`);
  }
  return slug;
}

function slugify(value) {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return normalized && /^[a-z0-9]/.test(normalized) ? normalized : 'page';
}

function defaultSlug(sourcePath, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
  const sourceName = basename(sourcePath, extname(sourcePath));
  return normalizeSlug(`${slugify(sourceName)}-${stamp}`);
}

function normalizeEntry(value) {
  const entry = trimString(value) || DEFAULT_ENTRY;
  if (entry.startsWith('/') || entry.startsWith('\\')) {
    throw new Error(`Invalid static publish entry: ${entry}`);
  }
  const segments = entry.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment.startsWith('.'))) {
    throw new Error(`Invalid static publish entry: ${entry}`);
  }
  return segments.join('/');
}

function ensurePathInside(rootPath, candidatePath) {
  const rel = relative(rootPath, candidatePath);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`Unsafe static publish path: ${candidatePath}`);
  }
}

function shouldSkip(name) {
  return SKIP_NAMES.has(name)
    || name === METADATA_FILE
    || name.startsWith('.')
    || name.endsWith('.tmp')
    || name.endsWith('.bak')
    || name.endsWith('~');
}

async function inspectSource(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Static publish does not follow symbolic links: ${path}`);
  }
  if (info.isFile()) {
    return { bytes: info.size, files: 1 };
  }
  if (!info.isDirectory()) {
    throw new Error(`Static publish source must be a file or directory: ${path}`);
  }

  const entries = await readdir(path, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    if (shouldSkip(entry.name)) return { bytes: 0, files: 0 };
    if (entry.isSymbolicLink()) {
      throw new Error(`Static publish does not follow symbolic links: ${join(path, entry.name)}`);
    }
    return inspectSource(join(path, entry.name));
  }));
  return children.reduce((summary, child) => ({
    bytes: summary.bytes + child.bytes,
    files: summary.files + child.files,
  }), { bytes: 0, files: 0 });
}

async function copyDirectoryContents(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Static publish does not follow symbolic links: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await mkdir(resolve(targetPath, '..'), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function buildPublishedUrl(baseUrl, slug, entry) {
  const base = trimString(baseUrl).replace(/\/+$/, '');
  if (!base) return '';
  const encodedSlug = encodeURIComponent(slug);
  const encodedEntry = entry.split('/').map(encodeURIComponent).join('/');
  return `${base}/${encodedSlug}/${encodedEntry}`;
}

async function verifyPublishedUrl(url, expectHtml) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'remotelab-static-publish/1.0' },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const ok = response.status >= 200
      && response.status < 300
      && (!expectHtml || contentType.toLowerCase().includes('text/html'));
    return {
      ok,
      status: response.status,
      contentType,
      location: response.headers.get('location') || '',
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function resolveLocalBaseUrl() {
  const host = ['0.0.0.0', '::'].includes(CHAT_BIND_HOST) ? '127.0.0.1' : CHAT_BIND_HOST;
  return `http://${host}:${CHAT_PORT}/public-pages`;
}

export async function publishStaticSource(options = {}) {
  const sourcePath = resolve(trimString(options.source));
  if (!trimString(options.source)) throw new Error('publish static requires --source <path>');
  const sourceInfo = await pathInfo(sourcePath);
  if (!sourceInfo) throw new Error(`Static publish source does not exist: ${sourcePath}`);
  if (sourceInfo.isSymbolicLink() || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) {
    throw new Error(`Static publish source must be a regular file or directory: ${sourcePath}`);
  }

  const rootPath = resolve(trimString(options.root) || PUBLIC_PAGES_DIR);
  const slug = options.slug ? normalizeSlug(options.slug) : defaultSlug(sourcePath, options.now);
  const requestedEntry = normalizeEntry(options.entry);
  const targetPath = join(rootPath, slug);
  ensurePathInside(rootPath, targetPath);

  const inspection = await inspectSource(sourcePath);
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  if (inspection.bytes > maxBytes && options.allowLarge !== true) {
    throw new Error(
      `Static publish source is ${inspection.bytes} bytes, above the ${maxBytes}-byte limit. `
      + 'Reduce the output or pass --allow-large after reviewing it.',
    );
  }

  await mkdir(rootPath, { recursive: true });
  const existing = await pathInfo(targetPath);
  if (existing && options.replace !== true) {
    throw new Error(`Static publish slug already exists: ${slug}. Use --replace to update it.`);
  }

  const nonce = randomBytes(6).toString('hex');
  const stagingPath = join(rootPath, `.publish-${slug}-${nonce}`);
  const backupPath = join(rootPath, `.replace-${slug}-${nonce}`);
  let entry = requestedEntry;
  let backupCreated = false;

  try {
    await mkdir(stagingPath, { recursive: true });
    if (sourceInfo.isDirectory()) {
      await copyDirectoryContents(sourcePath, stagingPath);
      const stagedEntry = join(stagingPath, ...requestedEntry.split('/'));
      if (!(await pathInfo(stagedEntry))?.isFile()) {
        throw new Error(`Published directory has no entry file: ${requestedEntry}`);
      }
    } else {
      entry = ['.html', '.htm'].includes(extname(sourcePath).toLowerCase())
        ? requestedEntry
        : basename(sourcePath);
      const stagedEntry = join(stagingPath, ...entry.split('/'));
      ensurePathInside(stagingPath, stagedEntry);
      await mkdir(resolve(stagedEntry, '..'), { recursive: true });
      await copyFile(sourcePath, stagedEntry);
    }

    const configuredBaseUrl = trimString(options.publicBaseUrl) || PUBLIC_PAGES_BASE_URL;
    const localBaseUrl = resolveLocalBaseUrl();
    const publicUrl = buildPublishedUrl(configuredBaseUrl, slug, entry);
    const localUrl = buildPublishedUrl(localBaseUrl, slug, entry);
    const metadata = {
      schemaVersion: 1,
      slug,
      entry,
      publishedAt: (options.now || new Date()).toISOString(),
      sourceName: basename(sourcePath),
      bytes: inspection.bytes,
      files: inspection.files,
      publicUrl: publicUrl || null,
      localUrl,
    };
    await writeFile(join(stagingPath, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

    if (existing) {
      await rename(targetPath, backupPath);
      backupCreated = true;
    }
    await rename(stagingPath, targetPath);
    if (backupCreated) {
      await rm(backupPath, { recursive: true, force: true });
      backupCreated = false;
    }

    const verificationUrl = publicUrl || localUrl;
    const verification = options.verify === false
      ? null
      : await verifyPublishedUrl(verificationUrl, entry.toLowerCase().endsWith('.html'));
    return {
      ...metadata,
      root: rootPath,
      target: targetPath,
      url: publicUrl || localUrl,
      publiclyReachable: Boolean(publicUrl),
      verification,
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    if (backupCreated) {
      await rename(backupPath, targetPath).catch(() => {});
    }
    throw error;
  }
}

export async function listStaticPublications(options = {}) {
  const rootPath = resolve(trimString(options.root) || PUBLIC_PAGES_DIR);
  let entries = [];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const publications = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(async (entry) => {
      try {
        return JSON.parse(await readFile(join(rootPath, entry.name, METADATA_FILE), 'utf8'));
      } catch {
        return { slug: entry.name, metadataMissing: true };
      }
    }));
  return publications.sort((a, b) => trimString(b.publishedAt).localeCompare(trimString(a.publishedAt)));
}

export async function deleteStaticPublication(slugValue, options = {}) {
  const rootPath = resolve(trimString(options.root) || PUBLIC_PAGES_DIR);
  const slug = normalizeSlug(slugValue);
  const targetPath = join(rootPath, slug);
  ensurePathInside(rootPath, targetPath);
  if (!await pathInfo(targetPath)) {
    throw new Error(`Static publish slug does not exist: ${slug}`);
  }
  await rm(targetPath, { recursive: true, force: true });
  return { deleted: true, slug, target: targetPath };
}

function parseStaticOptions(args) {
  const options = {
    source: '',
    slug: '',
    entry: DEFAULT_ENTRY,
    replace: false,
    allowLarge: false,
    maxBytes: DEFAULT_MAX_BYTES,
    publicBaseUrl: '',
    verify: true,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const take = () => {
      const value = args[index += 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--source') options.source = take();
    else if (arg === '--slug') options.slug = take();
    else if (arg === '--entry') options.entry = take();
    else if (arg === '--replace') options.replace = true;
    else if (arg === '--allow-large') options.allowLarge = true;
    else if (arg === '--max-bytes') {
      const value = Number(take());
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid --max-bytes value');
      options.maxBytes = value;
    } else if (arg === '--public-base') options.publicBaseUrl = take();
    else if (arg === '--no-verify') options.verify = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown publish static option: ${arg}`);
  }
  return options;
}

function printPublications(publications, stdout) {
  if (publications.length === 0) {
    stdout.write('No static publications.\n');
    return;
  }
  for (const item of publications) {
    stdout.write(`${item.slug}\t${item.publishedAt || 'unknown'}\t${item.publicUrl || item.localUrl || ''}\n`);
  }
}

export async function runStaticPublishCommand(args = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const subcommand = trimString(args[0]).toLowerCase();

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  if (subcommand === 'static') {
    const options = parseStaticOptions(args.slice(1));
    if (options.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = await publishStaticSource(options);
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      stdout.write(`${result.url}\n`);
      if (!result.publiclyReachable) {
        stderr.write('Static page was published locally, but no public pages base URL is configured.\n');
      }
      if (result.verification && !result.verification.ok) {
        stderr.write(`Warning: static page verification failed: ${JSON.stringify(result.verification)}\n`);
      }
    }
    return result.verification && !result.verification.ok ? 2 : 0;
  }

  if (subcommand === 'list') {
    const json = args.includes('--json');
    const unknown = args.slice(1).filter((arg) => arg !== '--json');
    if (unknown.length > 0) throw new Error(`Unknown publish list option: ${unknown[0]}`);
    const publications = await listStaticPublications();
    if (json) stdout.write(`${JSON.stringify({ publications }, null, 2)}\n`);
    else printPublications(publications, stdout);
    return 0;
  }

  if (subcommand === 'delete') {
    const slug = args[1];
    const json = args.includes('--json');
    const unknown = args.slice(2).filter((arg) => arg !== '--json');
    if (unknown.length > 0) throw new Error(`Unknown publish delete option: ${unknown[0]}`);
    const result = await deleteStaticPublication(slug);
    stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `Deleted ${result.slug}\n`);
    return 0;
  }

  throw new Error(`Unknown publish command: ${subcommand}`);
}
