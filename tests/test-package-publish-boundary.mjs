#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(process.cwd());
const publicPagesDir = join(repoRoot, 'static', 'public-pages');
const sentinelPath = join(publicPagesDir, 'remotelab-package-boundary-sentinel.txt');

const [gitIgnore, npmIgnore] = await Promise.all([
  readFile(join(repoRoot, '.gitignore'), 'utf8'),
  readFile(join(repoRoot, '.npmignore'), 'utf8'),
]);

assert.match(gitIgnore, /^\/static\/public-pages\/$/m, 'runtime publications should stay out of Git');
assert.match(npmIgnore, /^\/static\/public-pages\/$/m, 'runtime publications should stay out of npm packages');

await mkdir(publicPagesDir, { recursive: true });
await writeFile(sentinelPath, 'instance-local runtime publication\n');

try {
  const { stdout } = await execFile('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  const packedFiles = Array.isArray(report?.[0]?.files) ? report[0].files : [];
  assert.equal(
    packedFiles.some((entry) => String(entry?.path || '').startsWith('static/public-pages/')),
    false,
    'npm package must not contain instance-local public pages',
  );
} finally {
  await rm(sentinelPath, { force: true });
  await rm(publicPagesDir, { recursive: true, force: true });
}

console.log('test-package-publish-boundary: ok');
