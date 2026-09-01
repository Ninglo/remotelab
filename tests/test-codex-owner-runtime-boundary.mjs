#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-codex-owner-'));
const ownerRoot = join(tempHome, 'instances', 'owner');

mkdirSync(ownerRoot, { recursive: true });

const previousHome = process.env.HOME;
const previousInstanceRoot = process.env.REMOTELAB_INSTANCE_ROOT;
const previousDisableApps = process.env.REMOTELAB_CODEX_DISABLE_APPS;
const previousMachineCodexHome = process.env.REMOTELAB_MACHINE_CODEX_HOME;

try {
  process.env.HOME = tempHome;
  process.env.REMOTELAB_INSTANCE_ROOT = ownerRoot;
  delete process.env.REMOTELAB_CODEX_DISABLE_APPS;
  delete process.env.REMOTELAB_MACHINE_CODEX_HOME;

  const ownerModuleUrl = pathToFileURL(join(repoRoot, 'chat', 'adapters', 'codex.mjs')).href;
  const { buildCodexArgs } = await import(`${ownerModuleUrl}?t=${Date.now()}`);
  const ownerArgs = buildCodexArgs('Say hello.');

  assert.equal(
    ownerArgs.includes('--dangerously-bypass-approvals-and-sandbox'),
    true,
    'owner Codex runs should keep the permissive owner runtime',
  );
  assert.equal(
    ownerArgs.includes('-a'),
    false,
    'owner Codex runs should not force the guest approval policy',
  );
  assert.equal(
    ownerArgs.includes('-s'),
    false,
    'owner Codex runs should not force the guest sandbox mode',
  );
  assert.equal(
    ownerArgs.includes('--disable'),
    false,
    'owner Codex runs should keep apps enabled by default',
  );

  const runtimePolicyUrl = pathToFileURL(join(repoRoot, 'chat', 'runtime-policy.mjs')).href;
  const { applyProviderRuntimeEnv } = await import(`${runtimePolicyUrl}?t=${Date.now()}`);
  const ownerEnv = applyProviderRuntimeEnv('codex', {}, { runtimeFamily: 'codex-json' });
  assert.equal(
    ownerEnv.CODEX_HOME,
    join(userInfo().homedir, '.codex'),
    'instance-scoped owner runs should still use the machine account Codex home',
  );
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;

  if (previousInstanceRoot === undefined) delete process.env.REMOTELAB_INSTANCE_ROOT;
  else process.env.REMOTELAB_INSTANCE_ROOT = previousInstanceRoot;

  if (previousDisableApps === undefined) delete process.env.REMOTELAB_CODEX_DISABLE_APPS;
  else process.env.REMOTELAB_CODEX_DISABLE_APPS = previousDisableApps;

  if (previousMachineCodexHome === undefined) delete process.env.REMOTELAB_MACHINE_CODEX_HOME;
  else process.env.REMOTELAB_MACHINE_CODEX_HOME = previousMachineCodexHome;

  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-codex-owner-runtime-boundary: ok');
