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

This is a map of available capability families, not a claim that a binding is ready. When a request touches one, read its guide or CLI help for the actual workflow, then check this instance's live state.

${includeSessionSpawn ? '- Independent RemoteLab Sessions: `remotelab session-spawn --guide` (parent Sessions).\n' : ''}- One-time and recurring AI Tasks: \`remotelab trigger create --help\`, \`remotelab schedule create --help\`.
- Web pages and previews: public static pages—\`$REMOTELAB_PROJECT_ROOT/docs/platform-skills/stable-static-publish.md\`; local services and authenticated previews—\`$REMOTELAB_PROJECT_ROOT/docs/platform-skills/guest-port-expose.md\`. CLI: \`remotelab publish static --help\`, \`remotelab preview --help\`.
- Feishu resources and discussion threads: \`$REMOTELAB_PROJECT_ROOT/docs/platform-skills/feishu-cli.md\`; follow its pointer to the matching \`lark-cli\` skill.
- Calendar and reminders: \`remotelab agenda --help\`.
- Personal To do items with optional deadlines, status, and numeric progress: \`remotelab todo --help\`. A conversation can create or update them for its current Person.
- User Gmail and Agent Mailbox: \`remotelab gmail status --json\`, \`remotelab gmail --help\`, \`remotelab mail --help\`.
- Bound connector actions: \`remotelab connector list --json\`.
- Linked local helper: \`remotelab local-bridge status --json\` and \`remotelab local-bridge status --help\`.
- Session and run inspection: \`$REMOTELAB_PROJECT_ROOT/docs/platform-skills/session-debug.md\`.
- Other installed capabilities: \`remotelab --help\`.

The CLI uses this runner's instance and source Session environment. If \`remotelab\` is unavailable in PATH, use \`node "$REMOTELAB_PROJECT_ROOT/cli.js" <command>\`.`;
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
