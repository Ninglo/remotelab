#!/usr/bin/env node
import { execFile as execFileCallback } from 'child_process';
import { readFile, readdir, stat } from 'fs/promises';
import { dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(__dirname, '..');
const execFileAsync = promisify(execFileCallback);
export const DEFAULT_BASELINE_FILE = 'scripts/oversized-files-baseline.json';

export const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.html', '.css']);
export const IGNORED_PATH_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.next',
  'storage',
  'tmp',
  '.wrangler',
]);
export const IGNORED_PATHS = new Set([
  'package-lock.json',
  'static/marked.min.js',
]);

export const DEFAULT_WARN_LINE_LIMITS = {
  '.mjs': 800,
  '.js': 800,
  '.html': 600,
  '.css': 700,
};

export const DEFAULT_FAIL_LINE_LIMITS = {
  '.mjs': 1200,
  '.js': 1200,
  '.html': 900,
  '.css': 1000,
};

function normalizeRelativePath(pathname) {
  return String(pathname || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function shouldIgnorePath(pathname) {
  const normalized = normalizeRelativePath(pathname);
  if (!normalized) return true;
  if (IGNORED_PATHS.has(normalized)) return true;
  const segments = normalized.split('/').filter(Boolean);
  return segments.some((segment) => segment.startsWith('.') || IGNORED_PATH_SEGMENTS.has(segment));
}

function isCandidateSourceFile(pathname) {
  const normalized = normalizeRelativePath(pathname);
  if (shouldIgnorePath(normalized)) return false;
  return SOURCE_EXTENSIONS.has(extname(normalized).toLowerCase());
}

function countLines(text) {
  if (!text) return 0;
  return String(text).split(/\r\n|\r|\n/).length;
}

async function listFilesFallback(rootDir, currentDir = rootDir, files = []) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const absolutePath = join(currentDir, entry.name);
    const relativePath = normalizeRelativePath(relative(rootDir, absolutePath));
    if (entry.isDirectory()) {
      if (shouldIgnorePath(relativePath)) continue;
      await listFilesFallback(rootDir, absolutePath, files);
      continue;
    }
    if (entry.isFile() && isCandidateSourceFile(relativePath)) {
      files.push(relativePath);
    }
  }
  return files;
}

export async function listCandidateFiles(rootDir = defaultRootDir) {
  const resolvedRoot = resolve(rootDir);
  try {
    const result = await execFileAsync('git', ['ls-files', '-z'], {
      cwd: resolvedRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const stdout = result.stdout || '';
    return stdout
      .split('\0')
      .map((value) => normalizeRelativePath(value))
      .filter(Boolean)
      .filter(isCandidateSourceFile)
      .sort();
  } catch {
    return (await listFilesFallback(resolvedRoot)).sort();
  }
}

function resolveLineLimit(limits, extension, fallback) {
  const specificLimit = limits?.[extension];
  if (Number.isInteger(specificLimit) && specificLimit > 0) {
    return specificLimit;
  }
  return fallback;
}

function normalizeBaselineFiles(baselineFiles = {}) {
  const normalized = {};
  const source = baselineFiles && typeof baselineFiles === 'object'
    ? (baselineFiles.files && typeof baselineFiles.files === 'object' ? baselineFiles.files : baselineFiles)
    : {};

  for (const [pathname, lines] of Object.entries(source)) {
    const normalizedPath = normalizeRelativePath(pathname);
    if (!normalizedPath || !Number.isInteger(lines) || lines < 1) continue;
    normalized[normalizedPath] = lines;
  }

  return normalized;
}

export async function loadOversizedFilesBaseline(rootDir = defaultRootDir, baselineFile = DEFAULT_BASELINE_FILE) {
  const resolvedRoot = resolve(rootDir);
  const baselinePath = resolve(resolvedRoot, baselineFile || DEFAULT_BASELINE_FILE);
  try {
    const parsed = JSON.parse(await readFile(baselinePath, 'utf8'));
    return {
      path: baselinePath,
      files: normalizeBaselineFiles(parsed),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: baselinePath,
        files: {},
      };
    }
    throw error;
  }
}

export async function scanOversizedFiles(rootDir = defaultRootDir, {
  warnLineLimits = DEFAULT_WARN_LINE_LIMITS,
  failLineLimits = DEFAULT_FAIL_LINE_LIMITS,
  baselineFiles = null,
} = {}) {
  const resolvedRoot = resolve(rootDir);
  const files = await listCandidateFiles(resolvedRoot);
  const allOversizedFiles = [];
  const baselineActive = baselineFiles !== null && baselineFiles !== undefined;
  const normalizedBaselineFiles = normalizeBaselineFiles(baselineActive ? baselineFiles : {});

  for (const relativePath of files) {
    const extension = extname(relativePath).toLowerCase();
    const warnLimit = resolveLineLimit(warnLineLimits, extension, 800);
    const failLimit = Math.max(
      resolveLineLimit(failLineLimits, extension, warnLimit),
      warnLimit,
    );
    const absolutePath = join(resolvedRoot, relativePath);
    const fileStat = await stat(absolutePath);
    const text = await readFile(absolutePath, 'utf8');
    const lines = countLines(text);
    if (lines < warnLimit) continue;
    const baselineLines = normalizedBaselineFiles[relativePath] || 0;
    allOversizedFiles.push({
      path: relativePath,
      extension,
      lines,
      bytes: fileStat.size,
      warnLimit,
      failLimit,
      severity: lines >= failLimit ? 'fail' : 'warn',
      ...(baselineLines > 0 ? { baselineLines, baselineDelta: lines - baselineLines } : {}),
    });
  }

  allOversizedFiles.sort((left, right) => {
    const severityRank = { fail: 0, warn: 1 };
    return severityRank[left.severity] - severityRank[right.severity]
      || right.lines - left.lines
      || left.path.localeCompare(right.path);
  });

  const oversizedFiles = [];
  const suppressedOversizedFiles = [];
  for (const entry of allOversizedFiles) {
    if (Number.isInteger(entry.baselineLines) && entry.baselineLines > 0 && entry.lines <= entry.baselineLines) {
      suppressedOversizedFiles.push(entry);
      continue;
    }
    oversizedFiles.push(entry);
  }

  return {
    rootDir: resolvedRoot,
    scannedFileCount: files.length,
    baselineActive,
    allOversizedFiles,
    oversizedFiles,
    suppressedOversizedFiles,
    baselineSuppressedCount: suppressedOversizedFiles.length,
    warningCount: oversizedFiles.filter((entry) => entry.severity === 'warn').length,
    failCount: oversizedFiles.filter((entry) => entry.severity === 'fail').length,
  };
}

export function formatOversizedFilesReport(report, {
  githubActions = false,
} = {}) {
  const oversizedFiles = Array.isArray(report?.oversizedFiles) ? report.oversizedFiles : [];
  const suppressedOversizedFiles = Array.isArray(report?.suppressedOversizedFiles) ? report.suppressedOversizedFiles : [];
  const baselineActive = report?.baselineActive === true;
  if (oversizedFiles.length === 0) {
    if (suppressedOversizedFiles.length > 0) {
      return {
        text: [
          `Oversized source file report: no regressions across ${report?.scannedFileCount || 0} scanned file(s).`,
          `${suppressedOversizedFiles.length} baseline oversized file(s) remain tracked but unchanged.`,
        ].join(' '),
        annotations: [],
      };
    }
    return {
      text: `Oversized source file report: none found across ${report?.scannedFileCount || 0} files.`,
      annotations: [],
    };
  }

  const summaryLine = [
    `Oversized source file report: ${oversizedFiles.length} file(s) flagged`,
    `across ${report?.scannedFileCount || 0} scanned file(s)`,
    `(${report?.failCount || 0} at or above fail threshold).`,
  ].join(' ');

  const detailLines = oversizedFiles.map((entry) => {
    const baselineNote = !baselineActive
      ? ''
      : (Number.isInteger(entry.baselineLines) && entry.baselineLines > 0
          ? `(+${entry.lines - entry.baselineLines} vs baseline ${entry.baselineLines})`
          : '(new oversized file)');
    return [
      entry.severity === 'fail' ? '!' : '-',
      `${entry.path}`,
      `${entry.lines} lines`,
      `(warn ${entry.warnLimit}, fail ${entry.failLimit})`,
      baselineNote,
    ].filter(Boolean).join(' ');
  });

  const annotations = githubActions
    ? oversizedFiles.map((entry) => {
      if (!baselineActive) {
        return `::warning file=${entry.path}::Oversized source file (${entry.lines} lines; warn ${entry.warnLimit}, fail ${entry.failLimit})`;
      }
      const detail = Number.isInteger(entry.baselineLines) && entry.baselineLines > 0
        ? `regression vs baseline ${entry.baselineLines}`
        : 'new oversized file';
      return `::warning file=${entry.path}::Oversized source file (${entry.lines} lines; warn ${entry.warnLimit}, fail ${entry.failLimit}; ${detail})`;
    })
    : [];

  return {
    text: [summaryLine, ...detailLines].join('\n'),
    annotations,
  };
}

function parseArgs(argv = []) {
  const options = {
    rootDir: defaultRootDir,
    baselineFile: DEFAULT_BASELINE_FILE,
    failOnOversizedFiles: process.env.FILESIZE_FAIL === '1',
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    showAllOversizedFiles: process.env.FILESIZE_ALL === '1',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.rootDir = resolve(argv[index + 1] || defaultRootDir);
      index += 1;
      continue;
    }
    if (arg === '--fail') {
      options.failOnOversizedFiles = true;
      continue;
    }
    if (arg === '--baseline') {
      options.baselineFile = argv[index + 1] || DEFAULT_BASELINE_FILE;
      index += 1;
      continue;
    }
    if (arg === '--github-actions') {
      options.githubActions = true;
      continue;
    }
    if (arg === '--all') {
      options.showAllOversizedFiles = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/report-oversized-files.mjs [--root <dir>] [--baseline <file>] [--all] [--fail] [--github-actions]');
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseline = options.showAllOversizedFiles
    ? null
    : await loadOversizedFilesBaseline(options.rootDir, options.baselineFile);
  const report = await scanOversizedFiles(options.rootDir, {
    baselineFiles: baseline?.files ?? null,
  });
  const formatted = formatOversizedFilesReport(report, {
    githubActions: options.githubActions,
  });

  for (const annotation of formatted.annotations) {
    console.log(annotation);
  }
  console.log(formatted.text);

  if (options.failOnOversizedFiles && report.failCount > 0) {
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`report-oversized-files: ${error.message}`);
    process.exitCode = 1;
  });
}
