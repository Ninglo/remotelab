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
  MANAGER_RUNTIME_BOUNDARY_SECTION,
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
    /Judge pauses branch-first: the decision target is not whether to continue but whether a real logical fork, missing required input, or forced human checkpoint actually exists/,
    'default Codex developer instructions should frame pauses around real forks or blockers rather than generic caution',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /If the task remains on a single obvious track, treat the current request as standing authorization and continue without asking permission/,
    'default Codex developer instructions should keep single-track work moving without extra permission asks',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /lead with current execution state, then whether the user is needed now or the work can stay parked for later/,
    'default Codex developer instructions should enforce state-first summaries and handoffs',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Machine access belongs to you, not automatically to the remote user/,
    'default Codex developer instructions should distinguish agent machine access from user access',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /local-only file is internal working state, not a completed handoff/,
    'default Codex developer instructions should prevent local-only delivery from counting as completion',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Machine-side completion alone does not mean the user already has the result|open, read, or download it from a reachable surface/,
    'default Codex developer instructions should separate machine-side completion from user-visible delivery',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Do not assume every user or task lives inside Git, GitHub, or code-repository workflows/,
    'default Codex developer instructions should avoid treating Git or repos as universal user context',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /repo state, remotes, branches, checkpoints, and similar operator workflows as internal mechanics/,
    'default Codex developer instructions should keep internal Git and memory mechanics out of default user-facing status updates',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /host machine is your private execution surface, not the default user interface/,
    'manager runtime boundary should define the host as the agent execution surface rather than the user interface',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /Do not assume remote users can browse local folders, inspect this computer, or pick up files from host-only paths/,
    'manager runtime boundary should block assumptions of direct host access for remote users',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /Machine-side completion and user-visible delivery are separate states|open, read, or download the result from a reachable surface/,
    'manager runtime boundary should treat user delivery as distinct from machine-side completion',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /Do not assume every user or task centers on Git, GitHub, or a code repository/,
    'manager runtime boundary should avoid repo-centric assumptions as the default product model',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /do not volunteer implementation details about memory files, prompts, repos, remotes, branches, checkpoints, or local tooling/,
    'manager runtime boundary should keep host-side implementation details out of normal user-facing replies',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /Judge pauses branch-first: do not ask whether to continue until you have first decided whether a real logical fork or forced human checkpoint exists/,
    'turn-level policy reminder should require branch-first pause decisions',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /If the work is still on a single obvious track, treat the current request as standing authorization and keep going/,
    'turn-level policy reminder should keep single-track work moving without extra permission checks',
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
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /Do not hand work back by telling the user to inspect a local path on the host machine/,
    'turn-level policy reminder should block host-path handoff language',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /Keep operator mechanics hidden by default: summarize in user-facing outcome language, and avoid volunteering memory-file, repo, remote, branch, checkpoint, or other host-side workflow details/,
    'turn-level policy reminder should keep operator-side mechanics out of default user-facing summaries',
  );

  console.log('test-runtime-policy: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
