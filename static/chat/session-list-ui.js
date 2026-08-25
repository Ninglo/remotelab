// ---- Session list ----
function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

// Inbox view: attention-band labels
const INBOX_BANDS = [
  { band: 0, key: "inbox:unread-waiting", label: "Needs your attention" },
  { band: 1, key: "inbox:unread", label: "New updates" },
  { band: 2, key: "inbox:waiting", label: "Waiting on you" },
  { band: 3, key: "inbox:active", label: "Active" },
  { band: 4, key: "inbox:running", label: "Running" },
  { band: 5, key: "inbox:parked", label: "Parked" },
  { band: 6, key: "inbox:done", label: "Done" },
];

let activeSessionRename = null;
let sessionListRenderDepth = 0;

function getInboxBandForSession(session) {
  if (typeof window.RemoteLabSessionStateModel?.getSessionAttentionBand === "function") {
    return window.RemoteLabSessionStateModel.getSessionAttentionBand(session);
  }
  return 3;
}

function getProjectGroupSessionSortTime(session) {
  if (typeof getSessionSortTime === "function") {
    return getSessionSortTime(session);
  }
  const stamp = session?.lastEventAt || session?.updatedAt || session?.created || "";
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getProjectGroupRunningRank(groupEntry) {
  const groupSessions = Array.isArray(groupEntry?.sessions) ? groupEntry.sessions : [];
  return groupSessions.some((session) => {
    const activity = typeof getSessionActivity === "function" ? getSessionActivity(session) : null;
    return activity?.run?.state === "running";
  }) ? 1 : 0;
}

function getProjectGroupAttentionRank(groupEntry) {
  const groupSessions = Array.isArray(groupEntry?.sessions) ? groupEntry.sessions : [];
  if (groupSessions.length === 0) return 6;
  return groupSessions.reduce((bestRank, session) => {
    const band = typeof getInboxBandForSession === "function"
      ? getInboxBandForSession(session)
      : 3;
    return Math.min(bestRank, band);
  }, 6);
}

function getProjectGroupLatestActivityTime(groupEntry) {
  const groupSessions = Array.isArray(groupEntry?.sessions) ? groupEntry.sessions : [];
  return groupSessions.reduce(
    (latestTime, session) => Math.max(latestTime, getProjectGroupSessionSortTime(session)),
    0,
  );
}

function getProjectGroupOrganizerOrder(groupEntry) {
  const groupSessions = Array.isArray(groupEntry?.sessions) ? groupEntry.sessions : [];
  return groupSessions.reduce((bestOrder, session) => {
    const rawOrder = typeof session?.sidebarOrder === "number"
      ? session.sidebarOrder
      : Number.parseInt(String(session?.sidebarOrder || "").trim(), 10);
    if (!Number.isInteger(rawOrder) || rawOrder <= 0) return bestOrder;
    return bestOrder > 0 ? Math.min(bestOrder, rawOrder) : rawOrder;
  }, 0);
}

function compareProjectGroupsByLatestActivity(a, b) {
  const runningDiff = getProjectGroupRunningRank(b) - getProjectGroupRunningRank(a);
  if (runningDiff) return runningDiff;

  const attentionDiff = getProjectGroupAttentionRank(a) - getProjectGroupAttentionRank(b);
  if (attentionDiff) return attentionDiff;

  const organizerOrderA = getProjectGroupOrganizerOrder(a);
  const organizerOrderB = getProjectGroupOrganizerOrder(b);
  if (organizerOrderA && organizerOrderB && organizerOrderA !== organizerOrderB) {
    return organizerOrderA - organizerOrderB;
  }

  const latestActivityDiff = getProjectGroupLatestActivityTime(b) - getProjectGroupLatestActivityTime(a);
  if (latestActivityDiff) return latestActivityDiff;

  return String(a.label || a.title || a.key || "").localeCompare(
    String(b.label || b.title || b.key || ""),
    undefined,
    { numeric: true, sensitivity: "base" },
  );
}

function sortProjectGroupsByLatestActivity(groupEntries) {
  return groupEntries.slice().sort(compareProjectGroupsByLatestActivity);
}

function getSessionSpaceEntries() {
  const spaces = new Map();
  for (const session of getActiveSessions()) {
    if (
      !matchesAccountFilter(session, activeAccountFilter)
      || !matchesSourceFilter(session, activeSourceFilter)
      || !matchesSearchQuery(session)
    ) continue;
    const value = getSessionSpaceValue(session);
    const label = value === SESSION_SPACE_LOOSE_VALUE
      ? t("sidebar.space.loose")
      : value;
    if (!spaces.has(value)) {
      spaces.set(value, { key: value, label, title: label, sessions: [] });
    }
    spaces.get(value).sessions.push(session);
  }
  return sortProjectGroupsByLatestActivity([...spaces.values()]);
}

function renderSessionSpaceSwitcher() {
  if (!sidebarSpaceSwitcher) return;
  const entries = getSessionSpaceEntries();
  const namedEntries = entries.filter((entry) => entry.key !== SESSION_SPACE_LOOSE_VALUE);
  if (namedEntries.length === 0) {
    sidebarSpaceSwitcher.hidden = true;
    activeSessionSpace = SESSION_SPACE_ALL_VALUE;
    return;
  }

  if (
    activeSessionSpace !== SESSION_SPACE_ALL_VALUE
    && !entries.some((entry) => entry.key === activeSessionSpace)
  ) {
    activeSessionSpace = SESSION_SPACE_ALL_VALUE;
    localStorage.setItem(ACTIVE_SESSION_SPACE_STORAGE_KEY, activeSessionSpace);
  }

  const allEntry = {
    key: SESSION_SPACE_ALL_VALUE,
    label: t("sidebar.space.all"),
    title: t("sidebar.space.all"),
    sessions: entries.flatMap((entry) => entry.sessions),
  };
  sidebarSpaceSwitcher.innerHTML = "";
  for (const entry of [allEntry, ...entries]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "space-switch-btn" + (entry.key === activeSessionSpace ? " active" : "");
    button.textContent = entry.label;
    button.title = `${entry.title} (${entry.sessions.length})`;
    button.setAttribute("aria-pressed", entry.key === activeSessionSpace ? "true" : "false");
    button.addEventListener("click", () => {
      if (entry.key === activeSessionSpace) return;
      activeSessionSpace = entry.key;
      localStorage.setItem(ACTIVE_SESSION_SPACE_STORAGE_KEY, activeSessionSpace);
      sessionList.classList.add("switching-space");
      renderSessionList();
      requestAnimationFrame(() => sessionList.classList.remove("switching-space"));
    });
    sidebarSpaceSwitcher.appendChild(button);
  }
  sidebarSpaceSwitcher.hidden = false;
}

function renderSessionList() {
  sessionListRenderDepth += 1;
  try {
    sessionList.innerHTML = "";
    renderSessionSpaceSwitcher();
    const pinnedSessions = getVisiblePinnedSessions();
    const visibleSessions = getVisibleActiveSessions();

    // Pinned section — shown in both views
    if (pinnedSessions.length > 0) {
      const section = document.createElement("div");
      section.className = "pinned-section";

      const header = document.createElement("div");
      header.className = "pinned-section-header";
      header.innerHTML = `<span class="pinned-label">${esc(t("sidebar.pinned"))}</span><span class="folder-count">${pinnedSessions.length}</span>`;

      const items = document.createElement("div");
      items.className = "pinned-items";
      for (const session of pinnedSessions) {
        items.appendChild(createActiveSessionItem(session));
      }

      section.appendChild(header);
      section.appendChild(items);
      sessionList.appendChild(section);
    }

    if (sessionViewMode === "inbox") {
      renderInboxView(visibleSessions);
    } else {
      renderProjectsView(visibleSessions);
    }

    if (pinnedSessions.length === 0 && visibleSessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "session-filter-empty";
      const emptyText = document.createElement("div");
      emptyText.textContent = getFilteredSessionEmptyText();
      empty.appendChild(emptyText);

      const canRestoreStarterSessions = !visitorMode
        && !(typeof isTeamMemberSessionView === "function" && isTeamMemberSessionView())
        && activeAccountFilter === FILTER_ALL_VALUE
        && activeSourceFilter === FILTER_ALL_VALUE
        && !(typeof sessionSearchQuery === "string" && sessionSearchQuery.trim())
        && typeof restoreOwnerBootstrapSessions === "function";
      if (canRestoreStarterSessions) {
        const restoreButton = document.createElement("button");
        restoreButton.type = "button";
        restoreButton.className = "new-session-btn secondary";
        restoreButton.textContent = t("sidebar.restoreStarterSessions");
        restoreButton.addEventListener("click", async () => {
          if (restoreButton.disabled) return;
          restoreButton.disabled = true;
          restoreButton.textContent = t("sidebar.restoringStarterSessions");
          try {
            await restoreOwnerBootstrapSessions();
          } catch (error) {
            console.warn("[sessions] Failed to restore starter sessions:", error?.message || error);
            restoreButton.textContent = t("sidebar.restoreStarterSessions");
            restoreButton.disabled = false;
            return;
          }
          restoreButton.textContent = t("sidebar.restoreStarterSessions");
          restoreButton.disabled = false;
        });
        empty.appendChild(restoreButton);
      }
      sessionList.appendChild(empty);
    }

    renderArchivedSection();
  } finally {
    sessionListRenderDepth = Math.max(0, sessionListRenderDepth - 1);
    if (sessionListRenderDepth === 0) {
      refocusActiveSessionRenameInput();
    }
  }
}

function renderInboxView(visibleSessions) {
  // Group sessions by attention band
  const bandMap = new Map();
  for (const s of visibleSessions) {
    const band = getInboxBandForSession(s);
    if (!bandMap.has(band)) bandMap.set(band, []);
    bandMap.get(band).push(s);
  }

  for (const bandSpec of INBOX_BANDS) {
    const sessions = bandMap.get(bandSpec.band);
    if (!sessions || sessions.length === 0) continue;

    const group = document.createElement("div");
    group.className = "folder-group inbox-band";

    const header = document.createElement("div");
    const isCollapsed = collapsedFolders[bandSpec.key] === true;
    header.className = "folder-group-header" + (isCollapsed ? " collapsed" : "");

    const bandLabel = t(`sidebar.inbox.${bandSpec.key.split(":")[1]}`) !== `sidebar.inbox.${bandSpec.key.split(":")[1]}`
      ? t(`sidebar.inbox.${bandSpec.key.split(":")[1]}`)
      : bandSpec.label;

    header.innerHTML = `<span class="folder-chevron">${renderUiIcon("chevron-down")}</span>
      <span class="folder-name" title="${esc(bandLabel)}">${esc(bandLabel)}</span>
      <span class="folder-count">${sessions.length}</span>`;
    header.addEventListener("click", () => {
      header.classList.toggle("collapsed");
      collapsedFolders[bandSpec.key] = header.classList.contains("collapsed");
      localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(collapsedFolders));
    });

    const items = document.createElement("div");
    items.className = "folder-group-items";
    for (const s of sessions) {
      items.appendChild(createActiveSessionItem(s));
    }

    group.appendChild(header);
    group.appendChild(items);
    sessionList.appendChild(group);
  }
}

function renderProjectsView(visibleSessions) {
  const groups = new Map();
  for (const s of visibleSessions) {
    const groupInfo = getSessionGroupInfo(s);
    if (!groups.has(groupInfo.key)) {
      groups.set(groupInfo.key, { ...groupInfo, sessions: [] });
    }
    groups.get(groupInfo.key).sessions.push(s);
  }

  for (const groupEntry of sortProjectGroupsByLatestActivity([...groups.values()])) {
    const groupKey = groupEntry.key;
    const folderSessions = groupEntry.sessions;
    const group = document.createElement("div");
    group.className = "folder-group";

    const header = document.createElement("div");
    header.className =
      "folder-group-header" +
      (collapsedFolders[groupKey] ? " collapsed" : "");

    header.innerHTML = `<span class="folder-chevron">${renderUiIcon("chevron-down")}</span>
      <span class="folder-name" title="${esc(groupEntry.title)}">${esc(groupEntry.label)}</span>
      <span class="folder-count">${folderSessions.length}</span>`;
    header.addEventListener("click", (e) => {
      header.classList.toggle("collapsed");
      collapsedFolders[groupKey] = header.classList.contains("collapsed");
      localStorage.setItem(
        COLLAPSED_GROUPS_STORAGE_KEY,
        JSON.stringify(collapsedFolders),
      );
    });

    const items = document.createElement("div");
    items.className = "folder-group-items";

    for (const s of folderSessions) {
      items.appendChild(createActiveSessionItem(s));
    }

    group.appendChild(header);
    group.appendChild(items);
    sessionList.appendChild(group);
  }
}

function renderArchivedSection() {
  const archivedSessions = getVisibleArchivedSessions();
  const existing = document.getElementById("archivedSection");
  if (existing) existing.remove();

  const section = document.createElement("div");
  section.id = "archivedSection";
  section.className = "archived-section";

  const header = document.createElement("div");
  header.className = "archived-section-header";
  const isCollapsed = localStorage.getItem("archivedCollapsed") !== "false";
  if (isCollapsed) header.classList.add("collapsed");
  const archivedCount = archivedSessionsLoaded ? archivedSessions.length : archivedSessionCount;
  header.innerHTML = `<span class="folder-chevron">${renderUiIcon("chevron-down")}</span><span class="archived-label">${esc(t("sidebar.archive"))}</span><span class="folder-count">${archivedCount}</span>`;
  header.addEventListener("click", () => {
    header.classList.toggle("collapsed");
    localStorage.setItem("archivedCollapsed", header.classList.contains("collapsed") ? "true" : "false");
    if (!header.classList.contains("collapsed") && !archivedSessionsLoaded && !archivedSessionsLoading && archivedSessionCount > 0) {
      Promise.resolve(fetchArchivedSessions()).catch((error) => {
        console.warn("[sessions] Failed to load archived sessions:", error.message);
      });
    }
  });

  const items = document.createElement("div");
  items.className = "archived-items";

  if (!isCollapsed && !archivedSessionsLoaded && archivedSessionCount > 0) {
    if (!archivedSessionsLoading) {
      Promise.resolve(fetchArchivedSessions()).catch((error) => {
        console.warn("[sessions] Failed to load archived sessions:", error.message);
      });
    }
    const loading = document.createElement("div");
    loading.className = "archived-empty";
    loading.textContent = archivedSessionsLoading
      ? t("sidebar.loadingArchived")
      : t("sidebar.loadArchived");
    items.appendChild(loading);
  } else if (archivedSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "archived-empty";
    empty.textContent = getFilteredSessionEmptyText({ archived: true });
    items.appendChild(empty);
  } else {
    for (const s of archivedSessions) {
      const div = document.createElement("div");
      div.className =
        "session-item archived-item" + (s.id === currentSessionId ? " active" : "");
      const displayName = getSessionDisplayName(s);
      const groupInfo = getSessionGroupInfo(s);
      const shortFolder = getShortFolder(s.folder || "");
      const date = s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : "";
      div.innerHTML = `
        <div class="session-item-info">
          <div class="session-item-name">${esc(displayName)}</div>
          <div class="session-item-meta"><span title="${esc(shortFolder || groupInfo.title)}">${esc(groupInfo.label)}</span>${date ? ` · ${date}` : ""}</div>
        </div>
        <div class="session-item-actions">
          <button class="session-action-btn restore" type="button" title="${esc(t("action.restore"))}" aria-label="${esc(t("action.restore"))}" data-id="${s.id}">${renderUiIcon("unarchive")}</button>
        </div>`;
      div.addEventListener("click", (e) => {
        if (e.target.closest(".session-action-btn")) return;
        attachSession(s.id, s);
        if (!isDesktop) closeSidebarFn();
      });
      div.querySelector(".restore").addEventListener("click", (e) => {
        e.stopPropagation();
        dispatchAction({ action: "unarchive", sessionId: s.id });
      });
      items.appendChild(div);
    }
  }

  section.appendChild(header);
  section.appendChild(items);
  sessionList.appendChild(section);
}

function getSessionRenameBaseName(session) {
  return session.name || session.tool || "";
}

function clearActiveSessionRename(sessionId) {
  if (activeSessionRename?.sessionId === sessionId) {
    activeSessionRename = null;
  }
}

function isSessionListRendering() {
  return sessionListRenderDepth > 0;
}

function focusSessionRenameInput(input, shouldSelect = false) {
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
  if (shouldSelect) input.select();
}

function refocusActiveSessionRenameInput() {
  if (!activeSessionRename || !sessionList || typeof sessionList.querySelector !== "function") return;
  const input = sessionList.querySelector(".session-rename-input");
  if (!input) return;
  focusSessionRenameInput(input, false);
}

function renderActiveSessionRenameEditor(itemEl, session, options = {}) {
  if (!itemEl || !session?.id || activeSessionRename?.sessionId !== session.id) {
    return false;
  }
  const nameEl = itemEl.querySelector(".session-item-name");
  if (!nameEl) return false;

  const input = document.createElement("input");
  input.className = "session-rename-input";
  input.value = activeSessionRename.draftName ?? getSessionRenameBaseName(session);
  nameEl.replaceWith(input);

  let completed = false;
  let isComposing = false;
  const originalName = activeSessionRename.originalName ?? getSessionRenameBaseName(session);

  function commit() {
    if (completed) return;
    completed = true;
    const newName = input.value.trim();
    clearActiveSessionRename(session.id);
    if (newName && newName !== originalName) {
      dispatchAction({ action: "rename", sessionId: session.id, name: newName });
    } else {
      renderSessionList(); // revert
    }
  }

  input.addEventListener("input", () => {
    if (activeSessionRename?.sessionId === session.id) {
      activeSessionRename.draftName = input.value;
    }
  });
  input.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  input.addEventListener("compositionend", () => {
    isComposing = false;
    if (activeSessionRename?.sessionId === session.id) {
      activeSessionRename.draftName = input.value;
    }
  });
  input.addEventListener("blur", () => {
    if (isSessionListRendering()) return;
    commit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (isComposing || e.isComposing) return;
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      completed = true;
      clearActiveSessionRename(session.id);
      renderSessionList();
    }
  });

  if (options.focus === true) {
    focusSessionRenameInput(input, options.select === true);
  }
  return true;
}

function startRename(itemEl, session) {
  const current = getSessionRenameBaseName(session);
  activeSessionRename = {
    sessionId: session.id,
    originalName: current,
    draftName: current,
  };
  renderActiveSessionRenameEditor(itemEl, session, { focus: true, select: true });
}

function attachSession(id, session, { forceComposerFocus = false } = {}) {
  const shouldReattach = !hasAttachedSession || currentSessionId !== id;
  const previousSessionId = currentSessionId;
  if (
    shouldReattach
    && previousSessionId
    && previousSessionId !== id
    && typeof settleAttachedSessionSidebarState === "function"
  ) {
    Promise.resolve(settleAttachedSessionSidebarState({
      sessionId: previousSessionId,
      sync: true,
      render: false,
    })).catch(() => {});
  }
  const attachedSession = (typeof getChatStoreSession === "function" ? getChatStoreSession(id) : null)
    || session
    || { id };
  if (typeof holdAttachedSessionSidebarState === "function") {
    holdAttachedSessionSidebarState(attachedSession);
  }
  if (shouldReattach) {
    clearMessages();
    dispatchAction({ action: "attach", sessionId: id });
  }
  applyAttachedSessionState(id, attachedSession);
  if (typeof stageSessionReviewedForAttachedSession === "function") {
    Promise.resolve(stageSessionReviewedForAttachedSession(attachedSession)).catch(() => {});
  }
  if (typeof focusComposer === "function") {
    focusComposer({ force: forceComposerFocus === true, preventScroll: true });
  } else {
    msgInput.focus();
  }
}
