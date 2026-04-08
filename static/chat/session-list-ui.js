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

function getInboxBandForSession(session) {
  if (typeof window.RemoteLabSessionStateModel?.getSessionAttentionBand === "function") {
    return window.RemoteLabSessionStateModel.getSessionAttentionBand(session);
  }
  return 3;
}

function renderSessionList() {
  sessionList.innerHTML = "";
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
    empty.textContent = getFilteredSessionEmptyText();
    sessionList.appendChild(empty);
  }

  renderArchivedSection();
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
      items.appendChild(createActiveSessionItem(s, { showGroup: true }));
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

  for (const [groupKey, groupEntry] of groups) {
    const folderSessions = groupEntry.sessions;
    const group = document.createElement("div");
    group.className = "folder-group";

    const header = document.createElement("div");
    header.className =
      "folder-group-header" +
      (collapsedFolders[groupKey] ? " collapsed" : "");

    // Count sessions needing attention in this group
    const attentionCount = folderSessions.filter((s) => {
      const band = getInboxBandForSession(s);
      return band <= 2; // unread-waiting, unread, or waiting
    }).length;
    const attentionBadge = attentionCount > 0
      ? `<span class="folder-attention-count">${attentionCount}</span>`
      : "";

    header.innerHTML = `<span class="folder-chevron">${renderUiIcon("chevron-down")}</span>
      <span class="folder-name" title="${esc(groupEntry.title)}">${esc(groupEntry.label)}</span>
      ${attentionBadge}<span class="folder-count">${folderSessions.length}</span>`;
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

function startRename(itemEl, session) {
  const nameEl = itemEl.querySelector(".session-item-name");
  const current = session.name || session.tool || "";
  const input = document.createElement("input");
  input.className = "session-rename-input";
  input.value = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim();
    if (newName && newName !== current) {
      dispatchAction({ action: "rename", sessionId: session.id, name: newName });
    } else {
      renderSessionList(); // revert
    }
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      input.removeEventListener("blur", commit);
      renderSessionList();
    }
  });
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
