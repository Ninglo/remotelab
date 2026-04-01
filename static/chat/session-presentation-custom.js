"use strict";

(function attachRemoteLabSessionPresentationCustom(root) {
  const GROUP_ORDER = ["needs-user", "active", "done-updated", "closed"];
  const PRIMARY_STATE_ORDER = {
    waiting_user: 0,
    failed: 1,
    active: 2,
    done: 3,
    parked: 4,
  };
  const LABELS = {
    groups: {
      "needs-user": "Needs you now",
      active: "In progress",
      "done-updated": "Done, new updates",
      closed: "Ended",
    },
    primary: {
      active: "In progress",
      waiting_user: "Needs you",
      done: "Done",
      parked: "Parked",
      failed: "Needs repair",
    },
    flag: {
      running: "Running",
      queued: "Queued",
      unread: "New updates",
      pinned: "Pinned",
    },
    folderFallback: "General",
    messages: "{count} msgs",
  };
  const FLAG_ORDER = ["unread", "running", "queued", "pinned"];

  const originalRenderSessionList =
    typeof root.renderSessionList === "function" ? root.renderSessionList : null;
  let enabled = false;

  function getStateModel() {
    return root.RemoteLabSessionStateModel || null;
  }

  function normalizeActivity(session) {
    const model = getStateModel();
    if (model && typeof model.normalizeSessionActivity === "function") {
      return model.normalizeSessionActivity(session);
    }
    return {
      run: { state: "idle", startedAt: null },
      queue: { state: "idle", count: 0 },
      rename: { state: "idle", error: "" },
      compact: { state: "idle" },
    };
  }

  function normalizeWorkflowState(value) {
    const model = getStateModel();
    if (model && typeof model.normalizeSessionWorkflowState === "function") {
      return model.normalizeSessionWorkflowState(value);
    }
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!normalized) return "";
    if (normalized === "waiting_user" || normalized === "waiting-user") return "waiting_user";
    if (normalized === "done" || normalized === "completed") return "done";
    if (normalized === "parked") return "parked";
    return "";
  }

  function hasUnreadUpdate(session) {
    const model = getStateModel();
    if (model && typeof model.hasSessionUnreadUpdate === "function") {
      return model.hasSessionUnreadUpdate(session);
    }
    return false;
  }

  function isCompleteAndReviewed(session) {
    const model = getStateModel();
    if (model && typeof model.isSessionCompleteAndReviewed === "function") {
      return model.isSessionCompleteAndReviewed(session);
    }
    return false;
  }

  function derivePrimaryState(session) {
    const workflowState = normalizeWorkflowState(session?.workflowState);
    const activity = normalizeActivity(session);
    if (workflowState === "waiting_user") return "waiting_user";
    if (activity.rename?.state === "failed") return "failed";
    if (workflowState === "done") return "done";
    if (workflowState === "parked") return "parked";
    return "active";
  }

  function deriveFlags(session) {
    const flags = [];
    const activity = normalizeActivity(session);
    if (activity.run?.state === "running") flags.push("running");
    if (activity.queue?.state === "queued") flags.push("queued");
    if (hasUnreadUpdate(session)) flags.push("unread");
    if (session?.pinned === true) flags.push("pinned");
    if (session?.archived === true) flags.push("archived");
    return flags;
  }

  function deriveGroupKey(presentation) {
    if (presentation.flags.includes("archived")) return "archived";
    if (presentation.primaryState === "waiting_user" || presentation.primaryState === "failed") {
      return "needs-user";
    }
    if (presentation.primaryState === "done" && presentation.flags.includes("unread")) {
      return "done-updated";
    }
    if (
      presentation.primaryState === "active"
      || presentation.flags.includes("running")
      || presentation.flags.includes("queued")
    ) {
      return "active";
    }
    return "closed";
  }

  function getSessionTimestamp(session) {
    const value = session?.lastEventAt || session?.updatedAt || session?.created || "";
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function deriveSessionPresentation(session) {
    const primaryState = derivePrimaryState(session);
    const flags = deriveFlags(session);
    return {
      primaryState,
      flags,
      groupKey: deriveGroupKey({ primaryState, flags }),
      completeRead: isCompleteAndReviewed(session),
      timestamp: getSessionTimestamp(session),
    };
  }

  function comparePresentationSessions(a, b) {
    const infoA = deriveSessionPresentation(a);
    const infoB = deriveSessionPresentation(b);
    const groupDiff = GROUP_ORDER.indexOf(infoA.groupKey) - GROUP_ORDER.indexOf(infoB.groupKey);
    if (groupDiff) return groupDiff;

    const stateDiff = (PRIMARY_STATE_ORDER[infoA.primaryState] || 99) - (PRIMARY_STATE_ORDER[infoB.primaryState] || 99);
    if (stateDiff) return stateDiff;

    const unreadDiff = Number(infoB.flags.includes("unread")) - Number(infoA.flags.includes("unread"));
    if (unreadDiff) return unreadDiff;

    const pinDiff = Number(infoB.flags.includes("pinned")) - Number(infoA.flags.includes("pinned"));
    if (pinDiff) return pinDiff;

    return infoB.timestamp - infoA.timestamp;
  }

  function getDisplayName(session) {
    if (typeof root.getSessionDisplayName === "function") {
      return root.getSessionDisplayName(session);
    }
    return session?.name || "Session";
  }

  function getFolderLabel(session) {
    if (typeof root.getSessionGroupInfo === "function") {
      return root.getSessionGroupInfo(session)?.label || LABELS.folderFallback;
    }
    return LABELS.folderFallback;
  }

  function getMessageCountText(session) {
    const count = Number.isInteger(session?.messageCount)
      ? session.messageCount
      : (Number.isInteger(session?.activeMessageCount) ? session.activeMessageCount : 0);
    if (count <= 0) return "";
    return LABELS.messages.replace("{count}", String(count));
  }

  function escapeHtml(value) {
    const el = root.document.createElement("span");
    el.textContent = value;
    return el.innerHTML;
  }

  function getFlagBadgeHtml(flag) {
    if (flag === "archived") return "";
    const label = LABELS.flag[flag];
    if (!label) return "";
    return `<span class="session-aux-badge flag-${flag}">${escapeHtml(label)}</span>`;
  }

  function buildAuxiliaryHtml(session, presentation) {
    const visibleFlags = presentation.flags
      .filter((flag) => flag !== "archived")
      .sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b))
      .slice(0, 2);

    const parts = visibleFlags
      .map((flag) => getFlagBadgeHtml(flag))
      .filter(Boolean);

    const folderLabel = getFolderLabel(session);
    if (folderLabel) {
      parts.push(`<span class="session-aux-text">${escapeHtml(folderLabel)}</span>`);
    }

    const messageCount = getMessageCountText(session);
    if (messageCount) {
      parts.push(`<span class="session-aux-text">${escapeHtml(messageCount)}</span>`);
    }

    return parts.join(" ");
  }

  function createSessionItem(session) {
    const presentation = deriveSessionPresentation(session);
    const div = root.document.createElement("div");
    div.className =
      "session-item custom-session-item"
      + (session.id === currentSessionId ? " active" : "")
      + (presentation.completeRead ? " is-complete-read" : "")
      + ` primary-${presentation.primaryState}`;

    const displayName = getDisplayName(session);
    const primaryLabel = LABELS.primary[presentation.primaryState] || LABELS.primary.active;
    const auxHtml = buildAuxiliaryHtml(session, presentation);
    const pinTitle = typeof root.t === "function" ? root.t("action.unpin") : "Unpin";
    const unpinnedTitle = typeof root.t === "function" ? root.t("action.pin") : "Pin";
    const renameTitle = typeof root.t === "function" ? root.t("action.rename") : "Rename";
    const archiveTitle = typeof root.t === "function" ? root.t("action.archive") : "Archive";

    div.innerHTML = `
      <div class="session-item-info custom-session-item-info">
        <div class="custom-session-item-topline">
          <div class="session-item-name">${escapeHtml(displayName)}</div>
          <span class="session-primary-badge state-${presentation.primaryState}">${escapeHtml(primaryLabel)}</span>
        </div>
        ${auxHtml ? `<div class="session-item-meta custom-session-item-meta">${auxHtml}</div>` : ""}
      </div>
      <div class="session-item-actions">
        <button class="session-action-btn pin${session.pinned ? " pinned" : ""}" type="button" title="${session.pinned ? pinTitle : unpinnedTitle}" aria-label="${session.pinned ? pinTitle : unpinnedTitle}" data-id="${session.id}">${renderUiIcon(session.pinned ? "pinned" : "pin")}</button>
        <button class="session-action-btn rename" type="button" title="${escapeHtml(renameTitle)}" aria-label="${escapeHtml(renameTitle)}" data-id="${session.id}">${renderUiIcon("edit")}</button>
        <button class="session-action-btn archive" type="button" title="${escapeHtml(archiveTitle)}" aria-label="${escapeHtml(archiveTitle)}" data-id="${session.id}">${renderUiIcon("archive")}</button>
      </div>`;

    div.addEventListener("click", (event) => {
      if (event.target.closest(".session-action-btn")) return;
      attachSession(session.id, session);
      if (!isDesktop) closeSidebarFn();
    });

    div.querySelector(".pin").addEventListener("click", (event) => {
      event.stopPropagation();
      dispatchAction({ action: session.pinned ? "unpin" : "pin", sessionId: session.id });
    });

    div.querySelector(".rename").addEventListener("click", (event) => {
      event.stopPropagation();
      startRename(div, session);
    });

    div.querySelector(".archive").addEventListener("click", (event) => {
      event.stopPropagation();
      dispatchAction({ action: "archive", sessionId: session.id });
    });

    return div;
  }

  function createGroupSection(groupKey, sessions) {
    const section = root.document.createElement("div");
    section.className = `session-state-group group-${groupKey}`;

    const header = root.document.createElement("div");
    header.className = "session-state-group-header";
    header.innerHTML = `
      <span class="session-state-group-title">${escapeHtml(LABELS.groups[groupKey])}</span>
      <span class="session-state-group-count">${sessions.length}</span>`;
    section.appendChild(header);

    const body = root.document.createElement("div");
    body.className = "session-state-group-body";
    for (const session of sessions) {
      body.appendChild(createSessionItem(session));
    }
    section.appendChild(body);
    return section;
  }

  function renderCustomSessionList() {
    if (!sessionList) return;
    sessionList.innerHTML = "";

    const sessions = [
      ...getVisiblePinnedSessions(),
      ...getVisibleActiveSessions(),
    ].sort(comparePresentationSessions);

    if (sessions.length === 0) {
      const empty = root.document.createElement("div");
      empty.className = "session-filter-empty";
      empty.textContent = getFilteredSessionEmptyText();
      sessionList.appendChild(empty);
      renderArchivedSection();
      return;
    }

    const buckets = new Map();
    for (const key of GROUP_ORDER) buckets.set(key, []);
    for (const session of sessions) {
      const groupKey = deriveSessionPresentation(session).groupKey;
      if (!buckets.has(groupKey)) buckets.set(groupKey, []);
      buckets.get(groupKey).push(session);
    }

    for (const key of GROUP_ORDER) {
      const groupSessions = buckets.get(key) || [];
      if (groupSessions.length === 0) continue;
      sessionList.appendChild(createGroupSection(key, groupSessions));
    }

    renderArchivedSection();
  }

  function setEnabled(nextValue) {
    enabled = nextValue === true;
    if (enabled && typeof originalRenderSessionList === "function") {
      root.renderSessionList = renderCustomSessionList;
      renderSessionList = renderCustomSessionList;
    } else if (typeof originalRenderSessionList === "function") {
      root.renderSessionList = originalRenderSessionList;
      renderSessionList = originalRenderSessionList;
    }
    if (typeof renderSessionList === "function") {
      renderSessionList();
    }
  }

  root.RemoteLabSessionPresentationCustom = {
    deriveSessionPresentation,
    comparePresentationSessions,
    renderCustomSessionList,
    setEnabled,
    isEnabled() {
      return enabled;
    },
  };

  const initialPreference = typeof root.remotelabGetSessionPresentationThemePreference === "function"
    ? root.remotelabGetSessionPresentationThemePreference()
    : (root.document.body?.classList.contains("session-presentation-theme-custom") ? "custom" : "default");
  setEnabled(initialPreference === "custom");
})(typeof globalThis !== "undefined" ? globalThis : window);
