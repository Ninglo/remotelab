function esc(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function getShortFolder(folder) {
  return (folder || "").replace(/^\/Users\/[^/]+/, "~");
}

function getFolderLabel(folder) {
  const shortFolder = getShortFolder(folder);
  return shortFolder.split("/").pop() || shortFolder || "Session";
}

function getSessionDisplayName(session) {
  return session?.name || getFolderLabel(session?.folder) || "Session";
}

function formatQueuedMessageTimestamp(stamp) {
  if (!stamp) return "Queued";
  const parsed = new Date(stamp).getTime();
  if (!Number.isFinite(parsed)) return "Queued";
  return `Queued ${messageTimeFormatter.format(parsed)}`;
}

function renderQueuedMessagePanel(session) {
  if (!queuedPanel) return;
  const items = Array.isArray(session?.queuedMessages) ? session.queuedMessages : [];
  if (!session?.id || session.id !== currentSessionId || items.length === 0) {
    queuedPanel.innerHTML = "";
    queuedPanel.classList.remove("visible");
    return;
  }

  queuedPanel.innerHTML = "";
  queuedPanel.classList.add("visible");

  const header = document.createElement("div");
  header.className = "queued-panel-header";

  const title = document.createElement("div");
  title.className = "queued-panel-title";
  title.textContent = items.length === 1 ? "1 follow-up queued" : `${items.length} follow-ups queued`;

  const note = document.createElement("div");
  note.className = "queued-panel-note";
  const activity = getSessionActivity(session);
  note.textContent = activity.run.state === "running" || activity.compact.state === "pending"
    ? "Will send automatically after the current run"
    : "Preparing the next turn";

  header.appendChild(title);
  header.appendChild(note);
  queuedPanel.appendChild(header);

  const list = document.createElement("div");
  list.className = "queued-list";
  const visibleItems = items.slice(-5);
  for (const item of visibleItems) {
    const row = document.createElement("div");
    row.className = "queued-item";

    const meta = document.createElement("div");
    meta.className = "queued-item-meta";
    meta.textContent = formatQueuedMessageTimestamp(item.queuedAt);

    const text = document.createElement("div");
    text.className = "queued-item-text";
    text.textContent = item.text || "(attachment)";

    row.appendChild(meta);
    row.appendChild(text);

    const imageNames = (item.images || []).map((image) => getAttachmentDisplayName(image)).filter(Boolean);
    if (imageNames.length > 0) {
      const imageLine = document.createElement("div");
      imageLine.className = "queued-item-images";
      imageLine.textContent = `Attachments: ${imageNames.join(", ")}`;
      row.appendChild(imageLine);
    }

    list.appendChild(row);
  }

  queuedPanel.appendChild(list);

  if (items.length > visibleItems.length) {
    const more = document.createElement("div");
    more.className = "queued-panel-more";
    more.textContent = `${items.length - visibleItems.length} older queued follow-up${items.length - visibleItems.length === 1 ? "" : "s"} hidden`;
    queuedPanel.appendChild(more);
  }
}

function renderSessionMessageCount(session) {
  const count = Number.isInteger(session?.messageCount)
    ? session.messageCount
    : (Number.isInteger(session?.activeMessageCount) ? session.activeMessageCount : 0);
  if (count <= 0) return "";
  const label = `${count} msg${count === 1 ? "" : "s"}`;
  return `<span class="session-item-count" title="Messages in this session">${label}</span>`;
}

function getSessionMetaStatusInfo(session) {
  const liveStatus = getSessionStatusSummary(session).primary;
  if (liveStatus?.key && liveStatus.key !== "idle") {
    return liveStatus;
  }
  const workflowStatus = typeof window !== "undefined"
    && window.RemoteLabSessionStateModel
    && typeof window.RemoteLabSessionStateModel.getWorkflowStatusInfo === "function"
    ? window.RemoteLabSessionStateModel.getWorkflowStatusInfo(session?.workflowState)
    : null;
  return workflowStatus || liveStatus;
}

function getSessionReviewStatusInfo(session) {
  return typeof window !== "undefined"
    && window.RemoteLabSessionStateModel
    && typeof window.RemoteLabSessionStateModel.getSessionReviewStatusInfo === "function"
    ? window.RemoteLabSessionStateModel.getSessionReviewStatusInfo(session)
    : null;
}

function isSessionCompleteAndReviewed(session) {
  return typeof window !== "undefined"
    && window.RemoteLabSessionStateModel
    && typeof window.RemoteLabSessionStateModel.isSessionCompleteAndReviewed === "function"
    ? window.RemoteLabSessionStateModel.isSessionCompleteAndReviewed(session)
    : false;
}

function buildSessionMetaParts(session) {
  const parts = [];
  const reviewHtml = renderSessionStatusHtml(getSessionReviewStatusInfo(session));
  if (reviewHtml) parts.push(reviewHtml);
  const liveStatus = getSessionStatusSummary(session).primary;
  const statusHtml = liveStatus?.key && liveStatus.key !== "idle"
    ? renderSessionStatusHtml(liveStatus)
    : "";
  if (statusHtml) parts.push(statusHtml);
  const countHtml = renderSessionMessageCount(session);
  if (countHtml) parts.push(countHtml);
  return parts;
}

function buildBoardCardMetaParts(session) {
  const parts = [];
  parts.push(...renderSessionScopeContext(session));
  const reviewHtml = renderSessionStatusHtml(getSessionReviewStatusInfo(session));
  if (reviewHtml) parts.push(reviewHtml);
  const statusHtml = renderSessionStatusHtml(getSessionMetaStatusInfo(session));
  if (statusHtml) parts.push(statusHtml);
  return parts;
}

function renderSessionScopeContext(session) {
  const parts = [];
  const sourceName = typeof getEffectiveSessionSourceName === "function"
    ? getEffectiveSessionSourceName(session)
    : "";
  if (sourceName) {
    parts.push(`<span title="Session source">${esc(sourceName)}</span>`);
  }

  const templateAppId = typeof getEffectiveSessionTemplateAppId === "function"
    ? getEffectiveSessionTemplateAppId(session)
    : "";
  if (templateAppId) {
    const appEntry = typeof getSessionAppCatalogEntry === "function"
      ? getSessionAppCatalogEntry(templateAppId)
      : null;
    const appName = appEntry?.name || session?.appName || "App";
    parts.push(`<span title="Session app">App: ${esc(appName)}</span>`);
  }

  if (session?.visitorId) {
    const visitorLabel = typeof session?.visitorName === "string" && session.visitorName.trim()
      ? `Visitor: ${session.visitorName.trim()}`
      : (session?.visitorId ? "Visitor" : "Owner");
    parts.push(`<span title="Session owner scope">${esc(visitorLabel)}</span>`);
  }

  return parts;
}

function getFilteredSessionEmptyText({ archived = false } = {}) {
  if (archived) return "No archived sessions";
  if (
    activeSourceFilter !== FILTER_ALL_VALUE
    || activeSessionAppFilter !== FILTER_ALL_VALUE
    || activeUserFilter !== ADMIN_USER_FILTER_VALUE
  ) {
    return "No sessions match the current filters";
  }
  return "No sessions yet";
}

function getSessionGroupInfo(session) {
  const group = typeof session?.group === "string" ? session.group.trim() : "";
  if (group) {
    return {
      key: `group:${group}`,
      label: group,
      title: group,
    };
  }

  const folder = session?.folder || "?";
  const shortFolder = getShortFolder(folder);
  return {
    key: `folder:${folder}`,
    label: getFolderLabel(folder),
    title: shortFolder,
  };
}

function renderSessionStatusHtml(statusInfo) {
  if (!statusInfo?.label) return "";
  const title = statusInfo.title ? ` title="${esc(statusInfo.title)}"` : "";
  if (!statusInfo.className) {
    return `<span${title}>${esc(statusInfo.label)}</span>`;
  }
  return `<span class="${statusInfo.className}"${title}>● ${esc(statusInfo.label)}</span>`;
}

function formatBoardTimestampValue(stamp) {
  const parsed = new Date(stamp || "").getTime();
  if (!Number.isFinite(parsed)) return "";
  return messageTimeFormatter.format(parsed);
}

function formatBoardSessionTimestamp(session) {
  const stamp = session?.lastEventAt || session?.updatedAt || session?.created || "";
  return formatBoardTimestampValue(stamp);
}

function renderBoardPriorityPill(priorityInfo) {
  if (!priorityInfo?.label) return "";
  const title = priorityInfo.title ? ` title="${esc(priorityInfo.title)}"` : "";
  const className = priorityInfo.className ? ` ${priorityInfo.className}` : "";
  return `<span class="board-priority-pill${className}"${title}>${esc(priorityInfo.label)}</span>`;
}

function createBoardSessionCard(session) {
  const priorityInfo = getSessionBoardPriority(session);
  const card = document.createElement("div");
  card.className = "board-card"
    + (priorityInfo?.className ? ` ${priorityInfo.className}` : "")
    + (session.id === currentSessionId ? " active" : "");

  const displayName = getSessionDisplayName(session);
  const metaParts = buildBoardCardMetaParts(session);

  const description = typeof session?.description === "string"
    ? session.description.trim()
    : "";
  const timestamp = formatBoardSessionTimestamp(session);

  card.innerHTML = `
    <div class="board-card-topline">
      ${renderBoardPriorityPill(priorityInfo)}
      ${timestamp ? `<div class="board-card-time">Updated ${esc(timestamp)}</div>` : ""}
    </div>
    <div class="board-card-title">${session.pinned ? `<span class="session-pin-badge" title="Pinned">${renderUiIcon("pinned")}</span>` : ""}${esc(displayName)}</div>
    ${metaParts.length > 0 ? `<div class="board-card-meta">${metaParts.join(" · ")}</div>` : ""}
    ${description ? `<div class="board-card-description">${esc(description)}</div>` : ""}`;

  card.addEventListener("click", () => {
    attachSession(session.id, session);
    if (!isDesktop) closeSidebarFn();
  });

  return card;
}

function createSessionBoardScroller(sessionList) {
  const scroller = document.createElement("div");
  scroller.className = "board-scroller";

  const visibleSessions = Array.isArray(sessionList) ? sessionList : [];
  const columns = getSessionBoardColumns(visibleSessions);
  const grouped = new Map(columns.map((column) => [column.key, {
    column,
    sessions: [],
  }]));

  for (const session of visibleSessions) {
    const boardColumn = getSessionBoardColumn(session, visibleSessions);
    const target = grouped.get(boardColumn.key) || grouped.get(columns[0]?.key);
    target?.sessions.push(session);
  }

  for (const { column, sessions: columnSessions } of grouped.values()) {
    columnSessions.sort(compareBoardSessions);
    const highPriorityCount = columnSessions.filter((session) => getSessionBoardPriority(session)?.key === "high").length;
    const columnEl = document.createElement("div");
    columnEl.className = "board-column";
    columnEl.dataset.column = column.key;

    const header = document.createElement("div");
    header.className = "board-column-header";
    header.innerHTML = `
      <span class="board-column-dot"></span>
      <span class="board-column-title" title="${esc(column.title || column.label)}">${esc(column.label)}</span>
      ${highPriorityCount > 0 ? `<span class="board-column-attention">${highPriorityCount} high</span>` : ""}
      <span class="board-column-count">${columnSessions.length}</span>`;

    const body = document.createElement("div");
    body.className = "board-column-body";
    if (columnSessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "board-card-empty";
      empty.textContent = column.emptyText || "No sessions";
      body.appendChild(empty);
    } else {
      for (const session of columnSessions) {
        body.appendChild(createBoardSessionCard(session));
      }
    }

    columnEl.appendChild(header);
    columnEl.appendChild(body);
    scroller.appendChild(columnEl);
  }

  return scroller;
}

function renderSessionBoard() {
  if (!boardPanel) return;
  boardPanel.innerHTML = "";
  const visibleSessions = getActiveSessions().filter((session) => matchesCurrentFilters(session));
  boardPanel.appendChild(createSessionBoardScroller(visibleSessions));
}

function createActiveSessionItem(session) {
  const statusInfo = getSessionMetaStatusInfo(session);
  const completeRead = isSessionCompleteAndReviewed(session);
  const div = document.createElement("div");
  div.className =
    "session-item"
    + (session.pinned ? " pinned" : "")
    + (session.id === currentSessionId ? " active" : "")
    + (completeRead ? " is-complete-read" : "")
    + (statusInfo.itemClass ? ` ${statusInfo.itemClass}` : "");

  const displayName = getSessionDisplayName(session);
  const metaParts = buildSessionMetaParts(session);
  const metaHtml = metaParts.join(" · ");
  const pinTitle = session.pinned ? "Unpin" : "Pin";

  div.innerHTML = `
    <div class="session-item-info">
      <div class="session-item-name">${session.pinned ? `<span class="session-pin-badge" title="Pinned">${renderUiIcon("pinned")}</span>` : ""}${esc(displayName)}</div>
      ${metaHtml ? `<div class="session-item-meta">${metaHtml}</div>` : ""}
    </div>
    <div class="session-item-actions">
      <button class="session-action-btn pin${session.pinned ? " pinned" : ""}" type="button" title="${pinTitle}" aria-label="${pinTitle}" data-id="${session.id}">${renderUiIcon(session.pinned ? "pinned" : "pin")}</button>
      <button class="session-action-btn rename" type="button" title="Rename" aria-label="Rename" data-id="${session.id}">${renderUiIcon("edit")}</button>
      <button class="session-action-btn archive" type="button" title="Archive" aria-label="Archive" data-id="${session.id}">${renderUiIcon("archive")}</button>
    </div>`;

  div.addEventListener("click", (e) => {
    if (e.target.closest(".session-action-btn")) {
      return;
    }
    attachSession(session.id, session);
    if (!isDesktop) closeSidebarFn();
  });

  div.querySelector(".pin").addEventListener("click", (e) => {
    e.stopPropagation();
    dispatchAction({ action: session.pinned ? "unpin" : "pin", sessionId: session.id });
  });

  div.querySelector(".rename").addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(div, session);
  });

  div.querySelector(".archive").addEventListener("click", (e) => {
    e.stopPropagation();
    dispatchAction({ action: "archive", sessionId: session.id });
  });

  return div;
}

