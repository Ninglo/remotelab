#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-codex-guest-'));
const guestRoot = join(tempHome, 'instances', 'trial24');

mkdirSync(guestRoot, { recursive: true });

const previousHome = process.env.HOME;
const previousInstanceRoot = process.env.REMOTELAB_INSTANCE_ROOT;
const previousDisableApps = process.env.REMOTELAB_CODEX_DISABLE_APPS;

try {
  process.env.HOME = tempHome;
  process.env.REMOTELAB_INSTANCE_ROOT = guestRoot;
  delete process.env.REMOTELAB_CODEX_DISABLE_APPS;

  const guestModuleUrl = pathToFileURL(join(repoRoot, 'chat', 'adapters', 'codex.mjs')).href;
  const { buildCodexArgs } = await import(`${guestModuleUrl}?t=${Date.now()}`);
  const guestArgs = buildCodexArgs('Say hello.');
  const disableIndex = guestArgs.indexOf('--disable');
  assert.notEqual(disableIndex, -1, 'guest codex runs should disable apps by default');
  assert.equal(guestArgs[disableIndex + 1], 'apps', 'guest codex runs should disable the apps feature');
  assert.equal(
    guestArgs.includes('--dangerously-bypass-approvals-and-sandbox'),
    false,
    'guest codex runs should not bypass approvals and sandbox by default',
  );
  assert.equal(
    guestArgs.includes('-a'),
    false,
    'guest codex runs should not pass unsupported approval flags',
  );
  const sandboxIndex = guestArgs.indexOf('-s');
  assert.notEqual(sandboxIndex, -1, 'guest codex runs should select a sandbox mode');
  assert.equal(
    guestArgs[sandboxIndex + 1],
    'danger-full-access',
    'guest codex runs should default to full local filesystem access when the boundary is relaxed',
  );

  process.env.REMOTELAB_CODEX_DISABLE_APPS = '0';
  const { buildCodexArgs: buildCodexArgsWithApps } = await import(`${guestModuleUrl}?t=${Date.now() + 1}`);
  const optOutArgs = buildCodexArgsWithApps('Say hello.');
  assert.equal(optOutArgs.includes('--disable'), false, 'explicit opt-out should preserve apps availability');
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;

  if (previousInstanceRoot === undefined) delete process.env.REMOTELAB_INSTANCE_ROOT;
  else process.env.REMOTELAB_INSTANCE_ROOT = previousInstanceRoot;

  if (previousDisableApps === undefined) delete process.env.REMOTELAB_CODEX_DISABLE_APPS;
  else process.env.REMOTELAB_CODEX_DISABLE_APPS = previousDisableApps;

  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-codex-guest-runtime-boundary: ok');
