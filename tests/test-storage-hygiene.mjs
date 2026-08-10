#!/usr/bin/env node

import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, 'scripts', 'storage-hygiene.mjs');
const root = mkdtempSync(join(tmpdir(), 'remotelab-storage-hygiene-'));
const home = join(root, 'home');
const instanceRoot = join(root, 'instances');
const guestRoot = join(root, 'guests');
const publicPagesRoot = join(root, 'public-pages');
const oldDate = new Date(Date.now() - (45 * 24 * 60 * 60 * 1000));

function writeOldFile(path, content = 'old') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  utimesSync(path, oldDate, oldDate);
}

function touchTreeOld(path) {
  utimesSync(path, oldDate, oldDate);
  let parent = dirname(path);
  while (parent.startsWith(root) && parent !== root) {
    utimesSync(parent, oldDate, oldDate);
    parent = dirname(parent);
  }
}

function run(args) {
  return JSON.parse(execFileSync(process.execPath, [scriptPath, '--json', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      REMOTELAB_STORAGE_HYGIENE_HOME: home,
      REMOTELAB_STORAGE_HYGIENE_INSTANCE_ROOT: instanceRoot,
      REMOTELAB_STORAGE_HYGIENE_GUEST_ROOT: guestRoot,
      REMOTELAB_STORAGE_HYGIENE_PUBLIC_PAGES_ROOT: publicPagesRoot,
    },
    encoding: 'utf8',
  }));
}

try {
  const oldRun = join(home, '.config', 'remotelab', 'chat-runs', 'run_old');
  writeOldFile(join(oldRun, 'status.json'), JSON.stringify({
    state: 'completed',
    updatedAt: oldDate.toISOString(),
  }));
  writeOldFile(join(oldRun, 'spool.jsonl'), '{"type":"done"}\n');
  touchTreeOld(oldRun);

  const activeRun = join(home, '.config', 'remotelab', 'chat-runs', 'run_active');
  writeOldFile(join(activeRun, 'status.json'), JSON.stringify({
    state: 'running',
    updatedAt: oldDate.toISOString(),
  }));
  touchTreeOld(activeRun);

  const rawProviderSession = join(home, '.codex', 'sessions', '2026', '01', 'old.jsonl');
  writeOldFile(rawProviderSession, '{"session":"old"}\n');

  const oldFileAssetCache = join(home, '.config', 'remotelab', 'file-assets-cache', 'old.pdf');
  writeOldFile(oldFileAssetCache, 'localized attachment');

  const oldApiLog = join(home, '.config', 'remotelab', 'api-logs', '2026-01-01.jsonl');
  writeOldFile(oldApiLog, '{"request":"old"}\n');

  const oldTemp = join(instanceRoot, 'owner', 'tmp', 'old-work');
  writeOldFile(join(oldTemp, 'cache.bin'), 'temporary');
  mkdirSync(join(instanceRoot, 'owner', 'config'), { recursive: true });
  touchTreeOld(oldTemp);

  const publicTmp = join(publicPagesRoot, 'page-a', 'tmp-qa');
  writeOldFile(join(publicTmp, 'screenshot.png'), 'temporary artifact');
  touchTreeOld(publicTmp);
  const publicArtifacts = join(publicPagesRoot, 'page-a', 'artifacts');
  writeOldFile(join(publicArtifacts, 'download.zip'), 'published artifact');
  touchTreeOld(publicArtifacts);
  const publicAsset = join(publicPagesRoot, 'page-a', 'assets', 'hero.png');
  writeOldFile(publicAsset, 'keep');

  const dryRun = run([
    '--run-retention-days', '30',
    '--provider-session-retention-days', '30',
    '--file-asset-cache-retention-days', '30',
    '--api-log-retention-days', '30',
    '--temp-retention-days', '30',
    '--public-staging-retention-days', '30',
  ]);
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.summary.categories['terminal-chat-run']?.paths, 1);
  assert.equal(dryRun.summary.categories['raw-provider-session']?.paths, 1);
  assert.equal(dryRun.summary.categories['file-asset-cache']?.paths, 1);
  assert.equal(dryRun.summary.categories['api-log']?.paths, 1);
  assert.equal(dryRun.summary.categories['instance-temp']?.paths, 1);
  assert.equal(dryRun.summary.categories['published-staging']?.paths, 1);
  assert.ok(existsSync(oldRun), 'dry-run should preserve terminal run data');

  const applied = run([
    '--apply',
    '--run-retention-days', '30',
    '--provider-session-retention-days', '30',
    '--file-asset-cache-retention-days', '30',
    '--api-log-retention-days', '30',
    '--temp-retention-days', '30',
    '--public-staging-retention-days', '30',
  ]);
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.failures.length, 0);
  assert.equal(existsSync(oldRun), false, 'old terminal runs should be removed');
  assert.equal(existsSync(rawProviderSession), false, 'old raw provider transcripts should be removed');
  assert.equal(existsSync(oldFileAssetCache), false, 'old localized attachment cache should be removed');
  assert.equal(existsSync(oldApiLog), false, 'old API request logs should be removed');
  assert.equal(existsSync(oldTemp), false, 'old instance temp data should be removed');
  assert.equal(existsSync(publicTmp), false, 'old published temporary data should be removed');
  assert.equal(existsSync(publicArtifacts), true, 'published artifacts must be preserved');
  assert.equal(existsSync(activeRun), true, 'active runs must never be removed');
  assert.equal(existsSync(publicAsset), true, 'published runtime assets must be preserved');

  console.log('test-storage-hygiene: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
