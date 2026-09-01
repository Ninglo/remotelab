#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'remotelab-runtime-policy-'));
const personalCodexHome = join(home, '.codex');

process.env.HOME = home;
process.env.REMOTELAB_MACHINE_CODEX_HOME = personalCodexHome;

const {
  DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
  MANAGER_RUNTIME_BOUNDARY_SECTION,
  MANAGER_TURN_POLICY_REMINDER,
  applyProviderRuntimeEnv,
  resolveCodexHomeDir,
} = await import('../chat/runtime-policy.mjs');

try {
  const codexEnv = applyProviderRuntimeEnv('codex', { FOO: 'bar', CODEX_HOME: '/tmp/elsewhere' });
  assert.equal(codexEnv.FOO, 'bar', 'unrelated env values should stay intact');
  assert.equal(codexEnv.CODEX_HOME, personalCodexHome, 'Codex runs should use the instance Codex home');

  const customCodexEnv = applyProviderRuntimeEnv('micro-agent', { FOO: 'baz' }, {
    runtimeFamily: 'codex-json',
  });
  assert.equal(customCodexEnv.FOO, 'baz', 'custom Codex runtime should preserve unrelated env values');
  assert.equal(customCodexEnv.CODEX_HOME, personalCodexHome, 'custom Codex runtimes should use the same instance Codex home');

  const piCodexEnv = applyProviderRuntimeEnv('pi', { FOO: 'pi-codex' }, {
    runtimeFamily: 'pi-json',
  });
  assert.equal(piCodexEnv.CODEX_HOME, undefined, 'Pi GPT routes should not receive the unrelated Codex CLI home');
  assert.equal(piCodexEnv.PI_CODING_AGENT_DIR, join(home, '.pi', 'agent'), 'Pi GPT routes should receive Pi credential storage');

  const piDeepseekEnv = applyProviderRuntimeEnv('pi', { FOO: 'pi-deepseek' }, {
    runtimeFamily: 'pi-json',
  });
  assert.equal(piDeepseekEnv.CODEX_HOME, undefined, 'Pi third-party routes should not inherit Codex auth state');
  assert.equal(piDeepseekEnv.PI_CODING_AGENT_DIR, join(home, '.pi', 'agent'), 'all Pi providers should share the instance-scoped Pi credential store');

  assert.equal(
    resolveCodexHomeDir(),
    codexEnv.CODEX_HOME,
    'login status and runs should resolve the same default Codex home',
  );

  const nonCodexEnv = applyProviderRuntimeEnv('claude', { HOME: home });
  assert.equal(nonCodexEnv.CODEX_HOME, undefined, 'non-Codex runtimes should not get CODEX_HOME');

  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /RemoteLab supplies durable session\/run state, provider-neutral memory, access boundaries, capabilities, and user-visible delivery/,
    'default Codex developer instructions should define the thin RemoteLab control-plane boundary',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Codex owns task interpretation, planning, tool use, in-run decomposition, and self-review/,
    'default Codex developer instructions should leave semantic control inside the selected Harness',
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
    /execution substrate, not as the end user's personal Mac or default app container/,
    'default Codex developer instructions should frame the host as execution substrate rather than the user\'s personal app container',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /operational work yourself on this machine or another RemoteLab-visible surface rather than giving the user a manual how-to/,
    'default Codex developer instructions should prefer agent-side execution over manual user recipes',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /If another service needs login, access, or approval, prefer bringing that checkpoint onto this machine or another RemoteLab-exposed surface/,
    'default Codex developer instructions should prefer RemoteLab-side login and authorization checkpoints',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /prefer instance-scoped connectors\/API integrations and explicit account bindings or delivery targets/,
    'default Codex developer instructions should prefer bound connectors over ambient host app state for external side effects',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /binding-needed state or ask for the smallest authorization checkpoint rather than silently falling back to the host owner's local accounts or app sessions/,
    'default Codex developer instructions should block silent fallback to owner-local accounts when connector bindings are missing',
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
    /Build work habits rather than brittle branch tables: before improvising, check whether existing local skills, wrappers, notes, or prior workflows already fit the task/,
    'default Codex developer instructions should prefer reusable capabilities over ad hoc improvisation',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Shape the work yourself: if the turn contains independently actionable goals or noisy exploration, decide whether to split work, create a short scratch note, or continue in one thread based on clarity rather than a hard-coded rule/,
    'default Codex developer instructions should frame task shaping as agent judgment rather than rigid routing',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Do not split a single bounded workflow just because the user provided a numbered checklist, triage rubric, or step sequence/,
    'default Codex developer instructions should keep bounded checklist-style workflows in one session',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /same session\/workflow or not to create another child session, treat that as a strong no-split signal/,
    'default Codex developer instructions should honor explicit same-session no-spawn instructions',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /universal product rules belong in shared startup context, this user's standing preferences belong in personal memory, and repo-specific or specialized workflows belong in repo-local instructions or on-demand skills/,
    'default Codex developer instructions should separate shared defaults, personal memory, and repo-local workflows',
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
    /execution substrate, not as the end user's personal Mac or default app container/,
    'manager runtime boundary should block treating the host as the end user\'s personal app container',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /Do not assume remote users can browse local folders, inspect this computer, or pick up files from host-only paths/,
    'manager runtime boundary should block assumptions of direct host access for remote users',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /absorbing the operational work on the RemoteLab side instead of turning the user into the fallback operator with a recipe of manual steps/,
    'manager runtime boundary should prefer RemoteLab-side execution over manual user recipes',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /When another service needs access, login, or authorization, prefer completing that checkpoint on this machine or another RemoteLab-exposed surface/,
    'manager runtime boundary should prefer RemoteLab-side access and login checkpoints',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /only use connectors and delivery channels that are explicitly configured|prefer instance-scoped connectors/,
    'manager runtime boundary should prefer bound connectors over host app state for external side effects',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /missing-capability state to the user instead of improvising|binding-needed state instead of silently falling back/,
    'manager runtime boundary should block silent fallback to owner-local accounts when connector bindings are missing',
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
    /shared startup\/product defaults are only for universal cross-user principles; personal memory is for this user's standing preferences and machine-local habits; repo-local instructions and on-demand skills are for technical or domain-specific workflows/,
    'manager runtime boundary should keep shared defaults, personal memory, and repo-local workflows clearly layered',
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
    /Prefer soft-control habits over brittle scripts: check for reusable local capabilities before inventing a new path, shape noisy work deliberately, and do a quick self-review before replying/,
    'turn-level policy reminder should reinforce reusable capabilities and self-review rather than rigid scripts',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /Do not mirror the manager prompt structure or provider-native report formatting back to the user by default/,
    'turn-level policy reminder should explicitly block prompt-structure mirroring',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /carry shared context and reinforce invariants, not verbose step-by-step scripts or a second planning layer/,
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
    /Do not turn a nontechnical user into the fallback operator with a multi-step manual recipe when RemoteLab can do the work itself/,
    'turn-level policy reminder should block multi-step manual user recipes',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /prefer bound connectors\/APIs over ambient host app state/,
    'turn-level policy reminder should prefer bound connectors over ambient host app state for external side effects',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /instead of silently using the host owner's local accounts or app sessions/,
    'turn-level policy reminder should block silent fallback to owner-local accounts for external side effects',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /If login, authorization, or external access is needed, prefer a RemoteLab-side checkpoint on this machine or another explicitly exposed surface/,
    'turn-level policy reminder should prefer RemoteLab-side login and authorization checkpoints',
  );
  assert.match(
    MANAGER_TURN_POLICY_REMINDER,
    /Keep operator mechanics hidden by default: summarize in user-facing outcome language, and avoid volunteering memory-file, repo, remote, branch, checkpoint, or other host-side workflow details/,
    'turn-level policy reminder should keep operator-side mechanics out of default user-facing summaries',
  );

  console.log('test-runtime-policy: ok');
} finally {
  delete process.env.REMOTELAB_MACHINE_CODEX_HOME;
  rmSync(home, { recursive: true, force: true });
}
