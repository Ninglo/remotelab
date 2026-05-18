function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

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
  return shortFolder.split("/").pop() || shortFolder || t("session.defaultName");
}

function getSessionDisplayName(session) {
  return session?.name || getFolderLabel(session?.folder) || t("session.defaultName");
}

function formatQueuedMessageTimestamp(stamp) {
  if (!stamp) return t("queue.timestamp.default");
  const parsed = new Date(stamp).getTime();
  if (!Number.isFinite(parsed)) return t("queue.timestamp.default");
  return t("queue.timestamp.withTime", { time: messageTimeFormatter.format(parsed) });
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
  title.textContent = items.length === 1
    ? t("queue.single")
    : t("queue.multiple", { count: items.length });

  const note = document.createElement("div");
  note.className = "queued-panel-note";
  const activity = getSessionActivity(session);
  note.textContent = activity.run.state === "running" || activity.compact.state === "pending"
    ? t("queue.note.afterRun")
    : t("queue.note.preparing");

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
    text.textContent = item.text || t("queue.attachmentOnly");

    row.appendChild(meta);
    row.appendChild(text);

    const itemAttachments = Array.isArray(item?.attachments) && item.attachments.length > 0
      ? item.attachments
      : (Array.isArray(item?.images) ? item.images : []);
    const imageNames = itemAttachments.map((image) => getAttachmentDisplayName(image)).filter(Boolean);
    if (imageNames.length > 0) {
      const imageLine = document.createElement("div");
      imageLine.className = "queued-item-images";
      imageLine.textContent = t("queue.attachments", { names: imageNames.join(", ") });
      row.appendChild(imageLine);
    }

    list.appendChild(row);
  }

  queuedPanel.appendChild(list);

  if (items.length > visibleItems.length) {
    const more = document.createElement("div");
    more.className = "queued-panel-more";
    more.textContent = items.length - visibleItems.length === 1
      ? t("queue.olderHidden.one")
      : t("queue.olderHidden.multiple", { count: items.length - visibleItems.length });
    queuedPanel.appendChild(more);
  }
}

function renderSessionMessageCount(session) {
  const count = Number.isInteger(session?.messageCount)
    ? session.messageCount
    : (Number.isInteger(session?.activeMessageCount) ? session.activeMessageCount : 0);
  if (count <= 0) return "";
  const label = t("session.messages", { count, suffix: count === 1 ? "" : "s" });
  return `<span class="session-item-count" title="${esc(t("session.messagesTitle"))}">${esc(label)}</span>`;
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

function renderSessionScopeContext(session) {
  const parts = [];
  const sourceName = typeof getEffectiveSessionSourceName === "function"
    ? getEffectiveSessionSourceName(session)
    : "";
  if (sourceName) {
    parts.push(`<span title="${esc(t("session.scope.source"))}">${esc(sourceName)}</span>`);
  }

  return parts;
}

function getFilteredSessionEmptyText({ archived = false } = {}) {
  if (archived) return t("sidebar.noArchived");
  if (activeSourceFilter !== FILTER_ALL_VALUE) {
    return t("sidebar.noSessionsFiltered");
  }
  return t("sidebar.noSessions");
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

let _activeContextMenu = null;

function closeSessionContextMenu() {
  if (!_activeContextMenu) return;
  _activeContextMenu.remove();
  _activeContextMenu = null;
  document.removeEventListener("pointerdown", _ctxOutsideHandler, true);
  document.removeEventListener("keydown", _ctxKeyHandler, true);
}

function _ctxOutsideHandler(e) {
  if (_activeContextMenu && !_activeContextMenu.contains(e.target)) {
    closeSessionContextMenu();
  }
}

function _ctxKeyHandler(e) {
  if (e.key === "Escape") closeSessionContextMenu();
}

function openSessionContextMenu(session, anchorEl, renameWrapper) {
  closeSessionContextMenu();

  const menu = document.createElement("div");
  menu.className = "session-context-menu";

  const pinLabel = session.pinned ? t("action.unpin") : t("action.pin");
  const pinIcon = renderUiIcon(session.pinned ? "pinned" : "pin");
  const renameLabel = t("action.rename");
  const archiveLabel = t("action.archive");

  menu.innerHTML = `
    <button class="session-context-menu-item" type="button" data-action="pin">${pinIcon}<span>${esc(pinLabel)}</span></button>
    <button class="session-context-menu-item" type="button" data-action="rename">${renderUiIcon("edit")}<span>${esc(renameLabel)}</span></button>
    <button class="session-context-menu-item danger" type="button" data-action="archive">${renderUiIcon("archive")}<span>${esc(archiveLabel)}</span></button>`;

  // Wire actions
  menu.querySelector('[data-action="pin"]').addEventListener("click", () => {
    dispatchAction({ action: session.pinned ? "unpin" : "pin", sessionId: session.id });
    closeSessionContextMenu();
  });
  menu.querySelector('[data-action="rename"]').addEventListener("click", () => {
    closeSessionContextMenu();
    const itemEl = anchorEl.closest ? anchorEl : anchorEl.parentElement;
    startRename(itemEl, session);
  });
  menu.querySelector('[data-action="archive"]').addEventListener("click", () => {
    dispatchAction({ action: "archive", sessionId: session.id });
    closeSessionContextMenu();
  });

  // Position: fixed, to the right of the anchor
  document.body.appendChild(menu);
  _activeContextMenu = menu;

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const gap = 4;
  let left = rect.right + gap;
  let top = rect.top;

  // Flip left if not enough space on the right
  if (left + menuRect.width > window.innerWidth - 8) {
    left = rect.left - menuRect.width - gap;
  }
  // Clamp left
  if (left < 8) left = 8;
  // Clamp top
  if (top + menuRect.height > window.innerHeight - 8) {
    top = window.innerHeight - menuRect.height - 8;
  }
  if (top < 8) top = 8;

  menu.style.left = left + "px";
  menu.style.top = top + "px";

  document.addEventListener("pointerdown", _ctxOutsideHandler, true);
  document.addEventListener("keydown", _ctxKeyHandler, true);
}

function createActiveSessionItem(session, { showGroup = false } = {}) {
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

  // In inbox view, show the group as a tag in meta
  if (showGroup) {
    const groupName = typeof session?.group === "string" ? session.group.trim() : "";
    if (groupName) {
      metaParts.push(`<span class="session-group-tag" title="${esc(groupName)}">${esc(groupName)}</span>`);
    }
  }

  const metaHtml = metaParts.join(" · ");

  // Show description as a second line when available
  const description = typeof session?.description === "string" ? session.description.trim() : "";
  const descriptionHtml = description
    ? `<div class="session-item-description" title="${esc(description)}">${esc(description)}</div>`
    : "";

  div.innerHTML = `
    <div class="session-item-info">
      <div class="session-item-name">${session.pinned ? `<span class="session-pin-badge" title="${esc(t("sidebar.pinned"))}">${renderUiIcon("pinned")}</span>` : ""}${esc(displayName)}</div>
      ${metaHtml ? `<div class="session-item-meta">${metaHtml}</div>` : ""}
      ${descriptionHtml}
    </div>`;

  // Click to attach session
  div.addEventListener("click", (e) => {
    attachSession(session.id, session);
    if (!isDesktop) closeSidebarFn();
  });

  // Long-press detection for context menu
  let longPressTimer = null;
  let longPressStartX = 0;
  let longPressStartY = 0;

  div.addEventListener("pointerdown", (e) => {
    if (e.button && e.button !== 0) return; // only primary button
    longPressStartX = e.clientX;
    longPressStartY = e.clientY;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      e.preventDefault();
      openSessionContextMenu(session, div);
    }, 500);
  });

  div.addEventListener("pointermove", (e) => {
    if (!longPressTimer) return;
    const dx = e.clientX - longPressStartX;
    const dy = e.clientY - longPressStartY;
    if (dx * dx + dy * dy > 25) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  const cancelLongPress = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };
  div.addEventListener("pointerup", cancelLongPress);
  div.addEventListener("pointerleave", cancelLongPress);
  div.addEventListener("pointercancel", cancelLongPress);

  // Right-click context menu (desktop)
  div.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openSessionContextMenu(session, div);
  });

  return div;
}
