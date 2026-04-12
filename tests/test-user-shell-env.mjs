#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-user-shell-env-'));
const shellBin = join(tempHome, 'shell-bin');
const processBin = join(tempHome, 'process-bin');

mkdirSync(shellBin, { recursive: true });
mkdirSync(processBin, { recursive: true });

for (const target of [
  join(shellBin, 'shell-path-order-tool'),
  join(processBin, 'shell-path-order-tool'),
]) {
  writeFileSync(target, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(target, 0o755);
}

writeFileSync(
  join(tempHome, '.bash_profile'),
  [
    'export REMOTELAB_SHELL_TEST_FLAG="from-shell-profile"',
    'export PATH="$HOME/shell-bin:$PATH"',
  ].join('\n'),
  'utf8',
);

const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  SHELL: process.env.SHELL,
  REMOTELAB_USER_SHELL_ENV_B64: process.env.REMOTELAB_USER_SHELL_ENV_B64,
  IS_SANDBOX: process.env.IS_SANDBOX,
};

process.env.HOME = tempHome;
process.env.SHELL = '/bin/bash';
process.env.PATH = `${processBin}:${process.env.PATH || ''}`;
delete process.env.REMOTELAB_USER_SHELL_ENV_B64;

try {
  const shellEnvModule = await import(pathToFileURL(join(repoRoot, 'lib', 'user-shell-env.mjs')).href);
  const toolsModule = await import(pathToFileURL(join(repoRoot, 'lib', 'tools.mjs')).href);

  const { fullPath, buildToolProcessEnv } = shellEnvModule;
  const { resolveToolCommandPathAsync } = toolsModule;

  const pathEntries = fullPath.split(':');
  assert.ok(pathEntries.includes(shellBin), 'fullPath should include PATH additions from the user shell profile');
  assert.ok(pathEntries.includes(processBin), 'fullPath should preserve the parent process PATH');
  assert.ok(
    pathEntries.indexOf(shellBin) < pathEntries.indexOf(processBin),
    'user shell PATH order should take precedence over the service process PATH',
  );

  const env = buildToolProcessEnv();
  assert.equal(env.REMOTELAB_SHELL_TEST_FLAG, 'from-shell-profile', 'tool env should inherit shell-exported variables');

  process.env.IS_SANDBOX = '';
  const envDefault = buildToolProcessEnv();
  assert.equal(envDefault.IS_SANDBOX, '1', 'tool env should default IS_SANDBOX to 1');

  process.env.IS_SANDBOX = '0';
  const envExplicit = buildToolProcessEnv();
  assert.equal(envExplicit.IS_SANDBOX, '0', 'tool env should preserve explicit IS_SANDBOX=0');

  const resolved = await resolveToolCommandPathAsync('shell-path-order-tool');
  assert.equal(resolved, join(shellBin, 'shell-path-order-tool'), 'tool resolution should follow the shell-derived PATH order');
} finally {
  if (originalEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnv.HOME;

  if (originalEnv.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = originalEnv.PATH;

  if (originalEnv.SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalEnv.SHELL;

  if (originalEnv.REMOTELAB_USER_SHELL_ENV_B64 === undefined) delete process.env.REMOTELAB_USER_SHELL_ENV_B64;
  else process.env.REMOTELAB_USER_SHELL_ENV_B64 = originalEnv.REMOTELAB_USER_SHELL_ENV_B64;
  if (originalEnv.IS_SANDBOX === undefined) delete process.env.IS_SANDBOX;
  else process.env.IS_SANDBOX = originalEnv.IS_SANDBOX;

  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-user-shell-env: ok');
