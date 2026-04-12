#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-session-folder-'));
const configDir = join(tempHome, '.config', 'remotelab');
const sessionsPath = join(configDir, 'chat-sessions.json');
const managedWorkRoot = join(tempHome, '.remotelab', 'workspace');
const missingLegacyProjectPath = join(tempHome, 'missing-legacy-project');
const missingLegacyUserPath = join(tempHome, 'missing-legacy-user');

mkdirSync(configDir, { recursive: true });

writeFileSync(
  sessionsPath,
  JSON.stringify([
    {
      id: 'legacy_session',
      folder: missingLegacyProjectPath,
      tool: 'codex',
      name: 'Legacy migrated session',
      created: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
    },
  ], null, 2),
  'utf8',
);

const previousHome = process.env.HOME;
const previousConfigDir = process.env.REMOTELAB_CONFIG_DIR;

try {
  process.env.HOME = tempHome;
  process.env.REMOTELAB_CONFIG_DIR = configDir;

  const cacheBust = `?t=${Date.now()}`;
  const folderModule = await import(pathToFileURL(join(repoRoot, 'chat', 'session-folder.mjs')).href + cacheBust);
  const metaStoreModule = await import(pathToFileURL(join(repoRoot, 'chat', 'session-meta-store.mjs')).href + cacheBust);

  const repaired = folderModule.resolveRunnableSessionFolder(missingLegacyProjectPath);
  assert.equal(repaired.repaired, true, 'missing session folder should be repaired');
  assert.equal(repaired.cwd, managedWorkRoot, 'missing folders should fall back to the managed work root');

  const fallback = folderModule.normalizeStoredSessionFolder(missingLegacyUserPath);
  assert.equal(fallback.changed, true, 'missing stored folder should normalize to the managed work root');
  assert.equal(fallback.folder, managedWorkRoot, 'missing stored folder should normalize to the managed work root');

  const loaded = await metaStoreModule.loadSessionsMeta();
  assert.equal(loaded[0]?.folder, managedWorkRoot, 'stored session metadata should be normalized to the managed work root on load');

  const persisted = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  assert.equal(persisted[0]?.folder, managedWorkRoot, 'normalized session folder should be persisted back to disk');
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;

  if (previousConfigDir === undefined) delete process.env.REMOTELAB_CONFIG_DIR;
  else process.env.REMOTELAB_CONFIG_DIR = previousConfigDir;

  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-session-folder-repair: ok');
