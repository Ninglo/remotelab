const SESSION_LIST_ORGANIZER_INTERNAL_ROLE = 'session_list_organizer';
const PROJECT_MAINTENANCE_INTERNAL_OPERATION = 'session_project_maintenance';
const DEFAULT_PROJECT_MAINTENANCE_DEBOUNCE_MS = 2_000;
const MIN_SESSIONS_FOR_PROJECT_MAINTENANCE = 4;
const SINGLETON_RATIO_TRIGGER = 0.35;
const MAX_TEXT_CHARS = 240;

const SESSION_LIST_ORGANIZER_SYSTEM_PROMPT = [
  'You are RemoteLab\'s hidden session-list organizer.',
  'Your job is to improve one account\'s scoped non-archived Chat UI Projects sidebar structure using the provided metadata snapshot.',
  'Account boundaries are strict: never infer, copy, merge, or normalize Space, Project, or sidebar order across different accounts.',
  'Do not rename sessions, archive or unarchive them, change pin state, edit prompts, or ask the user follow-up questions.',
  'Only update existing sessions by calling the owner-authenticated RemoteLab API from this machine.',
  'Use `remotelab api GET /api/sessions` if you need to double-check current state.',
  'Use `remotelab api PATCH /api/sessions/<sessionId> --body ...` to update `space`, `group`, and `sidebarOrder`.',
  'Only writable API fields for this task are `space`, `group`, and `sidebarOrder`.',
  'Never send read-only snapshot keys such as `title`, `brief`, `existingSpace`, `existingGroup`, or `existingSidebarOrder` in PATCH bodies.',
  'Example PATCH body: {"space":"Product","group":"RemoteLab","sidebarOrder":3}',
  'If `remotelab` is unavailable in PATH, use `node "$REMOTELAB_PROJECT_ROOT/cli.js" api ...` instead.',
  '`sidebarOrder` must be a positive integer; smaller numbers sort first.',
  'Assign unique contiguous `sidebarOrder` values across only the scoped sessions included in the snapshot.',
  'Do not patch sessions outside the snapshot; other source categories are intentionally left untouched for audit or automation review.',
  'RemoteLab has two visible levels: a small set of broad Spaces, then concrete Projects groups inside each Space.',
  'Use the provided `targetSpaceCount` as a soft upper budget. Reuse broad durable Spaces and do not create a Space for every Project.',
  'Use the provided `targetProjectCount` as a soft budget: when there are few sessions, groups may be fine-grained; when there are many sessions, merge related workstreams into coarser projects.',
  'Use the provided `groupSummary` to detect over-splitting; a high singleton count is a stronger signal than individually reasonable group labels.',
  'Avoid excessive singleton groups when `totalSessions` is greater than `targetProjectCount`.',
  'Treat existing group assignments as provisional; this is a full scoped rebalance, so you may merge, split, or rewrite groups across the entire snapshot.',
  'Project compression is allowed: when several existing groups are fragments of the same workstream, choose a clearer shared Project name and patch every affected session to that new `group`.',
  'Do not only classify the newest session; improve older scoped sessions when this account\'s list has drifted.',
  'Do not create one Project per session unless the session is genuinely standalone, newly emerging but likely to recur, or high-priority active work that needs its own entry.',
  'If metadata is insufficient for an important merge/split decision, inspect a small number of ambiguous sessions with the API instead of inventing narrowly isolated groups.',
  'If semantic purity conflicts with scanability, prefer the grouping that keeps the Projects view easier to consume.',
  'Keep genuinely unrelated or high-priority active work separate even if that creates a small group.',
  'Return only a brief plain-text summary of the grouping strategy you applied.',
].join('\n');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInlineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clipText(value, maxChars = MAX_TEXT_CHARS) {
  const text = normalizeInlineText(value);
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function getSessionSortTime(session) {
  const stamp = session?.lastEventAt || session?.updatedAt || session?.created || '';
  const time = typeof stamp === 'number' ? stamp : Date.parse(String(stamp || '').trim());
  return Number.isFinite(time) ? time : 0;
}

function normalizeSidebarOrder(value) {
  if (Number.isInteger(value) && value > 0) return value;
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function resolveSessionSourceId(session) {
  const sourceId = trimString(session?.sourceId);
  return sourceId || 'chat';
}

export function isProjectMaintenanceScopedSession(session) {
  if (!session || session.archived === true || session.internalRole || session.visitorId) return false;
  return resolveSessionSourceId(session).toLowerCase() === 'chat';
}

export function getProjectMaintenanceAccountId(session) {
  return trimString(session?.userId) || 'owner';
}

export function isProjectMaintenanceAccountMatch(session, triggerSession = null) {
  return getProjectMaintenanceAccountId(session) === getProjectMaintenanceAccountId(triggerSession);
}

export function getSessionListOrganizerTargetProjectCount(totalSessions) {
  if (!Number.isInteger(totalSessions) || totalSessions <= 0) return 0;
  if (totalSessions <= 5) return totalSessions;
  if (totalSessions <= 18) return Math.min(totalSessions, Math.max(4, Math.min(6, Math.round(totalSessions / 3))));
  if (totalSessions <= 40) return Math.min(totalSessions, Math.max(6, Math.min(8, Math.round(totalSessions / 5))));
  return Math.min(totalSessions, Math.max(8, Math.min(10, Math.round(totalSessions / 8))));
}

export function getSessionListOrganizerTargetSpaceCount(totalSessions) {
  if (!Number.isInteger(totalSessions) || totalSessions <= 0) return 0;
  if (totalSessions <= 12) return Math.min(2, totalSessions);
  if (totalSessions <= 40) return 3;
  if (totalSessions <= 120) return 4;
  if (totalSessions <= 240) return 5;
  return 6;
}

export function buildProjectMaintenanceSessionMetadata(session) {
  const taskCard = session?.taskCard && typeof session.taskCard === 'object' ? session.taskCard : null;
  const brief = [
    trimString(session?.description),
    trimString(taskCard?.summary),
    trimString(taskCard?.goal),
  ].filter(Boolean).join(' ');
  return {
    id: trimString(session?.id),
    title: clipText(session?.name || '', 160),
    brief: clipText(brief, 360),
    existingSpace: trimString(session?.space) ? clipText(session.space, 60) : null,
    existingGroup: trimString(session?.group) ? clipText(session.group, 80) : null,
    existingSidebarOrder: normalizeSidebarOrder(session?.sidebarOrder) || null,
    pinned: session?.pinned === true,
    tool: clipText(session?.tool || '', 40),
    sourceId: clipText(resolveSessionSourceId(session), 80),
    sourceCategory: 'chat',
    sourceName: clipText(session?.sourceName || 'RemoteLab', 80),
    folder: clipText(session?.folder || '', 180),
    workflowState: clipText(session?.workflowState || '', 40),
    workflowPriority: clipText(session?.workflowPriority || '', 40),
    created: clipText(session?.created || '', 40),
    updatedAt: clipText(session?.updatedAt || '', 40),
    lastEventAt: clipText(session?.lastEventAt || '', 40),
  };
}

export function buildProjectMaintenanceGroupSummary(sessionPayloads, targetProjectCount = 0) {
  const groups = new Map();
  for (const session of Array.isArray(sessionPayloads) ? sessionPayloads : []) {
    const rawGroup = typeof session?.existingGroup === 'string' && session.existingGroup.trim()
      ? session.existingGroup.trim()
      : '(ungrouped)';
    if (!groups.has(rawGroup)) {
      groups.set(rawGroup, {
        group: rawGroup,
        count: 0,
        examples: [],
      });
    }
    const group = groups.get(rawGroup);
    group.count += 1;
    const title = clipText(session?.title || '', 80);
    if (title && group.examples.length < 3) {
      group.examples.push(title);
    }
  }

  const groupList = [...groups.values()].sort((a, b) => (
    (b.count - a.count)
    || a.group.localeCompare(b.group, undefined, { numeric: true, sensitivity: 'base' })
  ));
  const singletonGroups = groupList.filter((group) => group.count === 1);
  const totalGroups = groupList.length;
  const parsedTarget = Number.isInteger(targetProjectCount) && targetProjectCount > 0
    ? targetProjectCount
    : 0;
  const singletonRatio = totalGroups > 0
    ? Number((singletonGroups.length / totalGroups).toFixed(2))
    : 0;

  return {
    totalGroups,
    targetProjectCount: parsedTarget,
    overTarget: parsedTarget > 0 && totalGroups > parsedTarget,
    singletonGroups: singletonGroups.length,
    singletonRatio,
    largestGroups: groupList.slice(0, 8),
    singletonExamples: singletonGroups.slice(0, 12).map((group) => ({
      group: group.group,
      title: group.examples[0] || '',
    })),
  };
}

export function buildProjectMaintenancePayload(sessions, triggerSession = null) {
  const accountId = getProjectMaintenanceAccountId(triggerSession);
  const accountName = trimString(triggerSession?.userName) || (accountId === 'owner' ? 'Owner' : accountId);
  const scopedSessions = (Array.isArray(sessions) ? sessions : [])
    .filter(isProjectMaintenanceScopedSession)
    .filter((session) => isProjectMaintenanceAccountMatch(session, triggerSession))
    .sort((a, b) => getSessionSortTime(b) - getSessionSortTime(a));
  const targetProjectCount = getSessionListOrganizerTargetProjectCount(scopedSessions.length);
  const targetSpaceCount = getSessionListOrganizerTargetSpaceCount(scopedSessions.length);
  const sessionPayloads = scopedSessions
    .map(buildProjectMaintenanceSessionMetadata)
    .filter((session) => session.id);
  const groupSummary = buildProjectMaintenanceGroupSummary(sessionPayloads, targetProjectCount);
  return {
    generatedAt: new Date().toISOString(),
    totalSessions: sessionPayloads.length,
    targetSpaceCount,
    targetProjectCount,
    targetSessionsPerProject: targetProjectCount > 0
      ? Math.ceil(sessionPayloads.length / targetProjectCount)
      : 0,
    scope: {
      currentSourceFilter: 'chat',
      organizerSourceFilter: 'chat',
      sourceLabel: 'Chat UI',
      defaultedToChatUi: true,
      accountId,
      accountName,
      triggerSessionId: trimString(triggerSession?.id),
    },
    groupSummary,
    sessions: sessionPayloads,
  };
}

export function evaluateProjectMaintenanceHealth(sessions, triggerSession = null) {
  const payload = buildProjectMaintenancePayload(sessions, triggerSession);
  const reasons = [];
  if (payload.totalSessions < MIN_SESSIONS_FOR_PROJECT_MAINTENANCE) {
    return {
      shouldRun: false,
      reasons,
      payload,
    };
  }

  const missingSidebarOrderCount = payload.sessions.filter((session) => !session.existingSidebarOrder).length;
  const missingSpaceCount = payload.sessions.filter((session) => !session.existingSpace).length;
  const triggerGroup = trimString(triggerSession?.group) || '(ungrouped)';
  const triggerGroupSize = payload.sessions.filter((session) => (
    (trimString(session.existingGroup) || '(ungrouped)') === triggerGroup
  )).length;

  if (payload.groupSummary.overTarget) {
    reasons.push('project_count_over_target');
  }
  if (
    payload.groupSummary.singletonGroups >= 2
    && payload.groupSummary.singletonRatio >= SINGLETON_RATIO_TRIGGER
    && payload.groupSummary.totalGroups > payload.targetProjectCount
  ) {
    reasons.push('singleton_ratio_high');
  }
  if (triggerSession?.id && triggerGroupSize === 1 && payload.groupSummary.totalGroups >= payload.targetProjectCount) {
    reasons.push('trigger_session_singleton_project');
  }
  if (missingSidebarOrderCount > 0) {
    reasons.push('missing_sidebar_order');
  }
  if (missingSpaceCount > 0) {
    reasons.push('missing_space');
  }

  return {
    shouldRun: reasons.length > 0,
    reasons,
    payload: {
      ...payload,
      health: {
        reasons,
        missingSpaceCount,
        missingSidebarOrderCount,
        triggerGroup,
        triggerGroupSize,
      },
    },
  };
}

export function buildProjectMaintenanceTask(input) {
  const payload = input && typeof input === 'object'
    ? input
    : { sessions: [] };
  const totalSessions = Array.isArray(payload.sessions) ? payload.sessions.length : 0;
  const targetSpaceCount = Number.isInteger(payload.targetSpaceCount) && payload.targetSpaceCount > 0
    ? payload.targetSpaceCount
    : getSessionListOrganizerTargetSpaceCount(totalSessions);
  const targetProjectCount = Number.isInteger(payload.targetProjectCount) && payload.targetProjectCount > 0
    ? payload.targetProjectCount
    : getSessionListOrganizerTargetProjectCount(totalSessions);
  const targetSessionsPerProject = Number.isInteger(payload.targetSessionsPerProject) && payload.targetSessionsPerProject > 0
    ? payload.targetSessionsPerProject
    : (targetProjectCount > 0 ? Math.ceil(totalSessions / targetProjectCount) : 0);
  const groupSummary = payload.groupSummary && typeof payload.groupSummary === 'object'
    ? payload.groupSummary
    : buildProjectMaintenanceGroupSummary(payload.sessions, targetProjectCount);
  return [
    'Organize only the scoped non-archived RemoteLab Chat UI sessions included in the provided metadata snapshot.',
    'This run was triggered automatically after a session state change. Keep the result stable and conservative, but fix obvious drift.',
    `The snapshot belongs only to account ${payload?.scope?.accountName || payload?.scope?.accountId || 'Owner'}. Treat Space, Project, and sidebar order as account-local metadata and do not inspect or patch another account's sessions.`,
    `Create or reuse roughly ${targetSpaceCount} broad Spaces for ${totalSessions} scoped sessions; this is a soft upper budget, not a target to fill.`,
    'Spaces are durable context boundaries. Projects are concrete workstreams inside a Space. Assign genuinely temporary or ambiguous sessions to the reserved `Loose` Space rather than inventing a weak category.',
    'Use the dominant language of the session titles and current catalog for user-visible Space and Project names; when that language is Chinese, use concise natural Chinese labels.',
    'Choose clearer Projects groups and a better sidebar ordering based on actual workstream similarity, current user consumption, and the target project budget.',
    `Target roughly ${targetProjectCount} Projects groups for ${totalSessions} scoped sessions; this is a soft budget, not an exact quota.`,
    targetSessionsPerProject > 0
      ? `Aim for about ${targetSessionsPerProject} sessions per Project when the workstreams are related enough to merge.`
      : '',
    `Current snapshot has ${groupSummary.totalGroups || 0} existing groups and ${groupSummary.singletonGroups || 0} singleton groups; use this as the main over-splitting signal.`,
    groupSummary.overTarget || (groupSummary.singletonRatio || 0) >= SINGLETON_RATIO_TRIGGER
      ? 'The current grouping is likely over-split. Prioritize merging related singleton or near-duplicate groups before fine-tuning order.'
      : '',
    'Treat this as a full scoped rebalance: previous groups are useful hints, not fixed truth, and singleton groups should be merged when they are just feature slices of the same workstream.',
    'If several old groups now read as fragments of one better topic, compress them by assigning a clearer shared `group` name to every included session.',
    'Apply changes by calling the RemoteLab API from this machine; do not merely suggest them.',
    'Snapshot fields like `title`, `brief`, `existingSpace`, `existingGroup`, and `existingSidebarOrder` are read-only context.',
    'Do not patch any session that is not present in the `sessions` array below.',
    'When patching a session, send only `space`, `group`, and `sidebarOrder` in the API body.',
    '',
    '<session_list_organizer_input>',
    JSON.stringify({
      ...payload,
      targetSpaceCount,
      targetProjectCount,
      targetSessionsPerProject,
      groupSummary,
    }, null, 2),
    '</session_list_organizer_input>',
  ].filter((line) => line !== '').join('\n');
}

export function createSessionProjectMaintenanceScheduler(services = {}) {
  const {
    createSession,
    loadSessionsMeta,
    logger = console,
    sendMessage,
    setTimeout: setTimeoutFn = globalThis.setTimeout,
    clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
    debounceMs = DEFAULT_PROJECT_MAINTENANCE_DEBOUNCE_MS,
  } = services;

  let pendingTrigger = null;
  let pendingTimer = null;
  let running = false;
  let rerunRequested = false;

  async function run(triggerSession = null) {
    if (running) {
      rerunRequested = true;
      pendingTrigger = triggerSession || pendingTrigger;
      return false;
    }
    running = true;
    try {
      const sessions = typeof loadSessionsMeta === 'function' ? await loadSessionsMeta() : [];
      const health = evaluateProjectMaintenanceHealth(sessions, triggerSession);
      if (!health.shouldRun) {
        return false;
      }

      const tool = trimString(triggerSession?.tool) || 'codex';
      const organizerSession = await createSession(
        trimString(triggerSession?.folder) || '~',
        tool,
        'sort session list',
        {
          systemPrompt: SESSION_LIST_ORGANIZER_SYSTEM_PROMPT,
          internalRole: SESSION_LIST_ORGANIZER_INTERNAL_ROLE,
          ...(trimString(triggerSession?.userId) ? { userId: trimString(triggerSession.userId) } : {}),
          ...(trimString(triggerSession?.userName) ? { userName: trimString(triggerSession.userName) } : {}),
        },
      );
      if (!organizerSession?.id) {
        throw new Error('Failed to create hidden Project organizer session');
      }

      await sendMessage(
        organizerSession.id,
        buildProjectMaintenanceTask(health.payload),
        [],
        {
          tool,
          ...(trimString(triggerSession?.model) ? { model: trimString(triggerSession.model) } : {}),
          ...(trimString(triggerSession?.effort) ? { effort: trimString(triggerSession.effort) } : {}),
          thinking: triggerSession?.thinking === true,
          internalOperation: PROJECT_MAINTENANCE_INTERNAL_OPERATION,
          queueIfBusy: false,
        },
      );

      logger?.log?.(
        `[project-maintenance] queued organizer for ${health.payload.totalSessions} Chat UI sessions`
        + ` in account ${health.payload.scope?.accountId || 'owner'}`
        + ` (${health.payload.health?.reasons?.join(', ') || 'health'})`,
      );
      return true;
    } catch (error) {
      logger?.error?.(`[project-maintenance] failed: ${error.message}`);
      return false;
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        const nextTrigger = pendingTrigger;
        pendingTrigger = null;
        schedule(nextTrigger, { immediate: false });
      }
    }
  }

  function schedule(triggerSession = null, options = {}) {
    if (!isProjectMaintenanceScopedSession(triggerSession)) return false;
    pendingTrigger = triggerSession;
    if (pendingTimer) {
      clearTimeoutFn(pendingTimer);
      pendingTimer = null;
    }
    const delay = options.immediate === true ? 0 : debounceMs;
    pendingTimer = setTimeoutFn(() => {
      pendingTimer = null;
      const nextTrigger = pendingTrigger;
      pendingTrigger = null;
      void run(nextTrigger);
    }, delay);
    return true;
  }

  return {
    runProjectMaintenanceNow: run,
    schedulePostTurnProjectMaintenance: schedule,
  };
}

export {
  PROJECT_MAINTENANCE_INTERNAL_OPERATION,
  SESSION_LIST_ORGANIZER_INTERNAL_ROLE,
  SESSION_LIST_ORGANIZER_SYSTEM_PROMPT,
};
