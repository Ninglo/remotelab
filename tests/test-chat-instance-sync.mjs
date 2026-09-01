#!/usr/bin/env node
import assert from 'assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function runScript(args, envOverrides = {}) {
  return spawnSync('bash', ['scripts/chat-instance.sh', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
}

const sandboxRoot = mkdtempSync(join(tmpdir(), 'remotelab-chat-instance-sync-'));
const sourceHome = join(sandboxRoot, 'source-home');
const targetHome = join(sandboxRoot, 'target-home');
const instanceRoot = join(sandboxRoot, 'instance-root');
const operatorHome = join(sandboxRoot, 'operator-home');

try {
  mkdirSync(join(sourceHome, '.config', 'remotelab'), { recursive: true });
  writeFileSync(join(sourceHome, '.config', 'remotelab', 'auth.json'), JSON.stringify({ token: 'fresh-token' }, null, 2));

  mkdirSync(join(operatorHome, '.codex'), { recursive: true });
  const operatorCodexAuth = JSON.stringify({ tokens: { marker: 'operator-auth' } }, null, 2);
  writeFileSync(join(operatorHome, '.codex', 'auth.json'), operatorCodexAuth);

  mkdirSync(join(targetHome, '.config', 'remotelab'), { recursive: true });
  mkdirSync(join(targetHome, '.remotelab', 'memory'), { recursive: true });
  writeFileSync(join(targetHome, '.config', 'remotelab', 'stale.txt'), 'stale');
  writeFileSync(join(targetHome, '.remotelab', 'memory', 'stale.md'), 'stale');

  const syncResult = runScript(['sync', '--home', targetHome, '--sync-from-home', sourceHome]);
  assert.equal(syncResult.status, 0, `sync should succeed without --port: ${syncResult.stderr}`);
  assert.equal(
    JSON.parse(readFileSync(join(targetHome, '.config', 'remotelab', 'auth.json'), 'utf8')).token,
    'fresh-token',
    'sync should mirror remotelab config into the target home',
  );
  assert.equal(
    existsSync(join(targetHome, '.config', 'remotelab', 'stale.txt')),
    false,
    'sync should delete stale config files from the target home',
  );
  assert.equal(
    existsSync(join(targetHome, '.remotelab', 'memory')),
    false,
    'sync should remove mirrored memory when the source home has none',
  );

  mkdirSync(join(instanceRoot, 'config'), { recursive: true });
  mkdirSync(join(instanceRoot, 'memory'), { recursive: true });
  writeFileSync(join(instanceRoot, 'config', 'stale.txt'), 'stale');
  writeFileSync(join(instanceRoot, 'memory', 'stale.md'), 'stale');

  const rootedSyncResult = runScript(
    ['sync', '--instance-root', instanceRoot, '--sync-from-home', sourceHome],
    { HOME: operatorHome },
  );
  assert.equal(rootedSyncResult.status, 0, `rooted sync should succeed without --port: ${rootedSyncResult.stderr}`);
  assert.equal(
    readFileSync(join(operatorHome, '.codex', 'auth.json'), 'utf8'),
    operatorCodexAuth,
    'instance-root sync must not modify the operator HOME Codex auth',
  );
  assert.equal(
    JSON.parse(readFileSync(join(instanceRoot, 'config', 'auth.json'), 'utf8')).token,
    'fresh-token',
    'sync should mirror remotelab config into the instance root config dir',
  );
  assert.equal(
    existsSync(join(instanceRoot, 'config', 'stale.txt')),
    false,
    'sync should delete stale config files from the instance root config dir',
  );
  assert.equal(
    existsSync(join(instanceRoot, 'memory')),
    false,
    'sync should remove mirrored memory from the instance root when the source home has none',
  );

  mkdirSync(join(sourceHome, '.codex'), { recursive: true });
  const sourceCodexAuth = JSON.stringify({ tokens: { marker: 'source-auth' } }, null, 2);
  writeFileSync(join(sourceHome, '.codex', 'auth.json'), sourceCodexAuth);

  const rootedCodexSyncResult = runScript(
    ['sync', '--instance-root', instanceRoot, '--sync-from-home', sourceHome],
    { HOME: operatorHome },
  );
  assert.equal(rootedCodexSyncResult.status, 0, `rooted data sync should succeed: ${rootedCodexSyncResult.stderr}`);
  assert.equal(
    existsSync(join(instanceRoot, '.codex', 'auth.json')),
    false,
    'instance data sync must not fork the machine Codex login into an instance home',
  );
  assert.equal(
    readFileSync(join(operatorHome, '.codex', 'auth.json'), 'utf8'),
    operatorCodexAuth,
    'instance data sync must leave the machine Codex login unchanged',
  );

  const selfSyncResult = runScript(['sync', '--home', sourceHome, '--sync-from-home', sourceHome]);
  assert.notEqual(selfSyncResult.status, 0, 'sync should refuse to mirror a home onto itself');
  assert.match(
    selfSyncResult.stderr,
    /refusing to sync home onto itself/,
    'self-sync failure should explain the guardrail',
  );

  console.log('test-chat-instance-sync: ok');
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
