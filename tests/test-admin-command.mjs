#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { parseArgs } from '../lib/admin-command.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function runCli(home, args) {
  const result = spawnSync(process.execPath, [join(repoRoot, 'cli.js'), 'admin', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `admin command failed: ${args.join(' ')}`);
  }
  return result.stdout;
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-admin-command-'));
  const configDir = join(home, '.config', 'remotelab');
  const instanceRoot = join(home, '.remotelab', 'instances', 'trial24');
  const instanceConfigDir = join(instanceRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(instanceConfigDir, { recursive: true });

  writeFileSync(
    join(configDir, 'guest-instances.json'),
    JSON.stringify([
      {
        name: 'trial24',
        label: 'com.chatserver.trial24',
        port: 7711,
        hostname: 'trial24.example.com',
        instanceRoot,
        configDir: instanceConfigDir,
        memoryDir: join(instanceRoot, 'memory'),
        authFile: join(instanceConfigDir, 'auth.json'),
        publicBaseUrl: 'https://trial24.example.com',
        localBaseUrl: 'http://127.0.0.1:7711',
        createdAt: '2026-03-26T14:56:25.700Z',
      },
    ], null, 2),
    'utf8',
  );

  return {
    home,
    configDir,
  };
}

assert.equal(parseArgs(['summary', '--json']).command, 'summary');
assert.equal(parseArgs(['summary', '--sync', '--json']).sync, true);
assert.equal(parseArgs(['hosts', 'add', 'control', '--local', '--role', 'control']).local, true);
assert.equal(parseArgs(['hosts', 'add', 'remote-a', '--ssh-host', '10.0.0.8']).sshHost, '10.0.0.8');
assert.equal(parseArgs(['hosts', 'sync-remote', 'remote-a']).action, 'sync-remote');
assert.equal(parseArgs(['hosts', 'sync-all']).action, 'sync-all');
assert.equal(parseArgs(['instances', 'list', '--host', 'control']).command, 'instances');
assert.equal(parseArgs(['instances', 'list', '--host', 'control']).host, 'control');
assert.equal(parseArgs(['instances', 'create-trial', '--host', 'control', '--count', '5']).count, 5);
assert.equal(parseArgs(['instances', 'converge', '--host', 'control', '--all', '--dry-run']).all, true);
assert.throws(() => parseArgs(['hosts', 'add', 'control', '--sync-local']), /requires --local/);
assert.throws(() => parseArgs(['hosts', 'import-snapshot', 'remote-a']), /requires --file/);
assert.throws(() => parseArgs(['instances', 'list']), /requires --host/);
assert.throws(() => parseArgs(['instances', 'create', '--host', 'control']), /requires <name>/);

const { home, configDir } = setupTempHome();

try {
  const defaultSummary = JSON.parse(runCli(home, ['--json']));
  assert.equal(defaultSummary.hostCount, 1);
  assert.equal(defaultSummary.instanceCount, 1);
  assert.equal(defaultSummary.hosts[0].instanceCount, 1);
  assert.equal(defaultSummary.hosts[0].instances[0].name, 'trial24');

  const localHost = JSON.parse(runCli(home, ['hosts', 'add', 'control', '--local', '--role', 'control', '--ring', 'dev', '--sync-local', '--json']));
  assert.equal(localHost.name, 'control');
  assert.equal(localHost.role, 'control');
  assert.equal(localHost.instanceCount, 1);
  assert.equal(localHost.effectiveInstanceSource, 'local_registry');
  assert.equal(existsSync(join(configDir, 'fleet', 'hosts', 'control.json')), true);

  const localInstances = JSON.parse(runCli(home, ['instances', 'list', '--host', 'control', '--json']));
  assert.equal(localInstances.host, 'control');
  assert.equal(localInstances.instanceCount, 1);
  assert.equal(localInstances.instances[0].name, 'trial24');

  const manifestPath = join(home, 'remote.host.manifest.jsonc');
  const envPath = join(home, 'remote.install.env');
  const snapshotPath = join(home, 'remote-snapshot.json');
  writeFileSync(manifestPath, '{ "schemaVersion": 1 }\n', 'utf8');
  writeFileSync(envPath, 'REMOTELAB_MODE=on\n', 'utf8');
  writeFileSync(snapshotPath, JSON.stringify([
    { name: 'share-1', publicBaseUrl: 'https://share-1.example.com' },
    { name: 'share-2', publicBaseUrl: 'https://share-2.example.com' },
  ], null, 2), 'utf8');

  const remoteHost = JSON.parse(runCli(home, [
    'hosts', 'add', 'remote-a',
    '--ssh-host', '10.0.0.8',
    '--manifest', manifestPath,
    '--env', envPath,
    '--role', 'dedicated',
    '--ring', 'canary',
    '--json',
  ]));
  assert.equal(remoteHost.name, 'remote-a');
  assert.equal(remoteHost.instanceCount, 0);

  const importedHost = JSON.parse(runCli(home, ['hosts', 'import-snapshot', 'remote-a', '--file', snapshotPath, '--json']));
  assert.equal(importedHost.instanceCount, 2);
  assert.equal(importedHost.instances[0].name, 'share-1');
  assert.equal(importedHost.effectiveInstanceSource, 'imported_snapshot');

  const remoteInstances = JSON.parse(runCli(home, ['instances', 'list', '--host', 'remote-a', '--json']));
  assert.equal(remoteInstances.host, 'remote-a');
  assert.equal(remoteInstances.instanceCount, 2);
  assert.equal(remoteInstances.instances[1].name, 'share-2');

  const fleetSummary = JSON.parse(runCli(home, ['summary', '--json']));
  assert.equal(fleetSummary.hostCount, 2);
  assert.equal(fleetSummary.instanceCount, 3);
  assert.equal(fleetSummary.hosts.find((entry) => entry.name === 'control')?.instanceCount, 1);
  assert.equal(fleetSummary.hosts.find((entry) => entry.name === 'remote-a')?.instanceCount, 2);

  const syncedSummary = JSON.parse(runCli(home, ['summary', '--sync', '--json']));
  assert.equal(syncedSummary.hostCount, 2);
  assert.equal(syncedSummary.hosts.find((entry) => entry.name === 'control')?.lastSyncStatus, 'ok');

  console.log('test-admin-command: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
