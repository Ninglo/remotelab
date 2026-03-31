"use strict";

(function attachRemoteLabSessionPresentationCustom(root) {
  const UI_LANGUAGE_STORAGE_KEY = "remotelab.uiLanguage";
  const GROUP_ORDER = ["needs-user", "active", "done-updated", "closed"];
  const PRIMARY_STATE_ORDER = {
    waiting_user: 0,
    failed: 1,
    active: 2,
    done: 3,
    parked: 4,
  };
  const LABELS = {
    en: {
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
    },
    zh: {
      groups: {
        "needs-user": "待我处理",
        active: "进行中",
        "done-updated": "已完成但有新变化",
        closed: "已结束",
      },
      primary: {
        active: "进行中",
        waiting_user: "等你处理",
        done: "已完成",
        parked: "已搁置",
        failed: "异常",
      },
      flag: {
        running: "运行中",
        queued: "排队中",
        unread: "有新变化",
        pinned: "已置顶",
      },
      folderFallback: "默认分组",
      messages: "{count} 条消息",
    },
  };

  function getLanguagePack() {
    const stored = String(root.localStorage?.getItem?.(UI_LANGUAGE_STORAGE_KEY) || "").toLowerCase();
    const preferred = stored === "auto" || !stored
      ? String(root.navigator?.language || "en").toLowerCase()
      : stored;
    return preferred.startsWith("zh") ? LABELS.zh : LABELS.en;
  }

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
      return root.getSessionGroupInfo(session)?.label || getLanguagePack().folderFallback;
    }
    return getLanguagePack().folderFallback;
  }

  function getMessageCountText(session, labels) {
    const count = Number.isInteger(session?.messageCount)
      ? session.messageCount
      : (Number.isInteger(session?.activeMessageCount) ? session.activeMessageCount : 0);
    if (count <= 0) return "";
    return labels.messages.replace("{count}", String(count));
  }

  function escapeHtml(value) {
    const el = root.document.createElement("span");
    el.textContent = value;
    return el.innerHTML;
  }

  function getFlagBadgeHtml(flag, labels) {
    if (flag === "archived") return "";
    const label = labels.flag[flag];
    if (!label) return "";
    return `<span class="session-aux-badge flag-${flag}">${escapeHtml(label)}</span>`;
  }

  function buildAuxiliaryHtml(session, presentation, labels) {
    const visibleFlags = presentation.flags
      .filter((flag) => flag !== "archived")
      .sort((a, b) => ["unread", "running", "queued", "pinned"].indexOf(a) - ["unread", "running", "queued", "pinned"].indexOf(b))
      .slice(0, 2);

    const parts = visibleFlags
      .map((flag) => getFlagBadgeHtml(flag, labels))
      .filter(Boolean);

    const folderLabel = getFolderLabel(session);
    if (folderLabel) {
      parts.push(`<span class="session-aux-text">${escapeHtml(folderLabel)}</span>`);
    }

    const messageCount = getMessageCountText(session, labels);
    if (messageCount) {
      parts.push(`<span class="session-aux-text">${escapeHtml(messageCount)}</span>`);
    }

    return parts.join(" ");
  }

  function createSessionItem(session) {
    const labels = getLanguagePack();
    const presentation = deriveSessionPresentation(session);
    const div = root.document.createElement("div");
    div.className =
      "session-item custom-session-item"
      + (session.id === currentSessionId ? " active" : "")
      + (presentation.completeRead ? " is-complete-read" : "")
      + ` primary-${presentation.primaryState}`;

    const displayName = getDisplayName(session);
    const primaryLabel = labels.primary[presentation.primaryState] || labels.primary.active;
    const auxHtml = buildAuxiliaryHtml(session, presentation, labels);
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

  function createGroupSection(groupKey, sessions, labels) {
    const section = root.document.createElement("div");
    section.className = `session-state-group group-${groupKey}`;

    const header = root.document.createElement("div");
    header.className = "session-state-group-header";
    header.innerHTML = `
      <span class="session-state-group-title">${escapeHtml(labels.groups[groupKey])}</span>
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

  function createBoardCard(session) {
    const labels = getLanguagePack();
    const presentation = deriveSessionPresentation(session);
    const card = root.document.createElement("div");
    card.className =
      "board-card custom-board-card"
      + (session.id === currentSessionId ? " active" : "")
      + ` primary-${presentation.primaryState}`;

    const displayName = getDisplayName(session);
    const primaryLabel = labels.primary[presentation.primaryState] || labels.primary.active;
    const auxHtml = buildAuxiliaryHtml(session, presentation, labels);
    card.innerHTML = `
      <div class="board-card-topline custom-board-card-topline">
        <div class="board-card-title">${escapeHtml(displayName)}</div>
        <span class="session-primary-badge state-${presentation.primaryState}">${escapeHtml(primaryLabel)}</span>
      </div>
      ${auxHtml ? `<div class="board-card-meta custom-board-card-meta">${auxHtml}</div>` : ""}`;

    card.addEventListener("click", () => {
      attachSession(session.id, session);
      if (!isDesktop) closeSidebarFn();
    });
    return card;
  }

  function createBoardColumn(groupKey, sessions, labels) {
    const column = root.document.createElement("section");
    column.className = "board-column custom-board-column";
    column.dataset.column = groupKey;

    const header = root.document.createElement("div");
    header.className = "board-column-header";
    header.innerHTML = `
      <span class="board-column-dot"></span>
      <span class="board-column-title">${escapeHtml(labels.groups[groupKey])}</span>
      <span class="board-column-count">${sessions.length}</span>`;
    column.appendChild(header);

    const body = root.document.createElement("div");
    body.className = "board-column-body";
    if (sessions.length === 0) {
      const empty = root.document.createElement("div");
      empty.className = "board-card-empty";
      empty.textContent = "—";
      body.appendChild(empty);
    } else {
      for (const session of sessions) {
        body.appendChild(createBoardCard(session));
      }
    }
    column.appendChild(body);
    return column;
  }

  function renderCustomBoard() {
    if (!boardPanel) return;
    const labels = getLanguagePack();
    const sessions = [
      ...getVisiblePinnedSessions(),
      ...getVisibleActiveSessions(),
    ].sort(comparePresentationSessions);

    const scroller = root.document.createElement("div");
    scroller.className = "board-scroller custom-board-scroller";

    const buckets = new Map();
    for (const key of GROUP_ORDER) buckets.set(key, []);
    for (const session of sessions) {
      const groupKey = deriveSessionPresentation(session).groupKey;
      if (!buckets.has(groupKey)) buckets.set(groupKey, []);
      buckets.get(groupKey).push(session);
    }

    for (const key of GROUP_ORDER) {
      scroller.appendChild(createBoardColumn(key, buckets.get(key) || [], labels));
    }

    boardPanel.innerHTML = "";
    boardPanel.appendChild(scroller);
  }

  function renderCustomSessionList() {
    if (!sessionList) return;
    const labels = getLanguagePack();
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
      sessionList.appendChild(createGroupSection(key, groupSessions, labels));
    }

    renderArchivedSection();
  }

  root.RemoteLabSessionPresentationCustom = {
    deriveSessionPresentation,
    comparePresentationSessions,
    renderCustomSessionList,
    renderCustomBoard,
  };

  root.renderSessionList = renderCustomSessionList;
  renderSessionList = renderCustomSessionList;

  const originalSwitchTab = typeof switchTab === "function" ? switchTab : null;

  function switchCustomTab(tab, { syncState = true } = {}) {
    const nextTab = typeof normalizeSidebarTab === "function"
      ? normalizeSidebarTab(tab)
      : tab;

    if (nextTab !== "board") {
      if (typeof originalSwitchTab === "function") {
        const result = originalSwitchTab(tab, { syncState });
        if (tabBoard) tabBoard.classList.toggle("active", false);
        if (boardPanel) boardPanel.classList.remove("visible");
        root.document.body?.classList.remove("board-tab-expanded");
        return result;
      }
      return false;
    }

    if (typeof setChatActiveTab === "function") {
      setChatActiveTab(nextTab, {
        normalizeTab: typeof normalizeSidebarTab === "function" ? normalizeSidebarTab : undefined,
      });
      if (typeof getActiveSidebarTabValue === "function") {
        activeTab = getActiveSidebarTabValue();
      } else {
        activeTab = nextTab;
      }
    } else {
      activeTab = nextTab;
      if (typeof dispatchChatStore === "function") {
        dispatchChatStore({
          type: "set-active-tab",
          value: activeTab,
          normalizeTab: typeof normalizeSidebarTab === "function" ? normalizeSidebarTab : undefined,
        });
      }
    }

    if (tabSessions) tabSessions.classList.toggle("active", false);
    if (tabBoard) tabBoard.classList.toggle("active", true);
    if (tabSettings) tabSettings.classList.toggle("active", false);
    if (typeof syncSidebarFiltersVisibility === "function") {
      syncSidebarFiltersVisibility(false);
    } else if (sidebarFilters) {
      sidebarFilters.classList.add("hidden");
    }
    if (sessionList) sessionList.style.display = "none";
    if (settingsPanel) settingsPanel.classList.remove("visible");
    if (boardPanel) boardPanel.classList.add("visible");
    if (sessionListFooter) sessionListFooter.classList.add("hidden");
    if (sortSessionListBtn) sortSessionListBtn.classList.add("hidden");
    if (newSessionBtn) newSessionBtn.classList.add("hidden");
    root.document.body?.classList.add("board-tab-expanded");
    renderCustomBoard();
    if (syncState && typeof syncBrowserState === "function") {
      syncBrowserState();
    }
    return true;
  }

  if (typeof originalSwitchTab === "function") {
    root.switchTab = switchCustomTab;
    switchTab = switchCustomTab;
  }

  if (typeof tabBoard !== "undefined" && tabBoard) {
    tabBoard.addEventListener("click", () => switchCustomTab("board"));
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
