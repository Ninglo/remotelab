#!/usr/bin/env node

import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, 'scripts', 'dedupe-tree.mjs');
const root = mkdtempSync(join(tmpdir(), 'remotelab-dedupe-tree-'));

function run(args) {
  return JSON.parse(execFileSync(process.execPath, [scriptPath, '--json', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  }));
}

try {
  const pageA = join(root, 'page-a');
  const pageB = join(root, 'page-b');
  mkdirSync(pageA, { recursive: true });
  mkdirSync(pageB, { recursive: true });
  writeFileSync(join(pageA, 'large.bin'), 'same-large-content');
  writeFileSync(join(pageB, 'large.bin'), 'same-large-content');
  writeFileSync(join(pageA, 'unique.bin'), 'unique-content-a');
  writeFileSync(join(pageB, 'small.bin'), 'x');
  writeFileSync(join(pageA, 'small.bin'), 'x');

  const dryRun = run(['--root', root, '--min-size-bytes', '2']);
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.duplicateFiles, 1);
  assert.equal(dryRun.appliedFiles, 0);
  assert.notEqual(statSync(join(pageA, 'large.bin')).ino, statSync(join(pageB, 'large.bin')).ino);

  const applied = run(['--root', root, '--min-size-bytes', '2', '--apply']);
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.appliedFiles, 1);
  assert.equal(applied.failures.length, 0);
  assert.equal(statSync(join(pageA, 'large.bin')).ino, statSync(join(pageB, 'large.bin')).ino);
  assert.equal(readFileSync(join(pageB, 'large.bin'), 'utf8'), 'same-large-content');

  const secondRun = run(['--root', root, '--min-size-bytes', '2', '--apply']);
  assert.equal(secondRun.appliedFiles, 0);
  assert.equal(secondRun.alreadyLinkedFiles, 1);

  console.log('test-dedupe-tree: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
