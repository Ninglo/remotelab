import { homedir } from 'os';
import { basename, join } from 'path';
import {
  CHAT_PORT,
  CONFIG_DIR,
  INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED,
  INSTANCE_ROOT,
  MANAGED_WORK_ROOT_DIR,
  PLATFORM_SKILLS_DIR,
} from '../lib/config.mjs';
import {
  buildCalendarSubscribeHelperPath,
  getFeedInfo,
} from '../lib/connector-calendar-feed.mjs';
import { resolveEmailConnectorBinding } from '../lib/connector-bindings.mjs';
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

const SYSTEM_STARTUP_CONTEXT_ASSET = 'system/startup-context.md';

/**
 * Build the RemoteLab session/scheduling capability section.
 * Returns the full section text with variables embedded, or '' if disabled.
 */
function buildSessionSpawnSection({ currentSessionId, chatPort }) {
  const sessionIdSuffix = currentSessionId ? ` (current: ${currentSessionId})` : '';
  return `## RemoteLab Session and Scheduling Capabilities

- Create a persistent side session: \`remotelab session-spawn --task "<task>" --json\`
- Create one and wait for its final result: add \`--wait\`.
- Suppress intermediate worker output: add \`--internal --output-mode final-only\`.
- Schedule a one-time AI turn: \`remotelab trigger create --in 2h --text "<task>" --json\`
- Schedule recurring AI work: \`remotelab schedule create --cron "0 9 * * 1-5" --timezone Asia/Shanghai --text "<task>" --json\`
- The equivalent fallback is \`node "$REMOTELAB_PROJECT_ROOT/cli.js" <command>\`.
- \`REMOTELAB_SESSION_ID\` is the source session id${sessionIdSuffix}; spawn, trigger, and schedule commands use it by default.
- \`REMOTELAB_CHAT_BASE_URL\` is the local API base URL, normally \`http://127.0.0.1:${chatPort}\`.
- \`REMOTELAB_PROJECT_ROOT\` is the installed RemoteLab source root.`;
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
  const includeSessionSpawn = options?.includeSessionSpawn !== false;

  let context = (await renderPromptAsset(SYSTEM_STARTUP_CONTEXT_ASSET, {
    ...buildPromptPathMap({ home }),
    CURRENT_SESSION_ID_SUFFIX: currentSessionId ? ` (current: ${currentSessionId})` : '',
    CHAT_PORT: String(CHAT_PORT),
    SESSION_SPAWN_SECTION: includeSessionSpawn
      ? buildSessionSpawnSection({ currentSessionId, chatPort: String(CHAT_PORT) })
      : '',
  })).trim();

  if (!hasBootstrap && hasGlobal) {
    context += `

## Memory Layout Status
This machine has ${globalPath} but no ${bootstrapPath}. A small bootstrap index can be created when useful.`;
  }

  if (!hasProjects && (hasBootstrap || hasGlobal)) {
    context += `

## Memory Layout Status
No project pointer index exists at ${projectsPath}.`;
  }

  if (!hasSkills) {
    context += `

## Memory Layout Status
No local skill index exists at ${skillsPath}.`;
  }

  if (isFirstTime) {
    context += `

## Memory Layout Status
This machine has not initialized ${bootstrapPath} or ${globalPath}.`;
  }

  const scopedInstanceName = basename(INSTANCE_ROOT || '').trim().toLowerCase();
  if (INSTANCE_ROOT && scopedInstanceName) {
    context += INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED
      ? `

## Instance Isolation Boundary
This session is running inside the instance-scoped environment \`${scopedInstanceName}\`.
- Filesystem access is confined to ${displayPromptPath(INSTANCE_ROOT, home)} by the runtime.
- The instance workspace is ${displayPromptPath(MANAGED_WORK_ROOT_DIR, home)}.`
      : `

## Instance Local Access
This session is running inside the instance-scoped environment \`${scopedInstanceName}\`.
- The instance workspace is ${displayPromptPath(MANAGED_WORK_ROOT_DIR, home)}.
- RemoteLab is not applying a filesystem confinement boundary to this Harness process.`;
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

  try {
    const agentMailbox = await resolveEmailConnectorBinding();
    const mailboxAddress = typeof agentMailbox?.identity?.address === 'string'
      ? agentMailbox.identity.address.trim()
      : '';
    const mailboxName = typeof agentMailbox?.identity?.name === 'string'
      ? agentMailbox.identity.name.trim()
      : '';
    if (agentMailbox?.capabilityState === 'ready' && mailboxAddress) {
      const mailboxIdentity = mailboxName ? `${mailboxName} <${mailboxAddress}>` : mailboxAddress;
      connectorSections.push(`### Agent Mailbox
This instance has its own ready outbound mailbox identity: \`${mailboxIdentity}\`. For a new message in the assistant's own identity, write the complete UTF-8 body to a file and use \`remotelab mail send --to "<recipient>" --subject "<subject>" --text-file "<body-path>" --json\`. Use \`--text\` only for a genuinely single-line body. For any paragraph or line break, use \`--text-file\` or \`--stdin\`; never put literal \`\\n\` sequences in \`--text\`, because the mail commands transmit those two characters instead of turning them into line breaks. Use \`remotelab mail --help\` for other supported options.

Identity policy:
- Agent-originated messages such as monitoring alerts, reminders, reports, status updates, and proactive follow-ups must use this Agent Mailbox by default.
- The bound Gmail account belongs to the user; it is not the assistant's default sender or a generic notification transport.
- Use Gmail to reply or send as the user only when the user explicitly asks to operate their mailbox or the task clearly requires the user's identity.
- Never switch from the Agent Mailbox to the user's Gmail merely because delivery from the Agent Mailbox fails. Report the delivery/configuration failure instead.`);
    }
  } catch {}

  connectorSections.push(`### Gmail
This workspace can connect one user-owned Gmail account for mailbox automation. Treat it as authority to operate the user's mailbox, not as the assistant's own sending identity.

If the user mentions Gmail, inbox, latest mail, recent mail, or asks you to find, read, organize, or reply to messages in their mailbox, first run \`remotelab gmail status --json\`. Do not claim Gmail is unavailable, ask for IMAP credentials, or say there is no access until you have checked the live Gmail status for this workspace.

If Gmail status is \`ready\`, use the Gmail CLI for that user-mailbox task. Use \`remotelab gmail --help\` for the available actions. Prefer \`--json\` when calling Gmail commands from the shell. For multi-line replies or sends, use \`--text-file\` or \`--stdin\`, not literal \`\\n\` sequences inside \`--text\`.

Supported Gmail operations include search, read, archive, mark-read, label changes, reply, and user-authorized send. A new alert, reminder, report, status update, or proactive follow-up from the assistant must use the ready Agent Mailbox above instead of Gmail. Sending a new message through Gmail is appropriate only when the user explicitly asks to send as them or the task clearly depends on their identity; that command requires explicit identity acknowledgement with \`remotelab gmail send --as-user ...\`.

If the user asks to connect Gmail or Gmail is not ready yet, direct them to the Gmail connector in Settings or to \`/connectors/gmail\`. Do not use host browser cookies or ambient local Gmail sessions as a fallback.`);

  let section = `

## Instance Connectors

This section is the complete RemoteLab connector-action catalog for this instance. If an action is absent, no instance-bound RemoteLab connector is configured for it.`;

  if (connectorSections.length > 0) {
    section += '\n\n' + connectorSections.join('\n\n');
  } else {
    section += '\n\nNo external connectors are currently configured for this instance.';
  }

  return section;
}
