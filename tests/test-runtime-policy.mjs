#!/usr/bin/env node
import assert from 'assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'remotelab-runtime-policy-'));
const personalCodexHome = join(home, '.codex');
mkdirSync(personalCodexHome, { recursive: true });
writeFileSync(join(personalCodexHome, 'auth.json'), '{"token":"test"}\n', 'utf8');

process.env.HOME = home;

const {
  DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
  MANAGER_TURN_POLICY_REMINDER,
  applyManagedRuntimeEnv,
  ensureManagedCodexHome,
} = await import('../chat/runtime-policy.mjs');

try {
  const managedHome = join(home, '.config', 'remotelab', 'provider-runtime-homes', 'codex-test');
  const resolvedManagedHome = await ensureManagedCodexHome({
    homeDir: managedHome,
    authSource: join(personalCodexHome, 'auth.json'),
  });
  assert.equal(resolvedManagedHome, managedHome, 'managed Codex home should resolve to the requested directory');
  assert.match(
    readFileSync(join(managedHome, 'config.toml'), 'utf8'),
    /RemoteLab-managed Codex runtime home/,
    'managed Codex home should carry a minimal manager-owned config',
  );
  const authStat = lstatSync(join(managedHome, 'auth.json'));
  assert.ok(authStat.isSymbolicLink() || authStat.isFile(), 'managed Codex home should expose auth.json');

  const managedEnv = await applyManagedRuntimeEnv('codex', { FOO: 'bar', CODEX_HOME: '/tmp/elsewhere' }, {
    codexHomeDir: managedHome,
    codexAuthSource: join(personalCodexHome, 'auth.json'),
    codexHomeMode: 'managed',
  });
  assert.equal(managedEnv.FOO, 'bar', 'unrelated env values should stay intact');
  assert.equal(managedEnv.CODEX_HOME, managedHome, 'managed Codex runs should use the manager-owned CODEX_HOME');

  const personalEnv = await applyManagedRuntimeEnv('codex', { CODEX_HOME: '/tmp/personal' }, {
    codexHomeDir: managedHome,
    codexAuthSource: join(personalCodexHome, 'auth.json'),
    codexHomeMode: 'personal',
  });
  assert.equal(personalEnv.CODEX_HOME, '/tmp/personal', 'personal mode should preserve the existing CODEX_HOME');

  const customCodexEnv = await applyManagedRuntimeEnv('micro-agent', { FOO: 'baz' }, {
    runtimeFamily: 'codex-json',
    codexHomeDir: managedHome,
    codexAuthSource: join(personalCodexHome, 'auth.json'),
    codexHomeMode: 'managed',
  });
  assert.equal(customCodexEnv.FOO, 'baz', 'custom Codex runtime should preserve unrelated env values');
  assert.equal(customCodexEnv.CODEX_HOME, managedHome, 'custom Codex runtimes should also use the manager-owned CODEX_HOME');

  const nonCodexEnv = await applyManagedRuntimeEnv('claude', { HOME: home }, {
    codexHomeDir: managedHome,
    codexAuthSource: join(personalCodexHome, 'auth.json'),
  });
  assert.equal(nonCodexEnv.CODEX_HOME, undefined, 'non-Codex runtimes should not get a managed CODEX_HOME');

  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /RemoteLab owns the higher-level workflow, memory policy, and reply style/,
    'default Codex developer instructions should reinforce manager ownership',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /editable seed layer rather than rigid law/,
    'default Codex developer instructions should treat startup guidance as editable seed context',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /lead with current execution state, then whether the user is needed now or the work can stay parked for later/,
    'default Codex developer instructions should enforce state-first summaries and handoffs',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /Do not mirror the manager prompt structure or provider-native report formatting back to the user by default/,
    'turn-level policy reminder should explicitly block prompt-structure mirroring',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /reinforce invariants and current state, not verbose step-by-step scripts/,
    'turn-level policy reminder should stay principle-first rather than script every action',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /lead with the current execution state, then whether the user is needed now or the work can stay parked for later/,
    'turn-level policy reminder should enforce state-first reorientation',
  );

  console.log('test-runtime-policy: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
