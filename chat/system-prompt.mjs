import { homedir } from 'os';
import { basename } from 'path';
import {
  INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED,
  INSTANCE_ROOT,
  MANAGED_WORK_ROOT_DIR,
} from '../lib/config.mjs';
import { pathExists } from './fs-utils.mjs';
import { renderPromptAsset } from './prompt-asset-loader.mjs';
import {
  BOOTSTRAP_MD,
  GLOBAL_MD,
  PROJECTS_MD,
  SKILLS_MD,
  buildPromptPathMap,
  displayPromptPath,
} from './prompt-paths.mjs';

const SYSTEM_STARTUP_CONTEXT_ASSET = 'system/startup-context.md';

function buildCoreWorkflowsSection({ includeSessionSpawn }) {
  if (!includeSessionSpawn) return '';
  return `## RemoteLab Core Workflows

Independent work or handoff can use a user-visible RemoteLab Session; a Feishu discussion thread is a different surface. Timed or recurring AI work uses a Trigger or Schedule. The pointers below lead to each workflow's details.`;
}

function buildCapabilityDirectory({ includeSessionSpawn }) {
  return `## RemoteLab Capability Directory

Read the matching guide/help and check live bindings before use. Guide paths below are relative to $REMOTELAB_PROJECT_ROOT.

${includeSessionSpawn ? '- Independent Sessions: `remotelab session-spawn --guide`.\n' : ''}- Timed AI work: \`remotelab trigger create --help\`, \`remotelab schedule create --help\`.
- Restarts: \`remotelab service-access check --json\`; \`$REMOTELAB_PROJECT_ROOT/docs/platform-skills/service-access.md\` (check registered alternatives before declaring a permission blocker).
- Publish/preview: \`remotelab publish static --help\`, \`remotelab preview --help\`; \`$REMOTELAB_PROJECT_ROOT/docs/platform-skills/stable-static-publish.md\`, \`$REMOTELAB_PROJECT_ROOT/docs/platform-skills/guest-port-expose.md\`.
- Feishu: \`$REMOTELAB_PROJECT_ROOT/docs/platform-skills/feishu-cli.md\`; permissions: \`$REMOTELAB_PROJECT_ROOT/skills/feishu-auth-request/SKILL.md\`. Human todos use Feishu tasks (docs/platform-skills/feishu-tasks.md), not a separate personal list.
- Calendar: \`remotelab agenda --help\`. User Gmail and Agent Mailbox: \`remotelab gmail status --json\`, \`remotelab gmail --help\`, \`remotelab mail --help\`.
- Memory: \`remotelab memory --help\`; docs/memory-learning.md (verified current identity and original evidence). Related work: \`remotelab work context --query <goal> --json\`; docs/session-work-awareness.md. Retrieval is on demand.
- Connectors/helper: \`remotelab connector list --json\`, \`remotelab local-bridge status --json\`. Recording: \`remotelab recording --help\`; docs/platform-skills/hardware-recording.md (requires device bindings/permissions).
- Session diagnostics: \`$REMOTELAB_PROJECT_ROOT/docs/platform-skills/session-debug.md\`. Other capabilities: \`remotelab --help\`.

The CLI uses this runner's instance and source Session environment. If \`remotelab\` is unavailable in PATH or reports an unknown advertised subcommand, use the current source entry \`node "$REMOTELAB_PROJECT_ROOT/cli.js" <command>\`; an older PATH entry can point to a different checkout.`;
}

/** RemoteLab-owned context for a fresh provider thread. */
export async function buildSystemContext(options = {}) {
  const home = homedir();
  const {
    BOOTSTRAP_PATH: bootstrapPath,
    GLOBAL_PATH: globalPath,
    PROJECTS_PATH: projectsPath,
    SKILLS_PATH: skillsPath,
  } = buildPromptPathMap({ home });
  const [hasBootstrap, hasGlobal, hasProjects, hasSkills] = await Promise.all([
    pathExists(BOOTSTRAP_MD),
    pathExists(GLOBAL_MD),
    pathExists(PROJECTS_MD),
    pathExists(SKILLS_MD),
  ]);
  const isFirstTime = !hasBootstrap && !hasGlobal;
  const includeSessionSpawn = options?.includeSessionSpawn !== false;

  let context = (await renderPromptAsset(SYSTEM_STARTUP_CONTEXT_ASSET, {
    ...buildPromptPathMap({ home }),
    CORE_WORKFLOWS_SECTION: buildCoreWorkflowsSection({ includeSessionSpawn }),
  })).trim();

  if (!hasBootstrap && hasGlobal) {
    context += `\n\n## Memory Layout Status\nThis machine has ${globalPath} but no ${bootstrapPath}. A small bootstrap index can be created when useful.`;
  }
  if (!hasProjects && (hasBootstrap || hasGlobal)) {
    context += `\n\n## Memory Layout Status\nNo project pointer index exists at ${projectsPath}.`;
  }
  if (!hasSkills) {
    context += `\n\n## Memory Layout Status\nNo local skill index exists at ${skillsPath}.`;
  }
  if (isFirstTime) {
    context += `\n\n## Memory Layout Status\nThis machine has not initialized ${bootstrapPath} or ${globalPath}.`;
  }

  const scopedInstanceName = basename(INSTANCE_ROOT || '').trim().toLowerCase();
  if (INSTANCE_ROOT && scopedInstanceName) {
    context += INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED
      ? `\n\n## Instance Isolation Boundary\nThis session is running inside the instance-scoped environment \`${scopedInstanceName}\`.\n- Filesystem access is confined to ${displayPromptPath(INSTANCE_ROOT, home)} by the runtime.\n- The instance workspace is ${displayPromptPath(MANAGED_WORK_ROOT_DIR, home)}.`
      : `\n\n## Instance Local Access\nThis session is running inside the instance-scoped environment \`${scopedInstanceName}\`.\n- The instance workspace is ${displayPromptPath(MANAGED_WORK_ROOT_DIR, home)}.\n- RemoteLab is not applying a filesystem confinement boundary to this Harness process.`;
  }

  return `${context}\n\n${buildCapabilityDirectory({ includeSessionSpawn })}`;
}
