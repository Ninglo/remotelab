#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const result = spawnSync(process.execPath, ['cli.js', 'release'], {
  cwd: repoRoot,
  encoding: 'utf8',
});

assert.equal(result.status, 1, 'removed release command should exit non-zero');
assert.match(result.stderr, /remotelab release/i, 'stderr should mention the removed command');
assert.match(result.stderr, /current source tree after restart/i, 'stderr should explain the new source-backed model');
assert.match(result.stderr, /remotelab restart chat/i, 'stderr should point to the restart replacement');

console.log('test-cli-release-removed: ok');
