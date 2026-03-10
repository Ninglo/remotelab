// ---- Render functions ----
function renderMessage(evt) {
  const role = evt.role || "assistant";

  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }

  if (role === "user") {
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    const bubble = document.createElement("div");
    bubble.className = "msg-user-bubble";
    if (evt.images && evt.images.length > 0) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "msg-images";
      for (const img of evt.images) {
        const imgEl = document.createElement("img");
        imgEl.src = `/api/images/${img.filename}`;
        imgEl.alt = "attached image";
        imgEl.loading = "lazy";
        imgEl.onclick = () => window.open(imgEl.src, "_blank");
        imgWrap.appendChild(imgEl);
      }
      bubble.appendChild(imgWrap);
    }
    if (evt.content) {
      const span = document.createElement("span");
      span.textContent = formatDecodedDisplayText(evt.content);
      bubble.appendChild(span);
    }
    appendMessageTimestamp(bubble, evt.timestamp, "msg-user-time");
    wrap.appendChild(bubble);
    messagesInner.appendChild(wrap);
  } else {
    const div = document.createElement("div");
    div.className = "msg-assistant md-content";
    if (evt.content) {
      const rendered = marked.parse(evt.content);
      if (!rendered.trim()) return;
      div.innerHTML = rendered;
      enhanceCodeBlocks(div);
    }
    appendMessageTimestamp(div, evt.timestamp, "msg-assistant-time");
    messagesInner.appendChild(div);
  }
}

function renderToolUse(evt) {
  const container = getThinkingBody();
  if (currentThinkingBlock && evt.toolName) {
    currentThinkingBlock.tools.add(evt.toolName);
  }

  const card = document.createElement("div");
  card.className = "tool-card";

  const header = document.createElement("div");
  header.className = "tool-header";
  header.innerHTML = `<span class="tool-name">${esc(evt.toolName || "tool")}</span>
    <span class="tool-toggle">&#9654;</span>`;

  const body = document.createElement("div");
  body.className = "tool-body";
  body.id = "tool_" + evt.id;
  const pre = document.createElement("pre");
  pre.textContent = evt.toolInput || (evt.bodyAvailable ? "Load command…" : "");
  if (evt.bodyAvailable && !evt.bodyLoaded) {
    pre.dataset.eventSeq = String(evt.seq || "");
    pre.dataset.bodyPending = "true";
    pre.dataset.preview = evt.toolInput || "";
  }
  body.appendChild(pre);

  header.addEventListener("click", async () => {
    header.classList.toggle("expanded");
    body.classList.toggle("expanded");
    if (body.classList.contains("expanded")) {
      await hydrateLazyNodes(body);
    }
  });

  card.appendChild(header);
  card.appendChild(body);
  card.dataset.toolId = evt.id;
  container.appendChild(card);
}

function renderToolResult(evt) {
  // Search in current thinking block body, or fall back to messagesInner
  const searchRoot =
    inThinkingBlock && currentThinkingBlock
      ? currentThinkingBlock.body
      : messagesInner;

  const cards = searchRoot.querySelectorAll(".tool-card");
  let targetCard = null;
  for (let i = cards.length - 1; i >= 0; i--) {
    if (!cards[i].querySelector(".tool-result")) {
      targetCard = cards[i];
      break;
    }
  }

  if (targetCard) {
    const body = targetCard.querySelector(".tool-body");
    const label = document.createElement("div");
    label.className = "tool-result-label";
    label.innerHTML =
      "Result" +
      (evt.exitCode !== undefined
        ? `<span class="exit-code ${evt.exitCode === 0 ? "ok" : "fail"}">${evt.exitCode === 0 ? "exit 0" : "exit " + evt.exitCode}</span>`
        : "");
    const pre = document.createElement("pre");
    pre.className = "tool-result";
    pre.textContent = evt.output || (evt.bodyAvailable ? "Load result…" : "");
    if (evt.bodyAvailable && !evt.bodyLoaded) {
      pre.dataset.eventSeq = String(evt.seq || "");
      pre.dataset.bodyPending = "true";
      pre.dataset.preview = evt.output || "";
    }
    body.appendChild(label);
    body.appendChild(pre);
  }
}

function renderFileChange(evt) {
  const container = getThinkingBody();
  const div = document.createElement("div");
  div.className = "file-card";
  const kind = evt.changeType || "edit";
  div.innerHTML = `<span class="file-path">${esc(evt.filePath || "")}</span>
    <span class="change-type ${kind}">${kind}</span>`;
  container.appendChild(div);
}

function renderReasoning(evt) {
  const container = getThinkingBody();
  const div = document.createElement("div");
  div.className = "reasoning";
  div.textContent = evt.content || (evt.bodyAvailable ? "Load thinking…" : "");
  if (evt.bodyAvailable && !evt.bodyLoaded) {
    div.dataset.eventSeq = String(evt.seq || "");
    div.dataset.bodyPending = "true";
    div.dataset.preview = evt.content || "";
  }
  container.appendChild(div);
}

function renderStatusMsg(evt) {
  // Finalize thinking block when the AI turn ends (completed/error)
  if (inThinkingBlock && evt.content !== "thinking") {
    finalizeThinkingBlock();
  }
  if (
    !evt.content ||
    evt.content === "completed" ||
    evt.content === "thinking"
  )
    return;
  const div = document.createElement("div");
  div.className = "msg-system";
  div.textContent = evt.content;
  messagesInner.appendChild(div);
}

function formatCompactTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  return `${Math.round(n / 1000)}K`;
}

function getContextTokens(evt) {
  if (Number.isFinite(evt?.contextTokens)) return evt.contextTokens;
  return 0;
}

function getContextWindowTokens(evt) {
  if (Number.isFinite(evt?.contextWindowTokens)) return evt.contextWindowTokens;
  return 0;
}

function getContextPercent(contextSize, contextWindowSize) {
  if (!(contextSize > 0) || !(contextWindowSize > 0)) return null;
  return (contextSize / contextWindowSize) * 100;
}

function formatContextPercent(percent, { precise = false } = {}) {
  if (!Number.isFinite(percent)) return "";
  if (precise) {
    return `${percent.toFixed(1)}%`;
  }
  return `${Math.round(percent)}%`;
}

function updateContextDisplay(contextSize, contextWindowSize) {
  currentTokens = contextSize;
  if (contextSize > 0 && currentSessionId) {
    const percent = getContextPercent(contextSize, contextWindowSize);
    contextTokens.textContent = percent !== null
      ? `${formatCompactTokens(contextSize)} live · ${formatContextPercent(percent)}`
      : `${formatCompactTokens(contextSize)} live`;
    contextTokens.title = percent !== null
      ? `Live context: ${contextSize.toLocaleString()} / ${contextWindowSize.toLocaleString()} (${formatContextPercent(percent, { precise: true })})`
      : `Live context: ${contextSize.toLocaleString()}`;
    contextTokens.style.display = "";
    compactBtn.style.display = "";
    dropToolsBtn.style.display = "";
  }
}

function renderUsage(evt) {
  const contextSize = getContextTokens(evt);
  if (!(contextSize > 0)) return;
  const contextWindowSize = getContextWindowTokens(evt);
  const percent = getContextPercent(contextSize, contextWindowSize);
  const output = evt.outputTokens || 0;
  const div = document.createElement("div");
  div.className = "usage-info";
  const parts = [`${formatCompactTokens(contextSize)} live context`];
  if (percent !== null) parts.push(`${formatContextPercent(percent, { precise: true })} window`);
  if (output > 0) parts.push(`${formatCompactTokens(output)} out`);
  div.textContent = parts.join(" · ");
  const hover = [`Live context: ${contextSize.toLocaleString()}`];
  if (contextWindowSize > 0) hover.push(`Context window: ${contextWindowSize.toLocaleString()}`);
  if (Number.isFinite(evt?.inputTokens) && evt.inputTokens !== contextSize) {
    hover.push(`Raw turn input: ${evt.inputTokens.toLocaleString()}`);
  }
  if (output > 0) hover.push(`Turn output: ${output.toLocaleString()}`);
  div.title = hover.join("\n");
  messagesInner.appendChild(div);
  updateContextDisplay(contextSize, contextWindowSize);
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
  return shortFolder.split("/").pop() || shortFolder || "Session";
}

function getSessionDisplayName(session) {
  return session?.name || getFolderLabel(session?.folder) || "Session";
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

// ---- Session list ----
function renderSessionList() {
  sessionList.innerHTML = "";

  const groups = new Map();
  for (const s of getActiveSessions()) {
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
    header.innerHTML = `<span class="folder-chevron">&#9660;</span>
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
      const div = document.createElement("div");
      div.className =
        "session-item" + (s.id === currentSessionId ? " active" : "");

      const displayName = getSessionDisplayName(s);
      const metaParts = [];
      if (s.name && s.tool) metaParts.push(s.tool);
      if (s.status === "running") metaParts.push("●&nbsp;running");
      const renameReason = s.renameError ? ` title="${esc(s.renameError)}"` : "";
      const metaHtml = s.status === "done" || finishedUnread.has(s.id)
        ? `<span class="status-done">● done</span>`
        : s.renameState === "pending"
        ? `<span class="status-renaming">● renaming</span>`
        : s.renameState === "failed"
          ? `<span class="status-rename-failed"${renameReason}>● rename failed</span>`
        : s.status === "running"
          ? `<span class="status-running">● running</span>`
          : s.status === "interrupted"
            ? `<span class="status-interrupted">● interrupted</span>`
          : s.tool && s.name
            ? `<span>${esc(s.tool)}</span>`
            : "";

      div.innerHTML = `
        <div class="session-item-info">
          <div class="session-item-name">${esc(displayName)}</div>
          <div class="session-item-meta">${metaHtml}</div>
        </div>
        <div class="session-item-actions">
          <button class="session-action-btn rename" title="Rename" data-id="${s.id}">&#9998;</button>
          <button class="session-action-btn archive" title="Archive" data-id="${s.id}">&#8615;</button>
        </div>`;

      div.addEventListener("click", (e) => {
        if (
          e.target.classList.contains("rename") ||
          e.target.classList.contains("archive")
        )
          return;
        attachSession(s.id, s);
        if (!isDesktop) closeSidebarFn();
      });

      div.querySelector(".rename").addEventListener("click", (e) => {
        e.stopPropagation();
        startRename(div, s);
      });

      div.querySelector(".archive").addEventListener("click", (e) => {
        e.stopPropagation();
        dispatchAction({ action: "archive", sessionId: s.id });
      });

      items.appendChild(div);
    }

    group.appendChild(header);
    group.appendChild(items);
    sessionList.appendChild(group);
  }

  renderArchivedSection();
}

function renderArchivedSection() {
  const archivedSessions = getArchivedSessions();
  const existing = document.getElementById("archivedSection");
  if (existing) existing.remove();

  const section = document.createElement("div");
  section.id = "archivedSection";
  section.className = "archived-section";

  const header = document.createElement("div");
  header.className = "archived-section-header";
  const isCollapsed = localStorage.getItem("archivedCollapsed") !== "false";
  if (isCollapsed) header.classList.add("collapsed");
  header.innerHTML = `<span class="folder-chevron">&#9660;</span><span class="archived-label">Archive</span><span class="folder-count">${archivedSessions.length}</span>`;
  header.addEventListener("click", () => {
    header.classList.toggle("collapsed");
    localStorage.setItem("archivedCollapsed", header.classList.contains("collapsed") ? "true" : "false");
  });

  const items = document.createElement("div");
  items.className = "archived-items";

  if (archivedSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "archived-empty";
    empty.textContent = "No archived sessions";
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
          <button class="session-action-btn restore" title="Restore" data-id="${s.id}">&#8617;</button>
        </div>`;
      div.addEventListener("click", (e) => {
        if (e.target.classList.contains("restore")) return;
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

function attachSession(id, session) {
  const shouldReattach = !hasAttachedSession || currentSessionId !== id;
  if (shouldReattach) {
    clearMessages();
    dispatchAction({ action: "attach", sessionId: id });
  }
  applyAttachedSessionState(id, session);
  msgInput.focus();
}

// ---- Sidebar ----
function openSidebar() {
  sidebarOverlay.classList.add("open");
}
function closeSidebarFn() {
  sidebarOverlay.classList.remove("open");
}

menuBtn.addEventListener("click", openSidebar);
closeSidebar.addEventListener("click", closeSidebarFn);
sidebarOverlay.addEventListener("click", (e) => {
  if (e.target === sidebarOverlay && !isDesktop) closeSidebarFn();
});

// Clear "done" badge when user returns to tab (read-receipt semantics)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentSessionId && finishedUnread.delete(currentSessionId)) {
    renderSessionList();
  }
});

// ---- New Session ----
newSessionBtn.addEventListener("click", () => {
  if (!isDesktop) closeSidebarFn();
  const tool = preferredTool || selectedTool || toolsList[0]?.id;
  if (!tool) return;
  dispatchAction({ action: "create", folder: "~", tool });
});

// ---- Image handling ----
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      resolve({
        data: base64,
        mimeType: file.type || "image/png",
        objectUrl: URL.createObjectURL(file),
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (pendingImages.length >= 4) break;
    pendingImages.push(await fileToBase64(file));
  }
  renderImagePreviews();
}

function renderImagePreviews() {
  imgPreviewStrip.innerHTML = "";
  if (pendingImages.length === 0) {
    imgPreviewStrip.classList.remove("has-images");
    return;
  }
  imgPreviewStrip.classList.add("has-images");
  pendingImages.forEach((img, i) => {
    const item = document.createElement("div");
    item.className = "img-preview-item";
    const imgEl = document.createElement("img");
    imgEl.src = img.objectUrl;
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-img";
    removeBtn.innerHTML = "&times;";
    removeBtn.onclick = () => {
      URL.revokeObjectURL(img.objectUrl);
      pendingImages.splice(i, 1);
      renderImagePreviews();
    };
    item.appendChild(imgEl);
    item.appendChild(removeBtn);
    imgPreviewStrip.appendChild(item);
  });
}

imgBtn.addEventListener("click", () => imgFileInput.click());
imgFileInput.addEventListener("change", () => {
  if (imgFileInput.files.length > 0) addImageFiles(imgFileInput.files);
  imgFileInput.value = "";
});

msgInput.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageFiles = [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
  }
  if (imageFiles.length > 0) {
    e.preventDefault();
    addImageFiles(imageFiles);
  }
});

