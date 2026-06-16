#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-session-folder-guest-'));
const guestRoot = join(tempHome, 'instances', 'trial24');
const managedWorkRoot = join(guestRoot, 'workspace');
const safeSubdir = join(managedWorkRoot, 'notes');
const externalDir = join(tempHome, 'outside-project');

mkdirSync(safeSubdir, { recursive: true });
mkdirSync(externalDir, { recursive: true });

const previousHome = process.env.HOME;
const previousInstanceRoot = process.env.REMOTELAB_INSTANCE_ROOT;
const previousWorkRoot = process.env.REMOTELAB_WORK_ROOT_DIR;

try {
  process.env.HOME = tempHome;
  process.env.REMOTELAB_INSTANCE_ROOT = guestRoot;
  process.env.REMOTELAB_WORK_ROOT_DIR = managedWorkRoot;

  const moduleUrl = pathToFileURL(join(repoRoot, 'chat', 'session-folder.mjs')).href;
  const {
    clampGuestSessionFolder,
    resolveRunnableSessionFolder,
  } = await import(`${moduleUrl}?t=${Date.now()}`);

  const allowed = clampGuestSessionFolder(safeSubdir);
  assert.equal(allowed.clamped, false, 'subdirectories inside the guest workspace should remain allowed');
  assert.equal(allowed.folder, safeSubdir);

  const relaxed = clampGuestSessionFolder(externalDir);
  assert.equal(relaxed.clamped, false, 'directories outside the guest workspace should stay accessible when the boundary is relaxed');
  assert.equal(relaxed.folder, externalDir);

  const runnable = resolveRunnableSessionFolder(externalDir);
  assert.equal(runnable.repaired, false, 'guest runnable cwd should preserve explicit external folders when the boundary is relaxed');
  assert.equal(runnable.cwd, externalDir, 'guest runnable cwd should keep the requested external folder');
  assert.equal(runnable.reason, '');
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;

  if (previousInstanceRoot === undefined) delete process.env.REMOTELAB_INSTANCE_ROOT;
  else process.env.REMOTELAB_INSTANCE_ROOT = previousInstanceRoot;

  if (previousWorkRoot === undefined) delete process.env.REMOTELAB_WORK_ROOT_DIR;
  else process.env.REMOTELAB_WORK_ROOT_DIR = previousWorkRoot;

  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-session-folder-guest-boundary: ok');
