#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'remotelab-runtime-policy-'));
const machineCodexHome = join(home, '.codex');
const previousMachineCodexHome = process.env.REMOTELAB_MACHINE_CODEX_HOME;

process.env.HOME = home;
process.env.REMOTELAB_MACHINE_CODEX_HOME = machineCodexHome;

const {
  applyProviderRuntimeEnv,
  resolveCodexHomeDir,
} = await import('../chat/runtime-policy.mjs');

try {
  const codexEnv = applyProviderRuntimeEnv('codex', { FOO: 'bar', CODEX_HOME: '/tmp/elsewhere' });
  assert.equal(codexEnv.FOO, 'bar');
  assert.equal(codexEnv.CODEX_HOME, machineCodexHome);

  const customCodexEnv = applyProviderRuntimeEnv('micro-agent', { FOO: 'baz' }, {
    runtimeFamily: 'codex-json',
  });
  assert.equal(customCodexEnv.FOO, 'baz');
  assert.equal(customCodexEnv.CODEX_HOME, machineCodexHome);

  const piEnv = applyProviderRuntimeEnv('pi', { FOO: 'pi' }, { runtimeFamily: 'pi-json' });
  assert.equal(piEnv.CODEX_HOME, undefined);
  assert.equal(piEnv.PI_CODING_AGENT_DIR, join(home, '.pi', 'agent'));

  assert.equal(resolveCodexHomeDir(), codexEnv.CODEX_HOME);
  delete process.env.REMOTELAB_MACHINE_CODEX_HOME;
  assert.equal(resolveCodexHomeDir(), join(userInfo().homedir, '.codex'));
  process.env.REMOTELAB_MACHINE_CODEX_HOME = machineCodexHome;

  const nonCodexEnv = applyProviderRuntimeEnv('claude', { HOME: home });
  assert.equal(nonCodexEnv.CODEX_HOME, undefined);

  console.log('test-runtime-policy: ok');
} finally {
  if (previousMachineCodexHome === undefined) delete process.env.REMOTELAB_MACHINE_CODEX_HOME;
  else process.env.REMOTELAB_MACHINE_CODEX_HOME = previousMachineCodexHome;
  rmSync(home, { recursive: true, force: true });
}
