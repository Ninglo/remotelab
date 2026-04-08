import { homedir } from 'os';
import { join } from 'path';
import {
  CHAT_PORT,
  MAINLAND_PUBLIC_BASE_URL,
  PLATFORM_SKILLS_DIR,
  PUBLIC_BASE_URL,
  SHARED_STARTUP_DEFAULTS_ENABLED,
} from '../lib/config.mjs';
import {
  buildCalendarSubscriptionChannels,
  filterCalendarSubscriptionChannelsForExposure,
  getFeedInfo,
} from '../lib/connector-calendar-feed.mjs';
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
import { MANAGER_RUNTIME_BOUNDARY_SECTION } from './runtime-policy.mjs';
import { buildSharedStartupDefaultsSection } from './shared-startup-defaults.mjs';

const SYSTEM_STARTUP_CONTEXT_ASSET = 'system/startup-context.md';

/**
 * Build the "## Parallel Session Spawning" section for the system prompt.
 * Returns the full section text with variables embedded, or '' if disabled.
 */
function buildSessionSpawnSection({ currentSessionId, chatPort }) {
  const sessionIdSuffix = currentSessionId ? ` (current: ${currentSessionId})` : '';
  return `## Parallel Session Spawning

- RemoteLab can spawn a fresh parallel session from the current session when work should split for context hygiene or parallel progress.
- Multi-session routing is a core dispatch principle, not an optional trick.
- This is not primarily a user-facing UI action; treat it as an internal capability you may invoke yourself when useful.
- Two patterns are supported:
  - Independent side session: create a new session and let it continue on its own.
  - Waited subagent: create a new session, wait for its result, then summarize the result back in the current session.
- If a user turn contains 2+ independently actionable goals, prefer splitting into child sessions.
- Do not split a single bounded workflow just because the user expressed it as a numbered checklist, bug-triage rubric, or ordered step sequence.
- If the user explicitly says to continue in the same session/workflow or not to create another child session, treat that as a strong no-split signal.
- Do not keep multiple goals in one thread merely because they share a broad theme.
- If they stay in one session, have a clear no-split reason.
- A parent session may coordinate while each child session owns one goal.
- Do not over-model durable hierarchy here: the spawned session can be treated as an independent worker that simply received bounded handoff context from this session.
- **Recursion termination**: if this session was itself spawned via delegation (indicated by a "Delegation handoff:" first message), you already have exactly one focused task. Complete it directly. Do not spawn further child sessions unless the delegated task genuinely contains multiple independent goals that cannot be handled sequentially in this session — a single task that happens to have several steps is NOT a reason to split.
- Preferred command:
  - remotelab session-spawn --task "<focused task>" --json
- Waited subagent variant:
  - remotelab session-spawn --task "<focused task>" --wait --json
- Hidden waited subagent variant for noisy exploration / context compression:
  - remotelab session-spawn --task "<focused task>" --wait --internal --output-mode final-only --json
- The hidden final-only variant suppresses the visible parent handoff note and returns only the child session's final reply to stdout.
- Prefer the hidden final-only variant when repo-wide search, multi-hop investigation, or other exploratory work would otherwise flood the current session with noisy intermediate output.
- Keep spawned-session handoff minimal. Usually the focused task plus the parent session id is enough.
- Do not impose a heavy handoff template by default; let the child decide what to inspect or how to proceed.
- If extra context is required, let the child fetch it from the parent session instead of pasting a long recap.
- If the remotelab command is unavailable in PATH, use:
  - node "$REMOTELAB_PROJECT_ROOT/cli.js" session-spawn --task "<focused task>" --json
- For scheduled follow-ups or deferred wake-ups in the current session, prefer the trigger CLI over hand-written HTTP requests.
- Preferred command:
  - remotelab trigger create --in 2h --text "Follow up on this later" --json
- The trigger command defaults to REMOTELAB_SESSION_ID, so you usually do not need to pass --session explicitly.
- If the remotelab command is unavailable in PATH, use:
  - node "$REMOTELAB_PROJECT_ROOT/cli.js" trigger create --in 2h --text "Follow up on this later" --json
- If you need to return a locally generated file, image, or export into this chat as an assistant attachment, prefer the assistant-message helper instead of only mentioning a machine path.
- Preferred command:
  - remotelab assistant-message --text "Generated file attached." --file "./report.pdf" --json
- The assistant-message command defaults to REMOTELAB_SESSION_ID and REMOTELAB_RUN_ID, so you usually do not need to pass --session or --run-id.
- If the remotelab command is unavailable in PATH, use:
  - node "$REMOTELAB_PROJECT_ROOT/cli.js" assistant-message --file "./report.pdf" --json
- The shell environment exposes:
  - REMOTELAB_SESSION_ID — current source session id${sessionIdSuffix}
  - REMOTELAB_RUN_ID — current active run id when this turn is executing inside a tool runtime
  - REMOTELAB_CHAT_BASE_URL — local RemoteLab API base URL (usually http://127.0.0.1:${chatPort})
  - REMOTELAB_PROJECT_ROOT — local RemoteLab project root for fallback commands
- The spawn command defaults to REMOTELAB_SESSION_ID, so you usually do not need to pass --source-session explicitly.
- RemoteLab may append a lightweight source-session note, but do not rely on heavy parent/child UI; normal session-list and sidebar surfaces are the primary way spawned sessions show up.
- Use this capability judiciously: split work when it reduces context pressure or enables real parallelism, not for every trivial substep.`;
}

/**
 * Build the system context to prepend to the first message of a session.
 * This is a lightweight pointer structure — tells the model how to activate
 * memory progressively instead of front-loading unrelated context.
 */
export async function buildSystemContext(options = {}) {
  const home = homedir();
  const {
    BOOTSTRAP_PATH: bootstrapPath,
    GLOBAL_PATH: globalPath,
    PROJECTS_PATH: projectsPath,
    SKILLS_PATH: skillsPath,
    TASKS_PATH: tasksPath,
  } = buildPromptPathMap({ home });
  const currentSessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  const [hasBootstrap, hasGlobal, hasProjects, hasSkills] = await Promise.all([
    pathExists(BOOTSTRAP_MD),
    pathExists(GLOBAL_MD),
    pathExists(PROJECTS_MD),
    pathExists(SKILLS_MD),
  ]);
  const isFirstTime = !hasBootstrap && !hasGlobal;
  const includeSharedStartupDefaults = typeof options?.includeSharedStartupDefaults === 'boolean'
    ? options.includeSharedStartupDefaults
    : SHARED_STARTUP_DEFAULTS_ENABLED;
  const includeSessionSpawn = options?.includeSessionSpawn !== false;

  let context = (await renderPromptAsset(SYSTEM_STARTUP_CONTEXT_ASSET, {
    ...buildPromptPathMap({ home }),
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    CURRENT_SESSION_ID_SUFFIX: currentSessionId ? ` (current: ${currentSessionId})` : '',
    CHAT_PORT: String(CHAT_PORT),
    SESSION_SPAWN_SECTION: includeSessionSpawn
      ? buildSessionSpawnSection({ currentSessionId, chatPort: String(CHAT_PORT) })
      : '',
  })).trim();

  if (includeSharedStartupDefaults) {
    context += `\n\n${buildSharedStartupDefaultsSection()}`;
  }

  if (!hasBootstrap && hasGlobal) {
    context += `

## Legacy Memory Layout Detected
This machine has ${globalPath} but no ${bootstrapPath} yet.
- Do NOT treat global.md as mandatory startup context for every conversation.
- At a natural breakpoint, backfill bootstrap.md with only the small startup index.
- Create projects.md when recurring work areas, repos, or task families need a lightweight pointer catalog.`;
  }

  if (!hasProjects && (hasBootstrap || hasGlobal)) {
    context += `

## Project Pointer Catalog Missing
If this machine has recurring work areas, repos, or task families, create ${projectsPath} as a small routing layer instead of stuffing those pointers into startup context.`;
  }

  if (!hasSkills) {
    context += `

## Skills Index Missing
If local reusable workflows exist, create ${skillsPath} as a minimal placeholder index instead of treating the absence as a hard failure.`;
  }

  if (isFirstTime) {
    context += `

## FIRST-TIME SETUP REQUIRED
This machine is missing both bootstrap.md and global.md. Before diving into detailed work:
1. First check for explicit user-provided pointers, carried continuity, and obvious known work roots before doing any filesystem discovery.
2. If a small amount of discovery is still necessary, inspect only a few safe top-level directories under ${home} to map key work areas, data folders, apps, and repos. Do not recurse into ~/Library, app containers, or other system-managed paths unless the task specifically requires macOS diagnostics.
3. If even that does not produce a clear entry point, ask the user for the missing project/path pointer instead of widening into machine-wide search.
4. Create ${bootstrapPath} with machine basics, collaboration defaults, key directories, and short project pointers.
5. Create ${projectsPath} if there are recurring work areas, repos, or task families worth indexing.
6. Create ${globalPath} only for deeper local notes that should NOT be startup context.
7. Create ${skillsPath} if local reusable workflows exist.
8. Show the user a brief bootstrap summary and confirm it is correct.

Bootstrap only needs to be tiny. Detailed memory belongs in projects.md, tasks/, or global.md.`;
  }

  context += await buildConnectorCapabilitiesSection();

  return context;
}

async function buildConnectorCapabilitiesSection() {
  const connectorSections = [];
  const home = homedir();
  const agendaBinaryPath = displayPromptPath(join(home, '.remotelab', 'bin', 'agenda'), home);
  const calendarSkillPath = displayPromptPath(join(PLATFORM_SKILLS_DIR, 'calendar-write.md'), home);

  try {
    const feedInfo = await getFeedInfo();
    if (feedInfo?.feedToken) {
      const channels = buildCalendarSubscriptionChannels({
        feedToken: feedInfo.feedToken,
        mainlandBaseUrl: MAINLAND_PUBLIC_BASE_URL,
        publicBaseUrl: PUBLIC_BASE_URL,
        preferredBaseUrl: MAINLAND_PUBLIC_BASE_URL || PUBLIC_BASE_URL,
      });
      const exposedChannels = filterCalendarSubscriptionChannelsForExposure(channels);
      if (exposedChannels.variants.length > 0) {
        const subscriptionLines = [
          `Subscription link (webcal): ${exposedChannels.preferredWebcalUrl || exposedChannels.preferredHttpsUrl}`,
          `Subscription link (https): ${exposedChannels.preferredHttpsUrl}`,
        ];

        connectorSections.push(`### Calendar
Calendar events default to the instance iCal subscription feed. For ordinary calendar requests, write directly to that feed with \`${agendaBinaryPath} add --title "Title" --start "ISO8601" --duration 60\`. The write stays instance-local when the shell already carries \`REMOTELAB_INSTANCE_ROOT\` or \`REMOTELAB_CONFIG_DIR\`.

If you need the workflow details, read \`${calendarSkillPath}\`. Do not create completion targets for normal interactive calendar requests.

If the user explicitly needs first-class external calendar notifications and a ready bound calendar connector is already present, you may use that bound connector instead of the feed.

${subscriptionLines.join('\n')}
Events in feed: ${feedInfo.eventCount}

If the user has not yet subscribed, send the webcal:// link directly in the conversation — it is clickable on iOS/macOS and triggers the native "Subscribe to Calendar?" dialog. Keep the message brief: describe what the subscription does, then provide the link. No separate setup page needed.

Do not use the host machine's local Calendar.app or any GUI calendar application.`);
      }
    }
  } catch {}

  let section = `

## Instance Connectors

Only the connectors listed in this section are available for this instance. Do not discover, invoke, or fall back to host-level scripts, daemons, config files, or credentials found on disk that are not declared here.`;

  if (connectorSections.length > 0) {
    section += '\n\n' + connectorSections.join('\n\n');
  } else {
    section += '\n\nNo external connectors are currently configured for this instance.';
  }

  return section;
}
