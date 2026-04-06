import { homedir } from 'os';
import { CHAT_PORT, PUBLIC_BASE_URL, SHARED_STARTUP_DEFAULTS_ENABLED } from '../lib/config.mjs';
import { getFeedInfo } from '../lib/connector-calendar-feed.mjs';
import { pathExists } from './fs-utils.mjs';
import { renderPromptAsset } from './prompt-asset-loader.mjs';
import {
  BOOTSTRAP_MD,
  GLOBAL_MD,
  PROJECTS_MD,
  SKILLS_MD,
  buildPromptPathMap,
} from './prompt-paths.mjs';
import { MANAGER_RUNTIME_BOUNDARY_SECTION } from './runtime-policy.mjs';
import { buildSharedStartupDefaultsSection } from './shared-startup-defaults.mjs';

const SYSTEM_STARTUP_CONTEXT_ASSET = 'system/startup-context.md';

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

  let context = (await renderPromptAsset(SYSTEM_STARTUP_CONTEXT_ASSET, {
    ...buildPromptPathMap({ home }),
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    CURRENT_SESSION_ID_SUFFIX: currentSessionId ? ` (current: ${currentSessionId})` : '',
    CHAT_PORT: String(CHAT_PORT),
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
  try {
    const feedInfo = await getFeedInfo();
    if (!feedInfo?.feedToken) return '';

    const baseUrl = resolvePublicCalendarBaseUrl();
    if (!baseUrl) return '';
    const host = new URL(baseUrl).host;
    const webcalUrl = `webcal://${host}/cal/${feedInfo.feedToken}.ics`;
    const httpsUrl = `${baseUrl}/cal/${feedInfo.feedToken}.ics`;

    return `

## Instance Connectors

### Calendar (iCal Subscription Feed)
Calendar events are delivered via an iCal subscription feed — not through local Calendar.app or Google Calendar API. When the user requests a calendar event, create a completion target with type "calendar". The event is stored locally and immediately available in the .ics feed.

Subscription link (webcal): ${webcalUrl}
Subscription link (https): ${httpsUrl}
Events in feed: ${feedInfo.eventCount}

If the user has not yet subscribed, send the webcal:// link directly in the conversation — it is clickable on iOS/macOS and triggers the native "Subscribe to Calendar?" dialog. Keep the message brief: describe what the subscription does, then provide the link. No separate setup page needed.

Do not use the host machine's local Calendar.app or any GUI calendar application. All calendar writes go through the feed.`;
  } catch {
    return '';
  }
}

function resolvePublicCalendarBaseUrl() {
  const baseUrl = typeof PUBLIC_BASE_URL === 'string'
    ? PUBLIC_BASE_URL.trim().replace(/\/+$/, '')
    : '';
  if (!baseUrl) return '';

  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}
