import { homedir } from 'os';
import { basename, join } from 'path';
import {
  CHAT_PORT,
  CONFIG_DIR,
  INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED,
  INSTANCE_ROOT,
  MANAGED_WORK_ROOT_DIR,
  PLATFORM_SKILLS_DIR,
  SHARED_STARTUP_DEFAULTS_ENABLED,
} from '../lib/config.mjs';
import {
  buildCalendarSubscribeHelperPath,
  getFeedInfo,
} from '../lib/connector-calendar-feed.mjs';
import {
  getAllToolDefinitions,
  initSkillRegistry,
  isConnectorSkillReady,
} from '../lib/connector-skill-registry.mjs';
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

- RemoteLab can create a separate persistent session when independent history, delivery, visibility, or long-running execution has real product value.
- Treat this as an optional capability, not a mandatory routing layer around the selected Harness.
- Prefer the Harness's own in-run planning or native subagents for temporary decomposition that does not need a durable RemoteLab session.
- Two persistent-session patterns are supported:
  - Independent side session: create a new session and let it continue on its own.
  - Waited worker session: create a new session, wait for its result, then summarize the result back in the current session.
- Do not split merely because a request contains several steps or several independently actionable items; split only when the separate durable session itself is useful.
- If the user explicitly says to continue in the same session/workflow or not to create another child session, keep the work here.
- A spawned session is an independent worker that receives a bounded handoff, not a hidden replacement for the Harness's own control loop.
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
- For recurring AI work, use the five-field cron schedule command. It defaults to Asia/Shanghai and keeps each occurrence as an isolated trigger/run:
  - remotelab schedule create --cron "0 9 * * 1-5" --timezone Asia/Shanghai --text "Prepare the morning brief" --json
- Use trigger-created session wake-ups only when the future work genuinely requires AI reasoning, drafting, or conversation continuation.
- Do not use a trigger-created wake-up just because the user said "remind me". A simple time-based reminder such as "remind me tomorrow at 3pm" should usually become a direct calendar/schedule update or other deterministic delivery.
- For deterministic external delivery such as reminders, notifications, or simple outbound pushes, prefer a direct connector action when one is available instead of waking a session just to restate the message.
- Reserve trigger-created session wake-ups for recurring or open-ended future AI work such as daily feedback, scheduled reviews, or "check the calendar and brief me" style tasks.
- The trigger command defaults to REMOTELAB_SESSION_ID, so you usually do not need to pass --session explicitly.
- Trigger and schedule commands capture the current session source when available so generated results can return to the same connector conversation. Use --no-source-delivery only when the result should remain inside RemoteLab.
- If the remotelab command is unavailable in PATH, use:
  - node "$REMOTELAB_PROJECT_ROOT/cli.js" trigger create --in 2h --text "Follow up on this later" --json
- If you generate a local file the user needs, do not rely on host paths as the user-facing handoff.
- Normal contract: mention the result in prose and include an explicit \`Artifacts:\` block in the final reply so RemoteLab can publish the files automatically.
- Preferred format:
  - Artifacts:
  - - ./report.pdf
  - - ./charts/summary.png
- The \`Artifacts:\` block is for backend publication, not for telling the user to browse the machine.
- The shell environment exposes:
  - REMOTELAB_SESSION_ID — current source session id${sessionIdSuffix}
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

  const scopedInstanceName = basename(INSTANCE_ROOT || '').trim().toLowerCase();
  if (INSTANCE_ROOT && scopedInstanceName) {
    context += INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED
      ? `

## Instance Isolation Boundary
This session is running inside the instance-scoped environment \`${scopedInstanceName}\`.
- Treat this instance as its own machine-scoped environment, not as a view into broader host storage.
- The default user-visible file surface is ${displayPromptPath(MANAGED_WORK_ROOT_DIR, home)}. Keep routine work, imports, and exports there.
- Paths outside ${displayPromptPath(INSTANCE_ROOT, home)} are host-level by default. Do not browse, read, summarize, attach, or persist them unless the task explicitly requires a minimal safe subset and that material has first been moved into this instance.
- Even inside ${displayPromptPath(INSTANCE_ROOT, home)}, auth files, mailbox config, connector secrets, and runtime state are operational data rather than normal user content.
- Never inspect sibling-instance roots, unrelated host-level dotfiles, or broader host storage just because they exist on disk.`
      : `

## Instance Local Access
This session is running inside the instance-scoped environment \`${scopedInstanceName}\`.
- The default user-visible file surface is ${displayPromptPath(MANAGED_WORK_ROOT_DIR, home)}. Keep routine work, imports, and exports there when possible.
- Local filesystem access and localhost service calls are not hard-confined to ${displayPromptPath(INSTANCE_ROOT, home)}. If a compatibility scenario genuinely requires broader machine access, you may use it.
- Treat broader host paths as exceptional rather than default. Avoid unrelated paths, sibling-instance state, auth files, mailbox config, connector secrets, and runtime state unless the task genuinely requires them.
- This relaxed local access mode does not weaken RemoteLab authentication, share-link scoping, or the existing external network isolation boundaries.`;
  }

  context += await buildConnectorCapabilitiesSection();

  return context;
}

function connectorParameterFlag(name) {
  return String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function renderConnectorActionCommand(tool) {
  const parameters = tool?.parameters && typeof tool.parameters === 'object' ? tool.parameters : {};
  const requiredFlags = Object.entries(parameters)
    .filter(([, schema]) => schema?.required === true)
    .map(([name]) => ` --${connectorParameterFlag(name)} "<${name}>"`)
    .join('');
  return `remotelab connector call ${tool.name}${requiredFlags} --json`;
}

async function buildGenericConnectorActionsSection() {
  try {
    await initSkillRegistry(CONFIG_DIR);
    const definitions = await getAllToolDefinitions();
    const ready = (await Promise.all(definitions.map(async (tool) => ({
      ...tool,
      ready: await isConnectorSkillReady(tool.name),
    }))))
      .filter((tool) => tool.ready);
    if (ready.length === 0) return '';

    const lines = ready.map((tool) => {
      const parameters = tool?.parameters && typeof tool.parameters === 'object' ? tool.parameters : {};
      const required = Object.entries(parameters)
        .filter(([, schema]) => schema?.required === true)
        .map(([name]) => name);
      const optional = Object.keys(parameters).filter((name) => !required.includes(name));
      const parameterSummary = [
        required.length > 0 ? `required: ${required.join(', ')}` : '',
        optional.length > 0 ? `optional: ${optional.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      return `- \`${tool.name}\` — ${tool.description || 'Connector action'}${parameterSummary ? ` (${parameterSummary})` : ''}\n  - Example: \`${renderConnectorActionCommand(tool)}\``;
    });

    return `### Connector Actions
This instance currently exposes the following health-checked, binding-scoped connector actions. Use them for deterministic external delivery instead of waking a new AI session merely to restate known text. Provider credentials remain inside the connector process.

${lines.join('\n')}

Use \`remotelab connector list --json\` to refresh the active catalog. If the \`remotelab\` command is unavailable in PATH, replace it with \`node "$REMOTELAB_PROJECT_ROOT/cli.js"\`.`;
  } catch {
    return '';
  }
}

async function buildConnectorCapabilitiesSection() {
  const connectorSections = [];
  const agendaCommand = 'remotelab agenda add --title "Title" --start "ISO8601" --duration 60';
  const agendaFallbackCommand = 'node "$REMOTELAB_PROJECT_ROOT/cli.js" agenda add --title "Title" --start "ISO8601" --duration 60';
  const agendaHelpCommand = 'remotelab agenda --help';
  const agendaFallbackHelpCommand = 'node "$REMOTELAB_PROJECT_ROOT/cli.js" agenda --help';

  try {
    const feedInfo = await getFeedInfo();
    if (feedInfo?.feedToken) {
      const subscriptionLines = [
        `Subscription helper path: ${buildCalendarSubscribeHelperPath()}`,
        `Manual subscription helper path: ${buildCalendarSubscribeHelperPath({ format: 'https' })}`,
      ];

      connectorSections.push(`### Calendar
Calendar events default to the instance iCal subscription feed. For ordinary calendar requests, write directly to that feed with \`${agendaCommand}\`. If the \`remotelab\` command is unavailable in PATH, use \`${agendaFallbackCommand}\` instead. The write stays instance-local when the shell already carries \`REMOTELAB_INSTANCE_ROOT\` or \`REMOTELAB_CONFIG_DIR\`.

For workflow details, use \`${agendaHelpCommand}\`. If the \`remotelab\` command is unavailable in PATH, use \`${agendaFallbackHelpCommand}\`. Do not create completion targets for normal interactive calendar requests.

Treat most user requests phrased like "remind me tomorrow at 3" or "next week remind me to send this" as normal interactive calendar requests that should only update the schedule/feed. Reserve trigger-created session wake-ups for recurring or tool-using workflows such as daily feedback, scheduled reviews, or calendar-check tasks that need fresh AI work at that future time.

If the user explicitly needs first-class external calendar notifications and a ready bound calendar connector is already present, you may use that bound connector instead of the feed.

${subscriptionLines.join('\n')}
Events in feed: ${feedInfo.eventCount}

If the user has not yet subscribed, send a markdown link such as \`[点击订阅日历](${buildCalendarSubscribeHelperPath()})\` directly in the conversation. Use \`${buildCalendarSubscribeHelperPath({ format: 'https' })}\` only as the manual fallback when the client does not handle the default subscription helper. Keep the message brief: describe what the subscription does, then provide the link. No separate setup page needed.

Do not use the host machine's local Calendar.app or any GUI calendar application.`);
    }
  } catch {}

  const genericConnectorActions = await buildGenericConnectorActionsSection();
  if (genericConnectorActions) {
    connectorSections.push(genericConnectorActions);
  }

  connectorSections.push(`### Gmail
This workspace can connect one Gmail account for mailbox automation. After Gmail is connected, prefer the \`remotelab gmail\` CLI for mailbox actions instead of asking the user to paste raw message bodies or forward email manually.

If the user mentions Gmail, email, inbox, mailbox, latest mail, recent mail, or asks you to find/read/search messages, first run \`remotelab gmail status --json\`. Do not claim Gmail is unavailable, ask for IMAP credentials, or say there is no access until you have checked the live Gmail status for this workspace.

If Gmail status is \`ready\`, use the Gmail CLI for the mailbox task. Use \`remotelab gmail --help\` for the available actions. Prefer \`--json\` when calling Gmail commands from the shell.

Supported Gmail operations include search, read, archive, mark-read, label changes, reply, and send through the bound Gmail account.

If the user asks to connect Gmail or Gmail is not ready yet, direct them to the Gmail connector in Settings or to \`/connectors/gmail\`. Do not use host browser cookies or ambient local Gmail sessions as a fallback.`);

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
