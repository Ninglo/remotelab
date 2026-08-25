function restoreOwnerSessionSelection() {
  if (visitorMode) return;

  const currentTab = typeof getActiveSidebarTabValue === "function"
    ? getActiveSidebarTabValue()
    : activeTab;
  const requestedTab = pendingNavigationState?.tab || currentTab;
  if (requestedTab !== currentTab) {
    switchTab(requestedTab, { syncState: false });
  }

  const targetSession = resolveRestoreTargetSession();
  if (!targetSession) {
    if (currentSessionId && typeof settleAttachedSessionSidebarState === "function") {
      Promise.resolve(settleAttachedSessionSidebarState({
        sessionId: currentSessionId,
        sync: true,
        render: false,
      })).catch(() => {});
    }
    if (typeof setChatCurrentSession === "function") {
      setChatCurrentSession(null, { hasAttachedSession: false });
    } else {
      currentSessionId = null;
      hasAttachedSession = false;
    }
    resetAttachedSessionRenderState();
    persistActiveSessionId(null);
    syncBrowserState({ sessionId: null, tab: getActiveSidebarTabValue() });
    showEmpty();
    restoreDraft();
    updateStatus("connected");
    pendingNavigationState = null;
    return;
  }

  if (!hasAttachedSession || currentSessionId !== targetSession.id) {
    attachSession(targetSession.id, targetSession);
  } else {
    syncBrowserState();
  }
  pendingNavigationState = null;
}

function canOrganizeSessionListFromUi() {
  return typeof canOrganizeSessionList === "function"
    ? canOrganizeSessionList()
    : !visitorMode;
}

function isOwnerPushFeatureEnabled() {
  return typeof shouldEnableOwnerPushFeatures === "function"
    ? shouldEnableOwnerPushFeatures()
    : !visitorMode;
}

if (
  "serviceWorker" in navigator
  && typeof navigator.serviceWorker?.addEventListener === "function"
) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "remotelab:open-session") return;
    applyNavigationState(event.data);
    window.focus();
    return queueForegroundRefresh({
      forceFresh: true,
      viewportIntent: "session_entry",
    }).catch(() => {});
  });
}

function notifyCompletion(session) {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return;
  if (document.visibilityState === "visible") return;
  const folder = (session?.folder || "").split("/").pop() || "Session";
  const name = session?.name || folder;
  const n = new Notification("RemoteLab", {
    body: `${name} — task completed`,
    tag: "remotelab-done",
  });
  n.onclick = () => {
    window.focus();
    applyNavigationState({ sessionId: session?.id, tab: "sessions" });
    queueForegroundRefresh({
      forceFresh: true,
      viewportIntent: "session_entry",
    }).catch(() => {});
    n.close();
  };
}

const FOREGROUND_REFRESH_THROTTLE_MS = 1500;
const FOREGROUND_SESSION_LIST_STALE_MS = 15000;
const FOREGROUND_IDLE_SESSION_STALE_MS = 15000;
let foregroundRefreshPromise = null;
let foregroundRefreshHandlersReady = false;
let lastForegroundRefreshAt = 0;
let lastSessionsListRefreshAt = 0;
let lastArchivedSessionsRefreshAt = 0;
let lastCurrentSessionRefreshAt = 0;
let lastCurrentSessionRefreshSessionId = null;
let pendingCurrentSessionRefreshOptions = null;

function buildSessionRefreshRequestOptions(forceFresh = false) {
  return forceFresh
    ? { revalidate: false, cache: "no-store" }
    : {};
}

function mergeSessionRefreshOptions(current = {}, next = {}) {
  return {
    forceFresh: current.forceFresh === true || next.forceFresh === true,
    viewportIntent:
      normalizeSessionViewportIntent(current.viewportIntent) === "session_entry"
      || normalizeSessionViewportIntent(next.viewportIntent) === "session_entry"
        ? "session_entry"
        : "preserve",
  };
}

function canQueueForegroundRefresh() {
  if (
    (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode)
    || typeof document === "undefined"
  ) {
    return false;
  }
  if (document.visibilityState === "hidden") {
    return false;
  }
  if (visitorMode) {
    return Boolean(
      currentSessionId
      || (typeof visitorSessionId !== "undefined" && visitorSessionId),
    );
  }
  return true;
}

function isRefreshStale(lastRefreshAt, staleMs) {
  return !Number.isFinite(lastRefreshAt)
    || lastRefreshAt <= 0
    || Date.now() - lastRefreshAt >= staleMs;
}

function isArchiveSectionExpanded() {
  return typeof localStorage !== "undefined"
    && typeof localStorage.getItem === "function"
    && localStorage.getItem("archivedCollapsed") === "false";
}

function shouldRefreshForegroundSessionList({ forceFresh = false } = {}) {
  if (forceFresh) return true;
  if (!hasLoadedSessions) return true;
  if (pendingNavigationState) return true;
  if (currentSessionId && typeof findClientSessionRecord === "function" && !findClientSessionRecord(currentSessionId)) {
    return true;
  }
  return isRefreshStale(lastSessionsListRefreshAt, FOREGROUND_SESSION_LIST_STALE_MS);
}

function shouldRefreshForegroundArchivedSessions({
  forceFresh = false,
  refreshedSessionsList = false,
} = {}) {
  if (!archivedSessionsLoaded || !isArchiveSectionExpanded()) return false;
  if (forceFresh) return true;
  if (refreshedSessionsList) return true;
  return isRefreshStale(lastArchivedSessionsRefreshAt, FOREGROUND_SESSION_LIST_STALE_MS);
}

function shouldRefreshForegroundCurrentSession({ forceFresh = false } = {}) {
  if (!currentSessionId) return false;
  if (forceFresh) return true;
  if (!hasAttachedSession) return true;
  if (pendingNavigationState) return true;
  const session = typeof findClientSessionRecord === "function"
    ? findClientSessionRecord(currentSessionId)
    : null;
  if (!session) return true;
  if (getSessionRunState(session) === "running") return true;
  if (!hasRenderedEventSnapshot(currentSessionId)) return true;
  if (lastCurrentSessionRefreshSessionId !== currentSessionId) return true;
  return isRefreshStale(lastCurrentSessionRefreshAt, FOREGROUND_IDLE_SESSION_STALE_MS);
}

async function runForegroundRefresh({ forceFresh = false, viewportIntent = "preserve" } = {}) {
  if (!canQueueForegroundRefresh()) return null;
  await refreshRealtimeViews({ forceFresh, viewportIntent, refreshMode: "foreground" });
  return currentSessionId || null;
}

function queueForegroundRefresh(options = {}) {
  const requestOptions = mergeSessionRefreshOptions(
    { forceFresh: false, viewportIntent: "preserve" },
    options,
  );
  if (!canQueueForegroundRefresh()) {
    return Promise.resolve(null);
  }
  if (foregroundRefreshPromise) {
    return foregroundRefreshPromise;
  }
  const now = Date.now();
  if (now - lastForegroundRefreshAt < FOREGROUND_REFRESH_THROTTLE_MS) {
    return Promise.resolve(null);
  }
  lastForegroundRefreshAt = now;
  foregroundRefreshPromise = (async () => {
    try {
      return await runForegroundRefresh(requestOptions);
    } finally {
      foregroundRefreshPromise = null;
    }
  })();
  return foregroundRefreshPromise;
}

function setupForegroundRefreshHandlers() {
  if (foregroundRefreshHandlersReady) return;
  foregroundRefreshHandlersReady = true;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return null;
      return queueForegroundRefresh().catch(() => {});
    });
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", () => queueForegroundRefresh().catch(() => {}));
    window.addEventListener("pageshow", () => queueForegroundRefresh().catch(() => {}));
  }
}

const SESSION_LIST_ORGANIZER_POLL_INTERVAL_MS = 1200;
const SESSION_LIST_ORGANIZER_POLL_TIMEOUT_MS = 90 * 1000;
const SESSION_LIST_ORGANIZER_INTERNAL_ROLE = "session_list_organizer";
const DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL = "Sort List";
const SESSION_HTTP_SOURCE_FILTER_CHAT_VALUE = typeof SOURCE_FILTER_CHAT_VALUE !== "undefined" ? SOURCE_FILTER_CHAT_VALUE : "chat_ui";
const SESSION_HTTP_SOURCE_FILTER_FEISHU_VALUE = typeof SOURCE_FILTER_FEISHU_VALUE !== "undefined" ? SOURCE_FILTER_FEISHU_VALUE : "feishu";
const SESSION_HTTP_SOURCE_FILTER_EMAIL_VALUE = typeof SOURCE_FILTER_EMAIL_VALUE !== "undefined" ? SOURCE_FILTER_EMAIL_VALUE : "email";
const SESSION_HTTP_SOURCE_FILTER_BOT_VALUE = typeof SOURCE_FILTER_BOT_VALUE !== "undefined" ? SOURCE_FILTER_BOT_VALUE : "bot";
const SESSION_HTTP_SOURCE_FILTER_AUTOMATION_VALUE = typeof SOURCE_FILTER_AUTOMATION_VALUE !== "undefined" ? SOURCE_FILTER_AUTOMATION_VALUE : "automation";
const SESSION_HTTP_FILTER_ALL_VALUE = typeof FILTER_ALL_VALUE !== "undefined" ? FILTER_ALL_VALUE : "all";
const SESSION_LIST_ORGANIZER_SOURCE_LABELS = {
  [SESSION_HTTP_SOURCE_FILTER_CHAT_VALUE]: "Chat UI",
  [SESSION_HTTP_SOURCE_FILTER_FEISHU_VALUE]: "Feishu",
  [SESSION_HTTP_SOURCE_FILTER_EMAIL_VALUE]: "Email",
  [SESSION_HTTP_SOURCE_FILTER_BOT_VALUE]: "Bot",
  [SESSION_HTTP_SOURCE_FILTER_AUTOMATION_VALUE]: "Automation",
  [SESSION_HTTP_FILTER_ALL_VALUE]: "All origins",
};
let sessionListOrganizerInFlight = null;
let sessionListOrganizerLabelResetTimer = null;

const SESSION_LIST_ORGANIZER_SYSTEM_PROMPT = [
  "You are RemoteLab's hidden session-list organizer.",
  "Your job is to improve one account's scoped non-archived session sidebar structure using the provided metadata snapshot.",
  "Account boundaries are strict: never infer, copy, merge, or normalize Space, Project, or sidebar order across different accounts.",
  "Do not rename sessions, archive or unarchive them, change pin state, edit prompts, or ask the user follow-up questions.",
  "Only update existing sessions by calling the owner-authenticated RemoteLab API from this machine.",
  "Use `remotelab api GET /api/sessions` if you need to double-check current state.",
  "Use `remotelab api PATCH /api/sessions/<sessionId> --body ...` to update `space`, `group`, and `sidebarOrder`.",
  "Only writable API fields for this task are `space`, `group`, and `sidebarOrder`.",
  "Never send read-only snapshot keys such as `title`, `brief`, `existingSpace`, `existingGroup`, or `existingSidebarOrder` in PATCH bodies.",
  "Example PATCH body: {\"space\":\"Product\",\"group\":\"RemoteLab\",\"sidebarOrder\":3}",
  "If `remotelab` is unavailable in PATH, use `node \"$REMOTELAB_PROJECT_ROOT/cli.js\" api ...` instead.",
  "`sidebarOrder` must be a positive integer; smaller numbers sort first.",
  "Assign unique contiguous `sidebarOrder` values across only the scoped sessions included in the snapshot.",
  "Do not patch sessions outside the snapshot; other source categories are intentionally left untouched for audit or automation review.",
  "RemoteLab has two visible levels: a small set of broad Spaces, then concrete Projects groups inside each Space.",
  "Use the provided `targetSpaceCount` as a soft upper budget. Reuse broad durable Spaces and do not create a Space for every Project.",
  "Use the provided `targetProjectCount` as a soft budget: when there are few sessions, groups may be fine-grained; when there are many sessions, merge related workstreams into coarser projects.",
  "Use the provided `groupSummary` to detect over-splitting; a high singleton count is a stronger signal than individually reasonable group labels.",
  "Avoid excessive singleton groups when `totalSessions` is greater than `targetProjectCount`.",
  "Treat existing group assignments as provisional; this is a full scoped rebalance, so you may merge, split, or rewrite groups across the entire snapshot.",
  "Project compression is allowed: when several existing groups are fragments of the same workstream, choose a clearer shared Project name and patch every affected session to that new `group`.",
  "Do not only classify the newest session; improve older scoped sessions when this account's list has drifted.",
  "Do not create one Project per session unless the session is genuinely standalone, newly emerging but likely to recur, or high-priority active work that needs its own entry.",
  "If metadata is insufficient for an important merge/split decision, inspect a small number of ambiguous sessions with the API instead of inventing narrowly isolated groups.",
  "If semantic purity conflicts with scanability, prefer the grouping that keeps the Projects view easier to consume.",
  "Keep genuinely unrelated or high-priority active work separate even if that creates a small group.",
  "Return only a brief plain-text summary of the grouping strategy you applied.",
].join("\n");

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setSortSessionListButtonState(label = DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL, { busy = false } = {}) {
  if (!sortSessionListBtn) return;
  sortSessionListBtn.textContent = label || DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL;
  sortSessionListBtn.disabled = busy;
}

function clipSessionListOrganizerText(value, maxChars = 240) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
    : normalized;
}

function scheduleSortSessionListButtonReset(delayMs = 1600) {
  if (sessionListOrganizerLabelResetTimer) {
    window.clearTimeout(sessionListOrganizerLabelResetTimer);
  }
  sessionListOrganizerLabelResetTimer = window.setTimeout(() => {
    sessionListOrganizerLabelResetTimer = null;
    setSortSessionListButtonState(DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL, { busy: false });
  }, delayMs);
}

function buildSessionListOrganizerSessionMetadata(session) {
  const brief = typeof session?.description === "string"
    ? session.description.trim()
    : "";
  return {
    id: session?.id || "",
    title: clipSessionListOrganizerText(getSessionDisplayName(session), 160),
    brief: clipSessionListOrganizerText(brief, 280),
    existingSpace: typeof session?.space === "string" && session.space.trim()
      ? clipSessionListOrganizerText(session.space, 60)
      : null,
    existingGroup: typeof session?.group === "string" && session.group.trim()
      ? clipSessionListOrganizerText(session.group, 80)
      : null,
    existingSidebarOrder: Number.isInteger(session?.sidebarOrder) && session.sidebarOrder > 0
      ? session.sidebarOrder
      : null,
    pinned: session?.pinned === true,
    tool: clipSessionListOrganizerText(session?.tool || "", 40),
    sourceId: clipSessionListOrganizerText(
      typeof getEffectiveSessionSourceId === "function"
        ? getEffectiveSessionSourceId(session)
        : (session?.sourceId || ""),
      80,
    ),
    sourceCategory: clipSessionListOrganizerText(
      typeof getSessionSourceCategory === "function"
        ? getSessionSourceCategory(session)
        : "",
      40,
    ),
    sourceName: clipSessionListOrganizerText(session?.sourceName || "", 80),
    folder: clipSessionListOrganizerText(session?.folder || "", 180),
    workflowState: clipSessionListOrganizerText(session?.workflowState || "", 40),
    workflowPriority: clipSessionListOrganizerText(session?.workflowPriority || "", 40),
    messageCount: Number.isInteger(session?.messageCount) ? session.messageCount : 0,
    created: clipSessionListOrganizerText(session?.created || "", 40),
    updatedAt: clipSessionListOrganizerText(session?.updatedAt || "", 40),
    lastEventAt: clipSessionListOrganizerText(session?.lastEventAt || "", 40),
  };
}

function buildSessionListOrganizerGroupSummary(sessions, targetProjectCount = 0) {
  const normalizedSessions = Array.isArray(sessions) ? sessions : [];
  const groups = new Map();
  for (const session of normalizedSessions) {
    const rawGroup = typeof session?.existingGroup === "string" && session.existingGroup.trim()
      ? session.existingGroup.trim()
      : "(ungrouped)";
    if (!groups.has(rawGroup)) {
      groups.set(rawGroup, {
        group: rawGroup,
        count: 0,
        examples: [],
      });
    }
    const group = groups.get(rawGroup);
    group.count += 1;
    const title = clipSessionListOrganizerText(session?.title || "", 80);
    if (title && group.examples.length < 3) {
      group.examples.push(title);
    }
  }

  const groupList = [...groups.values()].sort((a, b) => (
    (b.count - a.count)
    || a.group.localeCompare(b.group, undefined, { numeric: true, sensitivity: "base" })
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
      title: group.examples[0] || "",
    })),
  };
}

function getSessionListOrganizerSourceLabel(sourceFilter) {
  return SESSION_LIST_ORGANIZER_SOURCE_LABELS[sourceFilter] || SESSION_LIST_ORGANIZER_SOURCE_LABELS[FILTER_ALL_VALUE];
}

function getSessionListOrganizerTargetProjectCount(totalSessions) {
  if (!Number.isInteger(totalSessions) || totalSessions <= 0) return 0;
  if (totalSessions <= 5) return totalSessions;
  if (totalSessions <= 18) return Math.min(totalSessions, Math.max(4, Math.min(6, Math.round(totalSessions / 3))));
  if (totalSessions <= 40) return Math.min(totalSessions, Math.max(6, Math.min(8, Math.round(totalSessions / 5))));
  return Math.min(totalSessions, Math.max(8, Math.min(10, Math.round(totalSessions / 8))));
}

function getSessionListOrganizerTargetSpaceCount(totalSessions) {
  if (!Number.isInteger(totalSessions) || totalSessions <= 0) return 0;
  if (totalSessions <= 12) return Math.min(2, totalSessions);
  if (totalSessions <= 40) return 3;
  if (totalSessions <= 120) return 4;
  if (totalSessions <= 240) return 5;
  return 6;
}

function getSessionListOrganizerAccountScope() {
  const currentAccount = teamSessionView?.currentAccount && typeof teamSessionView.currentAccount === "object"
    ? teamSessionView.currentAccount
    : {};
  const currentAccountId = typeof currentAccount.id === "string" && currentAccount.id.trim()
    ? currentAccount.id.trim()
    : "owner";
  const currentAccountName = typeof currentAccount.name === "string" && currentAccount.name.trim()
    ? currentAccount.name.trim()
    : (currentAccountId === "owner" ? "Owner" : currentAccountId);

  if (typeof isTeamMemberSessionView === "function" && isTeamMemberSessionView()) {
    return {
      mode: "account",
      accountId: currentAccountId,
      accountLabel: currentAccountName,
      defaultedToCurrentAccount: false,
    };
  }

  if (typeof isAdminAccountFilterAvailable === "function" && isAdminAccountFilterAvailable()) {
    const selectedAccountFilter = typeof activeAccountFilter !== "undefined"
      ? normalizeAccountFilter(activeAccountFilter)
      : FILTER_ALL_VALUE;
    if (
      selectedAccountFilter !== FILTER_ALL_VALUE
      && selectedAccountFilter !== ACCOUNT_FILTER_ADMIN_VALUE
    ) {
      const accountDefinition = typeof getAccountFilterDefinitions === "function"
        ? getAccountFilterDefinitions().find((entry) => entry.value === selectedAccountFilter)
        : null;
      return {
        mode: "account",
        accountId: selectedAccountFilter,
        accountLabel: accountDefinition?.name || selectedAccountFilter,
        defaultedToCurrentAccount: false,
      };
    }
    return {
      mode: "owner",
      accountId: currentAccountId,
      accountLabel: currentAccountName,
      defaultedToCurrentAccount: selectedAccountFilter === FILTER_ALL_VALUE,
    };
  }

  return {
    mode: "owner",
    accountId: currentAccountId,
    accountLabel: currentAccountName,
    defaultedToCurrentAccount: false,
  };
}

function matchesSessionListOrganizerAccountScope(session, accountScope) {
  if (!accountScope || accountScope.mode === "all") return true;
  const sessionAccountId = typeof getSessionAccountId === "function"
    ? getSessionAccountId(session)
    : (typeof session?.userId === "string" ? session.userId.trim() : "");
  if (accountScope.mode === "owner") {
    return !sessionAccountId || sessionAccountId === accountScope.accountId;
  }
  return sessionAccountId === accountScope.accountId;
}

function getSessionListOrganizerScope() {
  const currentSourceFilter = typeof getActiveSourceFilterValue === "function"
    ? normalizeSourceFilter(getActiveSourceFilterValue())
    : normalizeSourceFilter(activeSourceFilter);
  const defaultedToChatUi = currentSourceFilter === FILTER_ALL_VALUE;
  const organizerSourceFilter = defaultedToChatUi ? SESSION_HTTP_SOURCE_FILTER_CHAT_VALUE : currentSourceFilter;
  const accountScope = getSessionListOrganizerAccountScope();
  const scopedSessions = getActiveSessions().filter((session) => (
    matchesSessionListOrganizerAccountScope(session, accountScope)
    && (
      typeof matchesSourceFilter === "function"
        ? matchesSourceFilter(session, organizerSourceFilter)
        : organizerSourceFilter === FILTER_ALL_VALUE
    )
  ));
  const targetProjectCount = getSessionListOrganizerTargetProjectCount(scopedSessions.length);
  const targetSpaceCount = getSessionListOrganizerTargetSpaceCount(scopedSessions.length);
  return {
    currentSourceFilter,
    organizerSourceFilter,
    defaultedToChatUi,
    accountId: accountScope.accountId,
    accountLabel: accountScope.accountLabel,
    defaultedToCurrentAccount: accountScope.defaultedToCurrentAccount,
    sourceLabel: getSessionListOrganizerSourceLabel(organizerSourceFilter),
    targetSpaceCount,
    targetProjectCount,
    targetSessionsPerProject: targetProjectCount > 0
      ? Math.ceil(scopedSessions.length / targetProjectCount)
      : 0,
    sessions: scopedSessions,
  };
}

function buildSessionListOrganizerPayload() {
  const scope = getSessionListOrganizerScope();
  const sessions = scope.sessions.map(buildSessionListOrganizerSessionMetadata).filter((session) => session.id);
  const groupSummary = buildSessionListOrganizerGroupSummary(sessions, scope.targetProjectCount);
  return {
    tool: selectedTool || preferredTool || "codex",
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(selectedEffort ? { effort: selectedEffort } : {}),
    thinking: thinkingEnabled === true,
    scope: {
      currentSourceFilter: scope.currentSourceFilter,
      organizerSourceFilter: scope.organizerSourceFilter,
      sourceLabel: scope.sourceLabel,
      defaultedToChatUi: scope.defaultedToChatUi,
      accountId: scope.accountId,
      accountLabel: scope.accountLabel,
      defaultedToCurrentAccount: scope.defaultedToCurrentAccount,
      targetProjectCount: scope.targetProjectCount,
      targetSessionsPerProject: scope.targetSessionsPerProject,
    },
    groupSummary,
    sessions,
  };
}

function buildSessionListOrganizerTask(input) {
  const normalizedInput = Array.isArray(input)
    ? { sessions: input }
    : (input && typeof input === "object" ? input : {});
  const sessions = Array.isArray(normalizedInput.sessions) ? normalizedInput.sessions : [];
  const scope = normalizedInput.scope && typeof normalizedInput.scope === "object"
    ? normalizedInput.scope
    : {};
  const totalSessions = sessions.length;
  const targetSpaceCount = Number.isInteger(scope.targetSpaceCount) && scope.targetSpaceCount > 0
    ? scope.targetSpaceCount
    : getSessionListOrganizerTargetSpaceCount(totalSessions);
  const targetProjectCount = Number.isInteger(scope.targetProjectCount) && scope.targetProjectCount > 0
    ? scope.targetProjectCount
    : getSessionListOrganizerTargetProjectCount(totalSessions);
  const targetSessionsPerProject = Number.isInteger(scope.targetSessionsPerProject) && scope.targetSessionsPerProject > 0
    ? scope.targetSessionsPerProject
    : (targetProjectCount > 0 ? Math.ceil(totalSessions / targetProjectCount) : 0);
  const groupSummary = normalizedInput.groupSummary && typeof normalizedInput.groupSummary === "object"
    ? normalizedInput.groupSummary
    : buildSessionListOrganizerGroupSummary(sessions, targetProjectCount);
  const payload = {
    generatedAt: new Date().toISOString(),
    totalSessions,
    targetSpaceCount,
    targetProjectCount,
    targetSessionsPerProject,
    scope,
    groupSummary,
    sessions,
  };
  return [
    "Organize only the scoped non-archived RemoteLab sessions included in the provided metadata snapshot.",
    `The snapshot belongs only to account ${scope.accountLabel || scope.accountId || "Owner"}. Treat Space, Project, and sidebar order as account-local metadata and do not inspect or patch another account's sessions.`,
    `Create or reuse roughly ${targetSpaceCount} broad Spaces for ${totalSessions} scoped sessions; this is a soft upper budget, not a target to fill.`,
    "Spaces are durable context boundaries. Projects are concrete workstreams inside a Space. Assign genuinely temporary or ambiguous sessions to the reserved `Loose` Space rather than inventing a weak category.",
    "Use the dominant language of the session titles and current catalog for user-visible Space and Project names; when that language is Chinese, use concise natural Chinese labels.",
    "Choose clearer Projects groups and a better sidebar ordering based on actual workstream similarity, current user consumption, and the target project budget.",
    `Target roughly ${targetProjectCount} Projects groups for ${totalSessions} scoped sessions; this is a soft budget, not an exact quota.`,
    targetSessionsPerProject > 0
      ? `Aim for about ${targetSessionsPerProject} sessions per Project when the workstreams are related enough to merge.`
      : "",
    `Current snapshot has ${groupSummary.totalGroups || 0} existing groups and ${groupSummary.singletonGroups || 0} singleton groups; use this as the main over-splitting signal.`,
    groupSummary.overTarget || (groupSummary.singletonRatio || 0) >= 0.35
      ? "The current grouping is likely over-split. Prioritize merging related singleton or near-duplicate groups before fine-tuning order."
      : "",
    "Treat this as a full scoped rebalance: previous groups are useful hints, not fixed truth, and singleton groups should be merged when they are just feature slices of the same workstream.",
    "If several old groups now read as fragments of one better topic, compress them by assigning a clearer shared `group` name to every included session.",
    scope?.sourceLabel
      ? `The organizer scope is ${scope.sourceLabel}${scope.defaultedToChatUi ? " because All origins is too broad for daily sorting." : "."}`
      : "",
    "Apply changes by calling the RemoteLab API from this machine; do not merely suggest them.",
    "Snapshot fields like `title`, `brief`, `existingSpace`, `existingGroup`, and `existingSidebarOrder` are read-only context.",
    "Do not patch any session that is not present in the `sessions` array below.",
    "When patching a session, send only `space`, `group`, and `sidebarOrder` in the API body.",
    "",
    "<session_list_organizer_input>",
    JSON.stringify(payload, null, 2),
    "</session_list_organizer_input>",
  ].join("\n");
}

async function createSessionListOrganizerRun(payload) {
  const sessionResponse = await fetchJsonOrRedirect("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      folder: typeof window.remotelabGetDefaultSessionFolder === "function"
        ? window.remotelabGetDefaultSessionFolder()
        : "~",
      tool: payload?.tool || "codex",
      name: "sort session list",
      systemPrompt: SESSION_LIST_ORGANIZER_SYSTEM_PROMPT,
      internalRole: SESSION_LIST_ORGANIZER_INTERNAL_ROLE,
    }),
  });
  const organizerSessionId = typeof sessionResponse?.session?.id === "string"
    ? sessionResponse.session.id.trim()
    : "";
  if (!organizerSessionId) {
    throw new Error("Failed to create the hidden session organizer");
  }

  const messageResponse = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(organizerSessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: buildSessionListOrganizerTask(payload || {}),
      ...(payload?.model ? { model: payload.model } : {}),
      ...(payload?.effort ? { effort: payload.effort } : {}),
      ...(payload?.thinking ? { thinking: true } : {}),
    }),
  });

  return {
    session: sessionResponse?.session || null,
    run: messageResponse?.run || null,
  };
}

async function waitForSessionListOrganizerRun(runId) {
  const deadline = Date.now() + SESSION_LIST_ORGANIZER_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await fetchJsonOrRedirect(`/api/runs/${encodeURIComponent(runId)}`, {
      revalidate: false,
    });
    const state = typeof data?.run?.state === "string" ? data.run.state : "";
    if (["completed", "failed", "cancelled"].includes(state)) {
      return data.run || null;
    }
    await sleep(SESSION_LIST_ORGANIZER_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out while sorting the session list");
}


function getSessionRunState(session) {
  return session?.activity?.run?.state === "running" ? "running" : "idle";
}

function hasRenderedEventSnapshot(sessionId) {
  const sameSession = renderedEventState.sessionId === sessionId;
  return sameSession && (
    renderedEventState.eventCount > 0
    || emptyState.parentNode === messagesInner
  );
}

function shouldFetchSessionEventsForRefresh(sessionId, session) {
  const runState = getSessionRunState(session);
  if (runState !== "running") return true;
  if (!hasRenderedEventSnapshot(sessionId)) return true;
  if (renderedEventState.runState !== "running") return true;
  if (renderedEventState.runningBlockExpanded === true) return true;
  const latestSeq = Number.isInteger(session?.latestSeq) ? session.latestSeq : 0;
  return latestSeq > renderedEventState.latestSeq;
}

function getEventRenderPlan(sessionId, events) {
  const normalizedEvents = Array.isArray(events) ? events : [];
  const latestSeq = getLatestEventSeq(normalizedEvents);
  const nextBaseKeys = normalizedEvents.map((event) => getEventRenderBaseKey(event));
  const nextKeys = normalizedEvents.map((event) => getEventRenderKey(event));
  const sameSession = renderedEventState.sessionId === sessionId;
  const hasRenderedSnapshot = sameSession && (
    renderedEventState.eventCount > 0
    || emptyState.parentNode === messagesInner
  );

  if (!sameSession || !hasRenderedSnapshot) {
    return { mode: "reset", events: normalizedEvents };
  }

  if (
    latestSeq < renderedEventState.latestSeq ||
    normalizedEvents.length < renderedEventState.eventCount
  ) {
    return { mode: "reset", events: normalizedEvents };
  }

  if (eventKeyArraysEqual(nextKeys, renderedEventState.eventKeys || [])) {
    return { mode: "noop", events: [] };
  }

  if (
    renderedEventState.runningBlockExpanded === true
    && normalizedEvents.length > 0
    && normalizedEvents.length === renderedEventState.eventCount
    && eventKeyArraysEqual(nextBaseKeys, renderedEventState.eventBaseKeys || [])
  ) {
    const lastEvent = normalizedEvents[normalizedEvents.length - 1];
    if (
      isRunningThinkingBlockEvent(lastEvent)
      && Number.isInteger(lastEvent?.blockEndSeq)
      && lastEvent.blockEndSeq > renderedEventState.latestSeq
    ) {
      return { mode: "refresh_running_block", events: [lastEvent] };
    }
  }

  if (eventKeyPrefixMatches(renderedEventState.eventKeys || [], nextKeys)) {
    const appendedEvents = normalizedEvents.slice((renderedEventState.eventKeys || []).length);
    if (appendedEvents.length > 0) {
      return { mode: "append", events: appendedEvents };
    }
  }

  return { mode: "reset", events: normalizedEvents };
}

function reconcilePendingMessageState(event) {
  if (typeof reconcileComposerPendingSendWithEvent === "function") {
    reconcileComposerPendingSendWithEvent(event);
  }
}

const pendingSessionReviewSyncs = new Map();
let heldSidebarSessionState = null;
const optimisticSessionArchiveMutations = new Map();
let sessionArchiveMutationEpoch = 0;

function normalizeSessionArchiveMutationId(sessionId) {
  return typeof sessionId === "string" && sessionId.trim()
    ? sessionId.trim()
    : "";
}

function getSessionArchiveMutationEpoch() {
  return sessionArchiveMutationEpoch;
}

function isSessionArchiveMutationEpochCurrent(epoch) {
  return epoch === sessionArchiveMutationEpoch;
}

function bumpSessionArchiveMutationEpoch() {
  sessionArchiveMutationEpoch += 1;
  return sessionArchiveMutationEpoch;
}

function beginSessionArchiveOptimisticMutation(sessionId, archived) {
  const normalizedSessionId = normalizeSessionArchiveMutationId(sessionId);
  if (!normalizedSessionId) return null;
  const shouldArchive = archived === true;
  const existing = optimisticSessionArchiveMutations.get(normalizedSessionId) || null;
  const mutation = {
    sessionId: normalizedSessionId,
    archived: shouldArchive,
    archivedAt: shouldArchive
      ? (existing?.archivedAt || new Date().toISOString())
      : "",
    epoch: bumpSessionArchiveMutationEpoch(),
  };
  optimisticSessionArchiveMutations.set(normalizedSessionId, mutation);
  return mutation;
}

function finishSessionArchiveOptimisticMutation(sessionId) {
  const normalizedSessionId = normalizeSessionArchiveMutationId(sessionId);
  if (!normalizedSessionId) return null;
  const existing = optimisticSessionArchiveMutations.get(normalizedSessionId) || null;
  if (!existing) return null;
  optimisticSessionArchiveMutations.delete(normalizedSessionId);
  bumpSessionArchiveMutationEpoch();
  return existing;
}

function getSessionArchiveOptimisticMutation(sessionId) {
  const normalizedSessionId = normalizeSessionArchiveMutationId(sessionId);
  if (!normalizedSessionId) return null;
  return optimisticSessionArchiveMutations.get(normalizedSessionId) || null;
}

function applySessionArchiveOptimisticMutation(session) {
  if (!session?.id) return session;
  const mutation = getSessionArchiveOptimisticMutation(session.id);
  if (!mutation) return session;
  const next = { ...session };
  if (mutation.archived) {
    next.archived = true;
    next.archivedAt = next.archivedAt || mutation.archivedAt || new Date().toISOString();
    delete next.pinned;
    return next;
  }
  delete next.archived;
  delete next.archivedAt;
  return next;
}

function adjustArchivedCountForSessionArchiveOptimisticMutations(
  archivedCount,
  responseSessions = [],
  { listKind = "active" } = {},
) {
  let nextCount = Number.isInteger(archivedCount) && archivedCount >= 0
    ? archivedCount
    : 0;
  if (optimisticSessionArchiveMutations.size === 0) return nextCount;
  const responseIds = new Set(
    (Array.isArray(responseSessions) ? responseSessions : [])
      .map((session) => session?.id)
      .filter(Boolean),
  );
  const isArchivedList = listKind === "archived";
  for (const mutation of optimisticSessionArchiveMutations.values()) {
    const responseHasSession = responseIds.has(mutation.sessionId);
    if (mutation.archived) {
      if ((isArchivedList && !responseHasSession) || (!isArchivedList && responseHasSession)) {
        nextCount += 1;
      }
    } else if ((isArchivedList && responseHasSession) || (!isArchivedList && !responseHasSession)) {
      nextCount = Math.max(0, nextCount - 1);
    }
  }
  return nextCount;
}

function cloneSessionForSidebarHold(session) {
  if (!session || typeof session !== "object") return null;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(session);
    } catch {}
  }
  try {
    return JSON.parse(JSON.stringify(session));
  } catch {
    return { ...session };
  }
}

function getHeldSidebarSessionState(sessionId = currentSessionId) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) return null;
  if (!heldSidebarSessionState || heldSidebarSessionState.sessionId !== normalizedSessionId) {
    return null;
  }
  return heldSidebarSessionState;
}

function getSessionSidebarListSnapshot(session) {
  if (!session?.id || session.id !== currentSessionId) return session;
  const heldState = getHeldSidebarSessionState(session.id);
  return heldState?.snapshot || session;
}

function holdAttachedSessionSidebarState(session) {
  if (!session?.id) return null;
  const existing = getHeldSidebarSessionState(session.id);
  heldSidebarSessionState = {
    sessionId: session.id,
    snapshot: cloneSessionForSidebarHold(session) || { ...session },
    pendingReviewAt: existing?.pendingReviewAt || "",
  };
  return heldSidebarSessionState;
}

function clearHeldSidebarSessionState(sessionId = currentSessionId) {
  const heldState = getHeldSidebarSessionState(sessionId);
  if (!heldState) return null;
  heldSidebarSessionState = null;
  return heldState;
}

function normalizeSessionReviewStamp(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : "";
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? new Date(numeric).toISOString() : "";
  }
  const time = new Date(trimmed).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function getSessionReviewStampTime(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionReviewStamp(session) {
  return normalizeSessionReviewStamp(session?.lastEventAt)
    || normalizeSessionReviewStamp(session?.updatedAt)
    || normalizeSessionReviewStamp(session?.created)
    || "";
}

function getEffectiveSessionReviewedAt(session) {
  const candidates = [
    normalizeSessionReviewStamp(session?.lastReviewedAt),
    normalizeSessionReviewStamp(session?.localReviewedAt),
    normalizeSessionReviewStamp(session?.reviewBaselineAt),
  ].filter(Boolean);
  let best = "";
  let bestTime = 0;
  for (const candidate of candidates) {
    const time = getSessionReviewStampTime(candidate);
    if (time > bestTime) {
      best = candidate;
      bestTime = time;
    }
  }
  return best;
}

function applySessionReviewedStampLocally(session, stamp, { render = false } = {}) {
  if (!session?.id) return "";
  const normalizedStamp = normalizeSessionReviewStamp(stamp);
  if (!normalizedStamp) return "";
  if (getSessionReviewStampTime(normalizedStamp) <= getSessionReviewStampTime(getEffectiveSessionReviewedAt(session))) {
    return getEffectiveSessionReviewedAt(session);
  }
  const stored = typeof setLocalSessionReviewedAt === "function"
    ? setLocalSessionReviewedAt(session.id, normalizedStamp)
    : normalizedStamp;
  session.localReviewedAt = stored || normalizedStamp;
  if (render) {
    renderSessionList();
  }
  return session.localReviewedAt;
}

function rememberSessionReviewedLocally(session, { render = false } = {}) {
  if (!session?.id) return "";
  const stamp = getSessionReviewStamp(session);
  return applySessionReviewedStampLocally(session, stamp, { render });
}

function stageSessionReviewedForAttachedSession(session) {
  if (!session?.id) return "";
  const stamp = getSessionReviewStamp(session);
  if (!stamp) return "";
  const heldState = holdAttachedSessionSidebarState(session);
  if (!heldState) return "";
  if (getSessionReviewStampTime(stamp) > getSessionReviewStampTime(heldState.pendingReviewAt)) {
    heldState.pendingReviewAt = stamp;
  }
  return heldState.pendingReviewAt;
}

async function syncSessionReviewedToServer(session, stampOverride = "") {
  if (!session?.id || visitorMode) return session;
  const stamp = normalizeSessionReviewStamp(stampOverride) || getSessionReviewStamp(session);
  if (!stamp) return session;
  if (getSessionReviewStampTime(stamp) <= getSessionReviewStampTime(normalizeSessionReviewStamp(session?.lastReviewedAt))) {
    return session;
  }
  const currentPending = pendingSessionReviewSyncs.get(session.id);
  if (getSessionReviewStampTime(currentPending) >= getSessionReviewStampTime(stamp)) {
    return session;
  }
  pendingSessionReviewSyncs.set(session.id, stamp);
  try {
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastReviewedAt: stamp }),
    });
    return upsertSession(data.session) || data.session || session;
  } finally {
    if (pendingSessionReviewSyncs.get(session.id) === stamp) {
      pendingSessionReviewSyncs.delete(session.id);
    }
  }
}

function settleAttachedSessionSidebarState({
  sessionId = currentSessionId,
  sync = true,
  render = true,
} = {}) {
  const heldState = clearHeldSidebarSessionState(sessionId);
  const liveSession = heldState?.sessionId
    ? (typeof getChatStoreSession === "function"
      ? getChatStoreSession(heldState.sessionId)
      : (sessions.find((session) => session.id === heldState.sessionId) || null))
    : null;
  const session = liveSession || heldState?.snapshot || null;
  if (!heldState) {
    if (render) renderSessionList();
    return Promise.resolve(session);
  }

  const stamp = normalizeSessionReviewStamp(heldState.pendingReviewAt) || getSessionReviewStamp(session);
  if (stamp) {
    applySessionReviewedStampLocally(session, stamp, { render });
  } else if (render) {
    renderSessionList();
  }
  if (!stamp || !sync) {
    return Promise.resolve(session);
  }
  return syncSessionReviewedToServer(session, stamp);
}

function markSessionReviewed(session, { sync = false, render = true } = {}) {
  const stamp = rememberSessionReviewedLocally(session, { render });
  if (!stamp || !sync) {
    return Promise.resolve(session);
  }
  return syncSessionReviewedToServer(session);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const flushHeldSidebarSessionState = () => {
    Promise.resolve(settleAttachedSessionSidebarState({
      sessionId: currentSessionId,
      sync: false,
      render: false,
    })).catch(() => {});
  };
  window.addEventListener("pagehide", flushHeldSidebarSessionState);
  window.addEventListener("beforeunload", flushHeldSidebarSessionState);
}

function normalizeSessionRecord(session, previous = null) {
  const queueCount = Number.isInteger(session?.activity?.queue?.count)
    ? session.activity.queue.count
    : 0;
  const sessionWithOptimisticArchive = typeof applySessionArchiveOptimisticMutation === "function"
    ? applySessionArchiveOptimisticMutation(session)
    : session;
  const normalized = { ...sessionWithOptimisticArchive };
  if (!Object.prototype.hasOwnProperty.call(session || {}, "queuedMessages")) {
    if (queueCount > 0 && Array.isArray(previous?.queuedMessages)) {
      normalized.queuedMessages = previous.queuedMessages;
    } else {
      delete normalized.queuedMessages;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "model")) {
    if (typeof previous?.model === "string") {
      normalized.model = previous.model;
    } else {
      delete normalized.model;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "effort")) {
    if (typeof previous?.effort === "string") {
      normalized.effort = previous.effort;
    } else {
      delete normalized.effort;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "thinking")) {
    if (previous?.thinking === true) {
      normalized.thinking = true;
    } else {
      delete normalized.thinking;
    }
  }
  const localReviewedAt = normalizeSessionReviewStamp(
    normalized.localReviewedAt
    || previous?.localReviewedAt
    || (typeof getLocalSessionReviewedAt === "function" ? getLocalSessionReviewedAt(normalized.id) : ""),
  );
  if (localReviewedAt) {
    normalized.localReviewedAt = localReviewedAt;
  } else {
    delete normalized.localReviewedAt;
  }
  const reviewBaselineAt = normalizeSessionReviewStamp(
    normalized.reviewBaselineAt
    || previous?.reviewBaselineAt
    || (typeof getSessionReviewBaselineAt === "function" ? getSessionReviewBaselineAt() : ""),
  );
  if (reviewBaselineAt) {
    normalized.reviewBaselineAt = reviewBaselineAt;
  } else {
    delete normalized.reviewBaselineAt;
  }
  return normalized;
}

function upsertSession(session) {
  if (!session?.id) return null;
  const previous = typeof getChatStoreSession === "function"
    ? getChatStoreSession(session.id)
    : sessions.find((entry) => entry.id === session.id);
  const normalized = normalizeSessionRecord(session, previous);
  if (typeof upsertChatSessionState === "function") {
    upsertChatSessionState(normalized, {
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    const index = sessions.findIndex((entry) => entry.id === session.id);
    if (index === -1) {
      sessions.push(normalized);
    } else {
      sessions[index] = normalized;
    }
    sortSessionsInPlace();
  }
  refreshAppCatalog();
  return typeof getChatStoreSession === "function"
    ? getChatStoreSession(session.id)
    : normalized;
}


async function fetchSessionSidebar(sessionId, { forceFresh = false } = {}) {
  const url = getSessionSidebarUrl(sessionId);
  const archiveMutationEpoch = typeof getSessionArchiveMutationEpoch === "function"
    ? getSessionArchiveMutationEpoch()
    : 0;
  const data = await fetchJsonOrRedirect(url, buildSessionRefreshRequestOptions(forceFresh));
  if (
    typeof isSessionArchiveMutationEpochCurrent === "function"
    && !isSessionArchiveMutationEpochCurrent(archiveMutationEpoch)
  ) {
    return typeof getChatStoreSession === "function"
      ? getChatStoreSession(sessionId)
      : (sessions.find((session) => session.id === sessionId) || null);
  }
  return upsertSession(data.session);
}

async function fetchArchivedSessions({ forceFresh = false } = {}) {
  if (visitorMode) return [];
  if (archivedSessionsRefreshPromise) {
    return archivedSessionsRefreshPromise;
  }
  if (!archivedSessionsLoaded && archivedSessionCount === 0) {
    if (typeof replaceChatState === "function") {
      replaceChatState({
        archivedSessionsLoaded: true,
        archivedSessionsLoading: false,
      });
    } else {
      archivedSessionsLoaded = true;
      archivedSessionsLoading = false;
    }
    lastArchivedSessionsRefreshAt = Date.now();
    renderSessionList();
    return [];
  }

  if (typeof setChatArchivedSessionsLoading === "function") {
    setChatArchivedSessionsLoading(true);
  } else {
    archivedSessionsLoading = true;
  }
  renderSessionList();
  const request = (async () => {
    try {
      const archiveMutationEpoch = typeof getSessionArchiveMutationEpoch === "function"
        ? getSessionArchiveMutationEpoch()
        : 0;
      const data = await fetchJsonOrRedirect(
        ARCHIVED_SESSION_LIST_URL,
        buildSessionRefreshRequestOptions(forceFresh),
      );
      if (
        typeof isSessionArchiveMutationEpochCurrent === "function"
        && !isSessionArchiveMutationEpochCurrent(archiveMutationEpoch)
      ) {
        if (typeof setChatArchivedSessionsLoading === "function") {
          setChatArchivedSessionsLoading(false);
        } else {
          archivedSessionsLoading = false;
        }
        renderSessionList();
        return typeof getArchivedSessions === "function"
          ? getArchivedSessions()
          : sessions.filter((session) => session?.archived === true);
      }
      const archivedSessionsPayload = typeof filterSessionsForTeamSessionView === "function"
        ? filterSessionsForTeamSessionView(data.sessions || [])
        : (data.sessions || []);
      const nextArchivedSessions = applyArchivedSessionListState(archivedSessionsPayload, {
        archivedCount: typeof isTeamMemberSessionView === "function" && isTeamMemberSessionView()
          ? archivedSessionsPayload.length
          : (typeof adjustArchivedCountForSessionArchiveOptimisticMutations === "function"
          ? adjustArchivedCountForSessionArchiveOptimisticMutations(
            Number.isInteger(data.archivedCount)
              ? data.archivedCount
              : (Array.isArray(data.sessions) ? data.sessions.length : 0),
            archivedSessionsPayload,
            { listKind: "archived" },
          )
          : (Number.isInteger(data.archivedCount)
            ? data.archivedCount
            : (Array.isArray(data.sessions) ? data.sessions.length : 0))),
      });
      lastArchivedSessionsRefreshAt = Date.now();
      return nextArchivedSessions;
    } catch (error) {
      if (typeof setChatArchivedSessionsLoading === "function") {
        setChatArchivedSessionsLoading(false);
      } else {
        archivedSessionsLoading = false;
      }
      renderSessionList();
      throw error;
    } finally {
      archivedSessionsRefreshPromise = null;
    }
  })();
  archivedSessionsRefreshPromise = request;
  return request;
}

async function updateSessionRecord(sessionId, payload = {}) {
  const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (data.session) {
    const session = upsertSession(data.session) || data.session;
    renderSessionList();
    if (currentSessionId === sessionId) {
      applyAttachedSessionState(sessionId, session);
    } else if (typeof renderSettingsSessionPresentationPanel === "function") {
      renderSettingsSessionPresentationPanel();
    }
    return session;
  }
  if (currentSessionId === sessionId) {
    return refreshCurrentSession();
  }
  return refreshSidebarSession(sessionId);
}

async function fetchSessionsList({ forceFresh = false } = {}) {
  if (visitorMode) return [];
  const archiveMutationEpoch = typeof getSessionArchiveMutationEpoch === "function"
    ? getSessionArchiveMutationEpoch()
    : 0;
  const data = await fetchJsonOrRedirect(
    SESSION_LIST_URL,
    buildSessionRefreshRequestOptions(forceFresh),
  );
  if (
    typeof isSessionArchiveMutationEpochCurrent === "function"
    && !isSessionArchiveMutationEpochCurrent(archiveMutationEpoch)
  ) {
    return sessions;
  }
  const sessionsPayload = data.sessions || [];
  applySessionListState(data.sessions || [], {
    archivedCount: typeof adjustArchivedCountForSessionArchiveOptimisticMutations === "function"
      ? adjustArchivedCountForSessionArchiveOptimisticMutations(
        Number.isInteger(data.archivedCount) ? data.archivedCount : 0,
        sessionsPayload,
        { listKind: "active" },
      )
      : (Number.isInteger(data.archivedCount) ? data.archivedCount : 0),
  });
  lastSessionsListRefreshAt = Date.now();
  if (typeof renderSettingsSessionPresentationPanel === "function") {
    renderSettingsSessionPresentationPanel();
  }
  return sessions;
}

async function restoreOwnerBootstrapSessions() {
  if (visitorMode) return null;
  const data = await fetchJsonOrRedirect('/api/bootstrap/owner-sessions/restore', {
    method: 'POST',
  });
  await fetchSessionsList({ forceFresh: true });
  const welcomeSessionId = typeof data?.welcomeSessionId === 'string'
    ? data.welcomeSessionId.trim()
    : '';
  if (welcomeSessionId) {
    const welcomeSession = findClientSessionRecord(welcomeSessionId);
    if (welcomeSession) {
      applyNavigationState({ sessionId: welcomeSessionId, tab: getActiveSidebarTabValue() });
      attachSession(welcomeSessionId, welcomeSession);
      return data;
    }
  }
  restoreOwnerSessionSelection();
  return data;
}

async function organizeSessionListWithAgent({ closeSidebar = false } = {}) {
  const allowOrganize = typeof canOrganizeSessionList === "function"
    ? canOrganizeSessionList()
    : !visitorMode;
  if (visitorMode || !allowOrganize) return false;
  if (sessionListOrganizerInFlight) return sessionListOrganizerInFlight;

  const payload = buildSessionListOrganizerPayload();
  if (!Array.isArray(payload.sessions) || payload.sessions.length === 0) {
    setSortSessionListButtonState("Nothing to sort", { busy: false });
    scheduleSortSessionListButtonReset();
    return false;
  }

  const sortScopeLabel = [payload?.scope?.sourceLabel, payload?.scope?.accountLabel]
    .filter(Boolean)
    .join(" · ") || "sessions";
  if (sessionListOrganizerLabelResetTimer) {
    window.clearTimeout(sessionListOrganizerLabelResetTimer);
    sessionListOrganizerLabelResetTimer = null;
  }
  setSortSessionListButtonState(`Sorting ${sortScopeLabel}…`, { busy: true });

  const request = (async () => {
    try {
      const data = await createSessionListOrganizerRun(payload);
      const runId = typeof data?.run?.id === "string" ? data.run.id.trim() : "";
      if (runId) {
        const run = await waitForSessionListOrganizerRun(runId);
        if (run?.state !== "completed") {
          throw new Error(run?.failureReason || `Sort list ${run?.state || "failed"}`);
        }
      } else {
        throw new Error("Sort list did not start a run");
      }
      await fetchSessionsList();
      if (closeSidebar && !isDesktop) {
        closeSidebarFn();
      }
      setSortSessionListButtonState(`Sorted ${sortScopeLabel}`, { busy: false });
      return true;
    } catch (error) {
      console.warn("[sessions] Failed to organize the session list:", error.message);
      setSortSessionListButtonState("Sort failed", { busy: false });
      return false;
    } finally {
      sessionListOrganizerInFlight = null;
      scheduleSortSessionListButtonReset();
    }
  })();

  sessionListOrganizerInFlight = request;
  return request;
}

function applyAttachedSessionState(id, session) {
  const attachedSessionRenderState = getAttachedSessionRenderState();
  const nextSignature = getComparableAttachedSessionStateSignature(session || null);
  const shouldRefreshUi = attachedSessionRenderState.sessionId !== id
    || attachedSessionRenderState.signature !== nextSignature;
  if (typeof setChatCurrentSession === "function") {
    setChatCurrentSession(id, { hasAttachedSession: true });
  } else {
    currentSessionId = id;
    hasAttachedSession = true;
  }
  if (!shouldRefreshUi) {
    syncBrowserState();
    syncForkButton();
    syncShareButton();
    return false;
  }
  currentTokens = 0;
  contextTokens.style.display = "none";
  compactBtn.style.display = "none";
  dropToolsBtn.style.display = "none";

  const displayName = getSessionDisplayName(session);
  if (typeof renderHeaderSessionTitle === "function") {
    renderHeaderSessionTitle(displayName);
  } else {
    headerTitle.textContent = displayName;
  }
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) {
    const titleSuffix = getShareSnapshotViewValue("titleSuffix", "Shared Snapshot");
    document.title = `${displayName} · ${titleSuffix}`;
  }
  if (typeof reconcileComposerPendingSendWithSession === "function") {
    reconcileComposerPendingSendWithSession(session);
  }
  updateStatus("connected", session);
  if (typeof renderQueuedMessagePanel === "function") {
    renderQueuedMessagePanel(session);
  }

  const effectiveSessionTool = session?.tool === "micro-agent" ? "codex" : session?.tool;
  if (effectiveSessionTool) {
    const availableTools = typeof allToolsList !== "undefined" && Array.isArray(allToolsList)
      ? allToolsList
      : (Array.isArray(toolsList) ? toolsList : []);
    const toolAvailable = availableTools.some((tool) => tool.id === effectiveSessionTool);
    if (toolAvailable || availableTools.length === 0) {
      if (toolAvailable && typeof refreshPrimaryToolPicker === "function") {
        refreshPrimaryToolPicker({ keepToolIds: [effectiveSessionTool], selectedValue: effectiveSessionTool });
      }
      inlineToolSelect.value = effectiveSessionTool;
      selectedTool = effectiveSessionTool;
    }
    if (toolAvailable) {
      Promise.resolve(loadModelsForCurrentTool()).catch(() => {});
    }
  }

  restoreDraft();
  renderSessionList();
  if (typeof renderSettingsSessionPresentationPanel === "function") {
    renderSettingsSessionPresentationPanel();
  }
  syncBrowserState();
  syncForkButton();
  syncShareButton();
  attachedSessionRenderState.sessionId = id;
  attachedSessionRenderState.signature = nextSignature;
  return true;
}

function getAttachedSessionRenderState() {
  if (!(globalThis.__attachedSessionRenderState && typeof globalThis.__attachedSessionRenderState === "object")) {
    globalThis.__attachedSessionRenderState = {
      sessionId: null,
      signature: "",
    };
  }
  return globalThis.__attachedSessionRenderState;
}

function resetAttachedSessionRenderState() {
  const attachedSessionRenderState = getAttachedSessionRenderState();
  attachedSessionRenderState.sessionId = null;
  attachedSessionRenderState.signature = "";
}

function buildComparableSessionState(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => buildComparableSessionState(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const nextValue = buildComparableSessionState(value[key]);
    if (typeof nextValue !== "undefined") {
      normalized[key] = nextValue;
    }
  }
  return normalized;
}

function getComparableSessionStateSignature(value) {
  return JSON.stringify(buildComparableSessionState(value));
}

function getComparableAttachedSessionStateSignature(session) {
  if (!session || typeof session !== "object") {
    return getComparableSessionStateSignature(session);
  }
  return getComparableSessionStateSignature({
    id: session.id || null,
    name: session.name || "",
    tool: session.tool || "",
    status: session.status || "",
    archived: session.archived === true,
    activity: session.activity || null,
    queuedMessages: Array.isArray(session.queuedMessages) ? session.queuedMessages : null,
    model: typeof session.model === "string" ? session.model : null,
    effort: typeof session.effort === "string" ? session.effort : null,
    thinking: session.thinking === true ? true : null,
  });
}

async function fetchSessionState(sessionId, { forceFresh = false } = {}) {
  if (isShareSnapshotReadOnlyMode()) {
    const snapshotSession = buildShareSnapshotSessionRecord();
    if (!snapshotSession || snapshotSession.id !== sessionId) {
      throw new Error("Session not found");
    }
    const normalized = upsertSession(snapshotSession);
    if (normalized && currentSessionId === sessionId) {
      applyAttachedSessionState(sessionId, normalized);
    }
    lastCurrentSessionRefreshAt = Date.now();
    lastCurrentSessionRefreshSessionId = sessionId;
    return normalized;
  }
  const archiveMutationEpoch = typeof getSessionArchiveMutationEpoch === "function"
    ? getSessionArchiveMutationEpoch()
    : 0;
  const data = await fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    buildSessionRefreshRequestOptions(forceFresh),
  );
  if (
    typeof isSessionArchiveMutationEpochCurrent === "function"
    && !isSessionArchiveMutationEpochCurrent(archiveMutationEpoch)
  ) {
    return typeof getChatStoreSession === "function"
      ? getChatStoreSession(sessionId)
      : (sessions.find((entry) => entry.id === sessionId) || null);
  }
  const previous = typeof getChatStoreSession === "function"
    ? getChatStoreSession(sessionId)
    : (sessions.find((entry) => entry.id === sessionId) || null);
  const nextSession = normalizeSessionRecord(data.session, previous);
  const sessionChanged = !previous
    || getComparableSessionStateSignature(previous) !== getComparableSessionStateSignature(nextSession);
  const normalized = sessionChanged
    ? (upsertSession(nextSession) || nextSession)
    : previous;
  if (normalized && currentSessionId === sessionId) {
    stageSessionReviewedForAttachedSession(normalized);
    applyAttachedSessionState(sessionId, normalized);
  }
  lastCurrentSessionRefreshAt = Date.now();
  lastCurrentSessionRefreshSessionId = sessionId;
  return normalized;
}

function captureSessionMessageViewport(reason = "session-render") {
  const viewportController = window.RemoteLabTranscriptViewport;
  if (typeof viewportController?.capture === "function") {
    return viewportController.capture({ reason });
  }
  const hadRenderedMessages =
    messagesInner.children.length > 0 && emptyState.parentNode !== messagesInner;
  return {
    followBottom:
      !hadRenderedMessages
      || messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120,
    scrollTop: messagesEl.scrollTop || 0,
    anchor: null,
  };
}

function restoreSessionMessageViewport(snapshot, reason = "session-render") {
  if (!snapshot) return;
  const viewportController = window.RemoteLabTranscriptViewport;
  if (typeof viewportController?.restore === "function") {
    viewportController.restore(snapshot, { reason });
    return;
  }
  if (snapshot.followBottom) {
    scrollToBottom();
    return;
  }
  messagesEl.scrollTop = Math.max(0, Number(snapshot.scrollTop) || 0);
}

function applySessionViewportAfterRender({
  sessionId,
  viewportIntent,
  snapshot,
  reason,
} = {}) {
  if (shouldOpenCurrentSessionFromTop({ sessionId, viewportIntent })) {
    scrollCurrentSessionViewportToTop();
    return;
  }
  if (normalizeSessionViewportIntent(viewportIntent) === "session_entry") {
    scrollToBottom();
    return;
  }
  restoreSessionMessageViewport(snapshot, reason);
}

async function fetchSessionEvents(
  sessionId,
  { runState = "idle", viewportIntent = "preserve", forceFresh = false } = {},
) {
  const normalizedViewportIntent = normalizeSessionViewportIntent(viewportIntent);
  const data = isShareSnapshotReadOnlyMode()
    ? { events: getShareSnapshotDisplayEvents() }
    : await fetchJsonOrRedirect(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?filter=visible`,
      buildSessionRefreshRequestOptions(forceFresh),
    );
  const events = data.events || [];
  if (currentSessionId !== sessionId) return events;
  const renderPlan = getEventRenderPlan(sessionId, events);
  const viewportSnapshot = captureSessionMessageViewport(
    `session-render:${renderPlan.mode}`,
  );

  if (renderPlan.mode === "refresh_running_block") {
    const [runningEvent] = renderPlan.events;
    if (
      runningEvent
      && typeof refreshExpandedRunningThinkingBlock === "function"
      && refreshExpandedRunningThinkingBlock(sessionId, runningEvent)
    ) {
      updateRenderedEventState(sessionId, events, { runState });
      return renderPlan.events;
    }
  }

  if (renderPlan.mode === "reset") {
    const preserveRunningBlockExpanded =
      renderedEventState.sessionId === sessionId
      && renderedEventState.runState === "running"
        ? renderedEventState.runningBlockExpanded === true
        : null;
    clearMessages({ preserveRunningBlockExpanded });
    if (events.length === 0) {
      showEmpty();
    }
    for (const event of events) {
      reconcilePendingMessageState(event);
      renderEvent(event, false);
    }
    if (messagesInner.children.length === 0) {
      showEmpty();
    }
    updateRenderedEventState(sessionId, events, { runState });
    applySessionViewportAfterRender({
      sessionId,
      viewportIntent: normalizedViewportIntent,
      snapshot: viewportSnapshot,
      reason: "session-render:reset",
    });
    return events;
  }

  if (renderPlan.mode === "append") {
    for (const event of renderPlan.events) {
      reconcilePendingMessageState(event);
      renderEvent(event, false);
    }
    updateRenderedEventState(sessionId, events, { runState });
    applySessionViewportAfterRender({
      sessionId,
      viewportIntent: normalizedViewportIntent,
      snapshot: viewportSnapshot,
      reason: "session-render:append",
    });
    return renderPlan.events;
  }

  updateRenderedEventState(sessionId, events, { runState });
  return events;
}

async function runCurrentSessionRefresh(
  sessionId,
  {
    viewportIntent = hasAttachedSession ? "preserve" : "session_entry",
    forceFresh = false,
  } = {},
) {
  const session = await fetchSessionState(sessionId, { forceFresh });
  if (currentSessionId !== sessionId) return session;
  const runState = getSessionRunState(session);
  if (shouldFetchSessionEventsForRefresh(sessionId, session)) {
    await fetchSessionEvents(sessionId, { runState, viewportIntent, forceFresh });
    return session;
  }
  renderedEventState.sessionId = sessionId;
  renderedEventState.runState = runState;
  return session;
}

async function refreshCurrentSession(
  {
    viewportIntent = hasAttachedSession ? "preserve" : "session_entry",
    forceFresh = false,
  } = {},
) {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  const requestOptions = mergeSessionRefreshOptions(
    { forceFresh: false, viewportIntent: hasAttachedSession ? "preserve" : "session_entry" },
    { forceFresh, viewportIntent },
  );
  if (currentSessionRefreshPromise) {
    pendingCurrentSessionRefresh = true;
    pendingCurrentSessionRefreshOptions = mergeSessionRefreshOptions(
      pendingCurrentSessionRefreshOptions || requestOptions,
      requestOptions,
    );
    return currentSessionRefreshPromise;
  }
  currentSessionRefreshPromise = (async () => {
    try {
      return await runCurrentSessionRefresh(sessionId, requestOptions);
    } finally {
      currentSessionRefreshPromise = null;
      if (pendingCurrentSessionRefresh) {
        const pendingOptions = pendingCurrentSessionRefreshOptions || requestOptions;
        pendingCurrentSessionRefresh = false;
        pendingCurrentSessionRefreshOptions = null;
        refreshCurrentSession(pendingOptions).catch(() => {});
      }
    }
  })();
  return currentSessionRefreshPromise;
}

async function refreshSidebarSession(sessionId, { forceFresh = false } = {}) {
  if (!sessionId || visitorMode) return null;
  if (sessionId === currentSessionId) {
    return refreshCurrentSession({ forceFresh });
  }
  if (sidebarSessionRefreshPromises.has(sessionId)) {
    pendingSidebarSessionRefreshes.add(sessionId);
    return sidebarSessionRefreshPromises.get(sessionId);
  }
  const request = (async () => {
    try {
      const session = await fetchSessionSidebar(sessionId, { forceFresh });
      if (session) {
        renderSessionList();
      }
      return session;
    } catch (error) {
      if (error?.message === "Session not found") {
        const nextSessions = sessions.filter((session) => session.id !== sessionId);
        if (nextSessions.length !== sessions.length) {
          if (typeof removeChatSessionState === "function") {
            removeChatSessionState(sessionId, {
              compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
            });
          } else {
            sessions = nextSessions;
          }
          refreshAppCatalog();
          renderSessionList();
        }
        return null;
      }
      throw error;
    } finally {
      sidebarSessionRefreshPromises.delete(sessionId);
      if (pendingSidebarSessionRefreshes.delete(sessionId)) {
        refreshSidebarSession(sessionId, { forceFresh }).catch(() => {});
      }
    }
  })();
  sidebarSessionRefreshPromises.set(sessionId, request);
  return request;
}

async function refreshRealtimeViews({
  viewportIntent = "preserve",
  forceFresh = false,
  refreshMode = "full",
} = {}) {
  if (visitorMode) {
    if (currentSessionId) {
      await refreshCurrentSession({ viewportIntent, forceFresh }).catch(() => {});
    }
    return;
  }

  const useForegroundPlan = refreshMode === "foreground";
  const shouldRefreshSessionsList = useForegroundPlan
    ? shouldRefreshForegroundSessionList({ forceFresh })
    : true;
  if (shouldRefreshSessionsList) {
    await fetchSessionsList({ forceFresh }).catch(() => {});
  }
  if (pendingNavigationState) {
    restoreOwnerSessionSelection();
  }
  const shouldRefreshCurrent = useForegroundPlan
    ? shouldRefreshForegroundCurrentSession({ forceFresh })
    : Boolean(currentSessionId);
  if (currentSessionId && shouldRefreshCurrent) {
    await refreshCurrentSession({ viewportIntent, forceFresh }).catch(() => {});
  }
  const shouldRefreshArchived = useForegroundPlan
    ? shouldRefreshForegroundArchivedSessions({
      forceFresh,
      refreshedSessionsList: shouldRefreshSessionsList,
    })
    : (typeof archivedSessionsLoaded !== "undefined" && archivedSessionsLoaded);
  if (shouldRefreshArchived) {
    await fetchArchivedSessions({ forceFresh }).catch(() => {});
  }
}

function startParallelCurrentSessionBootstrap() {
  if (
    visitorMode
    || !currentSessionId
    || (typeof isTeamMemberSessionView === "function" && isTeamMemberSessionView())
  ) return;
  refreshCurrentSession({ viewportIntent: "session_entry" }).catch((error) => {
    if (error?.message === "Session not found") return;
    console.warn(
      "[sessions] Failed to bootstrap the current session in parallel:",
      error?.message || error,
    );
  });
}

async function bootstrapViaHttp({ deferOwnerRestore = false } = {}) {
  if (visitorMode && visitorSessionId) {
    if (typeof setChatCurrentSession === "function") {
      setChatCurrentSession(visitorSessionId, { hasAttachedSession: false });
    } else {
      currentSessionId = visitorSessionId;
    }
    attachSession(visitorSessionId, { id: visitorSessionId, name: "Session", status: "idle" });
    await refreshCurrentSession();
    return;
  }
  if (deferOwnerRestore) {
    startParallelCurrentSessionBootstrap();
  }
  await fetchSessionsList();
  if (typeof isTeamMemberSessionView === "function" && isTeamMemberSessionView()) {
    await fetchArchivedSessions();
  }
  if (!deferOwnerRestore) {
    restoreOwnerSessionSelection();
  }
}

async function bootstrapShareSnapshotView() {
  const session = buildShareSnapshotSessionRecord();
  if (!session) {
    showEmpty();
    return null;
  }
  const normalizedSession = normalizeSessionRecord(
    session,
    typeof getChatStoreSession === "function"
      ? getChatStoreSession(session.id)
      : (sessions.find((entry) => entry.id === session.id) || null),
  );
  if (typeof replaceChatState === "function") {
    replaceChatState({
      sessions: [normalizedSession],
      hasLoadedSessions: true,
      archivedSessionCount: 0,
      archivedSessionsLoaded: false,
      archivedSessionsLoading: false,
      currentSessionId: session.id,
      hasAttachedSession: false,
    }, {
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    sessions = [normalizedSession];
    hasLoadedSessions = true;
    archivedSessionCount = 0;
    archivedSessionsLoaded = false;
    currentSessionId = session.id;
  }
  visitorSessionId = session.id;
  attachSession(session.id, normalizedSession);
  return normalizedSession;
}

async function setupPushNotifications() {
  const ownerPushFeaturesEnabled = typeof shouldEnableOwnerPushFeatures === "function"
    ? shouldEnableOwnerPushFeatures()
    : !visitorMode;
  if (!ownerPushFeaturesEnabled) return;
  if (!("PushManager" in window)) return;
  try {
    const persistSubscription = async (subscription) => {
      const payload = subscription?.toJSON ? subscription.toJSON() : subscription;
      if (!payload?.endpoint) return;
      const subscribeUrl = typeof window.remotelabResolveProductPath === "function"
        ? window.remotelabResolveProductPath("/api/push/subscribe")
        : "/api/push/subscribe";
      await fetch(subscribeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    };
    const reg = await ensureServiceWorkerRegistration();
    if (!reg) return;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await persistSubscription(existing);
      return;
    }
    const vapidPublicKeyUrl = typeof window.remotelabResolveProductPath === "function"
      ? window.remotelabResolveProductPath("/api/push/vapid-public-key")
      : "/api/push/vapid-public-key";
    const res = await fetch(vapidPublicKeyUrl);
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await persistSubscription(sub);
    console.log("[push] Subscribed to web push");
  } catch (err) {
    console.warn("[push] Setup failed:", err.message);
  }
}

async function ensureServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const serviceWorkerUrl = typeof window.remotelabResolveProductPath === "function"
      ? window.remotelabResolveProductPath(`/sw.js?v=${encodeURIComponent(buildAssetVersion)}`)
      : `/sw.js?v=${encodeURIComponent(buildAssetVersion)}`;
    const reg = await navigator.serviceWorker.register(
      serviceWorkerUrl,
      { updateViaCache: "none" },
    );
    await reg.update().catch(() => {});
    reg.installing?.postMessage({ type: "remotelab:clear-caches" });
    reg.waiting?.postMessage({ type: "remotelab:clear-caches" });
    reg.active?.postMessage({ type: "remotelab:clear-caches" });
    await navigator.serviceWorker.ready.catch(() => {});
    return reg;
  } catch (err) {
    console.warn("[sw] Setup failed:", err.message);
    return null;
  }
}
