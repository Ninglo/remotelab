#!/usr/bin/env node

import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import {
  link,
  readdir,
  rename,
  rm,
  stat,
} from 'fs/promises';
import { basename, dirname, join, parse, resolve } from 'path';

const DEFAULT_MIN_SIZE = 1024 * 1024;

function parseNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseOptions(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    concurrency: 4,
    json: false,
    minSize: DEFAULT_MIN_SIZE,
    roots: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--root') options.roots.push(resolve(argv[index += 1]));
    else if (arg === '--min-size-bytes') {
      options.minSize = parseNonNegativeNumber(argv[index += 1], options.minSize);
    } else if (arg === '--concurrency') {
      options.concurrency = Math.max(1, Math.floor(parseNonNegativeNumber(
        argv[index += 1],
        options.concurrency,
      )));
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage: node scripts/dedupe-tree.mjs --root <directory> [--root <directory> ...] [options]

Replace byte-identical regular files with hard links while preserving every path.
The default is a dry run.

Options:
  --apply                    Replace duplicates atomically with hard links
  --dry-run                  Report only (default)
  --json                     Emit JSON
  --min-size-bytes <bytes>   Ignore smaller files (default: ${DEFAULT_MIN_SIZE})
  --concurrency <count>      Concurrent hash readers (default: 4)
  -h, --help                 Show this help`;
}

function validateRoot(root) {
  const parsed = parse(root);
  if (root === parsed.root) throw new Error(`Refusing filesystem root: ${root}`);
}

async function collectFiles(root, minSize, files) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path, minSize, files);
      continue;
    }
    if (!entry.isFile() || entry.name.includes('.dedupe-tmp-')) continue;
    const info = await stat(path);
    if (info.size < minSize) continue;
    files.push({
      path,
      size: info.size,
      dev: info.dev,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
    });
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function addHashes(files, concurrency) {
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      files[index].hash = await hashFile(files[index].path);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(files.length, 1)) },
    () => worker(),
  ));
}

function sameSnapshot(record, info) {
  return record.size === info.size
    && record.dev === info.dev
    && record.ino === info.ino
    && record.mtimeMs === info.mtimeMs;
}

async function replaceWithHardLink(canonical, duplicate, sequence) {
  const canonicalInfo = await stat(canonical.path);
  const duplicateInfo = await stat(duplicate.path);
  if (!sameSnapshot(canonical, canonicalInfo) || !sameSnapshot(duplicate, duplicateInfo)) {
    throw new Error('File changed during dedupe scan');
  }
  if (canonicalInfo.dev !== duplicateInfo.dev) throw new Error('Files are on different devices');
  if (canonicalInfo.ino === duplicateInfo.ino) return false;

  const tempPath = join(
    dirname(duplicate.path),
    `.${basename(duplicate.path)}.dedupe-tmp-${process.pid}-${sequence}`,
  );
  try {
    await link(canonical.path, tempPath);
    await rename(tempPath, duplicate.path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return true;
}

async function run(options) {
  if (options.roots.length === 0) throw new Error('At least one --root is required.');
  for (const root of options.roots) validateRoot(root);

  const files = [];
  for (const root of options.roots) await collectFiles(root, options.minSize, files);

  const bySize = new Map();
  for (const file of files) {
    const group = bySize.get(file.size) || [];
    group.push(file);
    bySize.set(file.size, group);
  }
  const hashCandidates = [...bySize.values()].filter((group) => group.length > 1).flat();
  await addHashes(hashCandidates, options.concurrency);

  const byContent = new Map();
  for (const file of hashCandidates) {
    const key = `${file.size}:${file.hash}`;
    const group = byContent.get(key) || [];
    group.push(file);
    byContent.set(key, group);
  }

  let appliedFiles = 0;
  let alreadyLinkedFiles = 0;
  let duplicateBytes = 0;
  let duplicateFiles = 0;
  let sequence = 0;
  const failures = [];

  for (const group of byContent.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) => left.path.localeCompare(right.path));
    const canonical = group[0];
    for (const duplicate of group.slice(1)) {
      if (canonical.dev === duplicate.dev && canonical.ino === duplicate.ino) {
        alreadyLinkedFiles += 1;
        continue;
      }
      duplicateFiles += 1;
      duplicateBytes += duplicate.size;
      if (!options.apply) continue;
      sequence += 1;
      try {
        if (await replaceWithHardLink(canonical, duplicate, sequence)) appliedFiles += 1;
      } catch (error) {
        failures.push({ path: duplicate.path, error: error.message });
      }
    }
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    roots: options.roots,
    minSize: options.minSize,
    scannedFiles: files.length,
    hashCandidates: hashCandidates.length,
    duplicateFiles,
    duplicateBytes,
    alreadyLinkedFiles,
    appliedFiles,
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
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.mode}: ${result.duplicateFiles} duplicate files, ${formatBytes(result.duplicateBytes)} reclaimable`);
    if (result.alreadyLinkedFiles) console.log(`Already linked: ${result.alreadyLinkedFiles} files`);
  }
  if (result.failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
