function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

function resolveUiProductPath(path) {
  if (typeof window.remotelabResolveProductPath === "function") {
    return window.remotelabResolveProductPath(path);
  }
  return typeof path === "string" ? path : String(path || "");
}

function formatFileChangeTypeLabel(kind) {
  switch (kind) {
    case "add":
      return t("ui.fileChange.add");
    case "edit":
      return t("ui.fileChange.edit");
    case "update":
      return t("ui.fileChange.update");
    case "updated":
      return t("ui.fileChange.updated");
    case "delete":
      return t("ui.fileChange.delete");
    default:
      return kind;
  }
}

function renderUiIcon(name, className = "") {
  return window.RemoteLabIcons?.render(name, { className }) || "";
}

const replySelfCheckDrawerByContainer = new WeakMap();

function renderMarkdownIntoNode(node, markdown) {
  const source = typeof markdown === "string" ? markdown : "";
  const visibleSource = formatDecodedDisplayText(source);
  const rendered = marked.parse(visibleSource);
  if (rendered.trim()) {
    node.innerHTML = rendered;
    enhanceCodeBlocks(node);
    enhanceRenderedContentLinks(node);
    return true;
  }
  node.textContent = visibleSource;
  return !!visibleSource.trim();
}

function markLazyEventBodyNode(node, evt, { preview = "", renderMode = "text" } = {}) {
  if (!node || !evt?.bodyAvailable || evt.bodyLoaded) return false;
  if (!Number.isInteger(evt.seq) || evt.seq < 1) return false;
  node.dataset.eventSeq = String(evt.seq);
  node.dataset.bodyPending = "true";
  node.dataset.bodyRender = renderMode;
  const resolvedPreview = typeof preview === "string" && preview
    ? preview
    : (evt.bodyPreview || "");
  if (resolvedPreview) {
    node.dataset.preview = resolvedPreview;
  } else {
    delete node.dataset.preview;
  }
  return true;
}

function getAttachmentDisplayName(attachment) {
  const originalName = typeof attachment?.originalName === "string"
    ? attachment.originalName.trim()
    : "";
  if (originalName) return originalName;
  const filename = typeof attachment?.filename === "string"
    ? attachment.filename.trim()
    : "";
  return filename || "attachment";
}

function getAttachmentKind(attachment) {
  const mimeType = typeof attachment?.mimeType === "string"
    ? attachment.mimeType
    : "";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function getAttachmentSource(attachment) {
  if (typeof attachment?.objectUrl === "string" && attachment.objectUrl) {
    return attachment.objectUrl;
  }
  if (typeof attachment?.downloadUrl === "string" && attachment.downloadUrl) {
    return attachment.downloadUrl;
  }
  if (typeof attachment?.url === "string" && attachment.url) {
    return attachment.url;
  }
  if (typeof attachment?.assetId === "string" && attachment.assetId) {
    return resolveUiProductPath(`/api/assets/${encodeURIComponent(attachment.assetId)}/download`);
  }
  if (typeof attachment?.filename === "string" && attachment.filename) {
    return resolveUiProductPath(`/api/media/${encodeURIComponent(attachment.filename)}`);
  }
  return "";
}

function getAttachmentDownloadSource(attachment) {
  const downloadUrl = typeof attachment?.downloadUrl === "string"
    ? attachment.downloadUrl.trim()
    : "";
  if (downloadUrl) {
    if (!/^(?:\/(?:api\/assets\/[^/]+\/download|share-asset\/[^/]+\/[^/?#]+)|(?:\.\.\/)?share-asset\/[^/]+\/[^/?#]+)(?:[?#]|$)/.test(downloadUrl)) {
      return downloadUrl;
    }
    if (/[?&]download=1(?:&|$)/.test(downloadUrl)) {
      return downloadUrl;
    }
    return downloadUrl.includes("?") ? `${downloadUrl}&download=1` : `${downloadUrl}?download=1`;
  }
  const shareUrl = typeof attachment?.url === "string"
    ? attachment.url.trim()
    : "";
  if (shareUrl) {
    if (!/^(?:\/share-asset\/[^/]+\/[^/?#]+|(?:\.\.\/)?share-asset\/[^/]+\/[^/?#]+)(?:[?#]|$)/.test(shareUrl)) {
      return shareUrl;
    }
    if (/[?&]download=1(?:&|$)/.test(shareUrl)) {
      return shareUrl;
    }
    return shareUrl.includes("?") ? `${shareUrl}&download=1` : `${shareUrl}?download=1`;
  }
  const assetId = typeof attachment?.assetId === "string"
    ? attachment.assetId.trim()
    : "";
  if (assetId) {
    return resolveUiProductPath(`/api/assets/${encodeURIComponent(assetId)}/download?download=1`);
  }
  return getAttachmentSource(attachment);
}

function getAttachmentTypeLabel(attachment) {
  const displayName = getAttachmentDisplayName(attachment);
  const lastDot = displayName.lastIndexOf(".");
  const extension = lastDot >= 0 ? displayName.slice(lastDot + 1).trim() : "";
  const normalizedExtension = extension.replace(/[^a-z0-9]+/gi, "").toUpperCase();
  if (normalizedExtension) return normalizedExtension.slice(0, 8);
  const kind = getAttachmentKind(attachment);
  if (kind === "audio") return "AUDIO";
  if (kind === "video") return "VIDEO";
  if (kind === "image") return "IMAGE";
  return "FILE";
}

function normalizeAttachmentSizeBytes(attachment) {
  const numeric = Number.parseInt(String(attachment?.sizeBytes || ""), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function formatAttachmentSize(sizeBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return "";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded} ${units[unitIndex]}`;
}

function shouldRenderAttachmentAsFileCard(attachment) {
  return attachment?.renderAs === "file" || getAttachmentKind(attachment) === "file";
}

function createAttachmentFileNode(attachment, { compact = false } = {}) {
  const label = getAttachmentDisplayName(attachment);
  const sizeLabel = formatAttachmentSize(normalizeAttachmentSizeBytes(attachment));
  const fileEl = document.createElement("div");
  fileEl.className = compact ? "attachment-file attachment-file-compact" : "attachment-file";
  fileEl.title = label;

  const iconEl = document.createElement("div");
  iconEl.className = "attachment-file-icon";
  iconEl.innerHTML = renderUiIcon("file");

  const metaEl = document.createElement("div");
  metaEl.className = "attachment-file-meta";

  const nameEl = document.createElement("div");
  nameEl.className = "attachment-file-name";
  nameEl.textContent = label;

  const typeEl = document.createElement("div");
  typeEl.className = "attachment-file-type";
  typeEl.textContent = sizeLabel
    ? `${getAttachmentTypeLabel(attachment)} · ${sizeLabel}`
    : getAttachmentTypeLabel(attachment);

  metaEl.appendChild(nameEl);
  metaEl.appendChild(typeEl);
  fileEl.appendChild(iconEl);
  fileEl.appendChild(metaEl);
  return fileEl;
}

function createMessageAttachmentNode(attachment) {
  const source = getAttachmentSource(attachment);
  if (!source) return null;
  const kind = getAttachmentKind(attachment);
  const label = getAttachmentDisplayName(attachment);
  const downloadSource = getAttachmentDownloadSource(attachment) || source;
  const renderAsFileCard = shouldRenderAttachmentAsFileCard(attachment);

  if (!renderAsFileCard && kind === "image") {
    const imgEl = document.createElement("img");
    imgEl.src = source;
    imgEl.alt = label;
    imgEl.loading = "lazy";
    imgEl.onclick = () => window.open(source, "_blank");
    return imgEl;
  }

  if (!renderAsFileCard && kind === "video") {
    const videoEl = document.createElement("video");
    videoEl.src = source;
    videoEl.controls = true;
    videoEl.preload = "metadata";
    videoEl.playsInline = true;
    return videoEl;
  }

  if (!renderAsFileCard && kind === "audio") {
    const audioEl = document.createElement("audio");
    audioEl.src = source;
    audioEl.controls = true;
    audioEl.preload = "metadata";
    return audioEl;
  }

  const card = document.createElement("div");
  card.className = "attachment-card attachment-card-row";
  card.title = label;
  card.appendChild(createAttachmentFileNode(attachment));

  const downloadLink = document.createElement("a");
  const downloadLabel = typeof t === "function" ? t("action.download") : "Download";
  downloadLink.href = downloadSource;
  downloadLink.target = "_blank";
  downloadLink.rel = "noopener noreferrer";
  downloadLink.className = "attachment-download-btn";
  downloadLink.title = `${downloadLabel}: ${label}`;
  downloadLink.download = label;
  downloadLink.textContent = downloadLabel;

  card.appendChild(downloadLink);
  return card;
}

function createComposerAttachmentPreviewNode(attachment) {
  const source = getAttachmentSource(attachment);
  if (!source) return null;
  const kind = getAttachmentKind(attachment);
  if (kind === "image") {
    const imgEl = document.createElement("img");
    imgEl.src = source;
    imgEl.alt = getAttachmentDisplayName(attachment);
    return imgEl;
  }
  if (kind === "video") {
    const videoEl = document.createElement("video");
    videoEl.src = source;
    videoEl.muted = true;
    videoEl.preload = "metadata";
    videoEl.playsInline = true;
    return videoEl;
  }
  return createAttachmentFileNode(attachment, { compact: true });
}

// ---- Render functions ----
function renderMessageInto(container, evt, { finalizeActiveThinkingBlock = false } = {}) {
  if (!container) return null;
  const role = evt.role || "assistant";

  if (finalizeActiveThinkingBlock && inThinkingBlock) {
    finalizeThinkingBlock();
  }

  if (role === "user") {
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    const bubble = document.createElement("div");
    bubble.className = "msg-user-bubble";
    const userAttachments = Array.isArray(evt.attachments) && evt.attachments.length > 0
      ? evt.attachments
      : (Array.isArray(evt.images) ? evt.images : []);
    if (userAttachments.length > 0) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "msg-images";
      for (const img of userAttachments) {
        const attachmentNode = createMessageAttachmentNode(img);
        if (!attachmentNode) continue;
        imgWrap.appendChild(attachmentNode);
      }
      bubble.appendChild(imgWrap);
    }
    if (evt.content || evt.bodyAvailable) {
      const span = document.createElement("span");
      const preview = evt.content || evt.bodyPreview || "";
      span.textContent = formatDecodedDisplayText(preview);
      bubble.appendChild(span);
      if (markLazyEventBodyNode(span, evt, {
        preview: evt.bodyPreview || evt.content || "",
        renderMode: "text",
      })) {
        if (typeof queueHydrateLazyNodes === "function") {
          queueHydrateLazyNodes(wrap);
        }
      }
    }
    appendMessageTimestamp(bubble, evt.timestamp, "msg-user-time");
    wrap.appendChild(bubble);
    container.appendChild(wrap);
    return wrap;
  } else {
    const div = document.createElement("div");
    div.className = "msg-assistant md-content";
    const assistantAttachments = Array.isArray(evt.attachments) && evt.attachments.length > 0
      ? evt.attachments
      : (Array.isArray(evt.images) ? evt.images : []);
    const hasAttachments = assistantAttachments.length > 0;
    if (!evt.content && !evt.bodyAvailable && !hasAttachments) {
      return null;
    }

    if (evt.content || evt.bodyAvailable) {
      const content = document.createElement("div");
      content.className = "msg-assistant-body";
      let shouldAppendContent = false;
      if (evt.content) {
        const didRender = renderMarkdownIntoNode(content, evt.content);
        if (didRender) {
          shouldAppendContent = true;
        } else if (!hasAttachments) {
          return null;
        }
      } else if (evt.bodyAvailable) {
        if (evt.bodyPreview) {
          renderMarkdownIntoNode(content, evt.bodyPreview);
        }
        shouldAppendContent = true;
      }
      if (shouldAppendContent) {
        div.appendChild(content);
      }
      if (markLazyEventBodyNode(content, evt, {
        preview: evt.bodyPreview || "",
        renderMode: "markdown",
      })) {
        if (typeof queueHydrateLazyNodes === "function") {
          queueHydrateLazyNodes(div);
        }
      }
    }

    if (hasAttachments) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "msg-images";
      for (const img of assistantAttachments) {
        const attachmentNode = createMessageAttachmentNode(img);
        if (!attachmentNode) continue;
        imgWrap.appendChild(attachmentNode);
      }
      if (imgWrap.children.length > 0) {
        div.appendChild(imgWrap);
      }
    }

    if (div.children.length === 0) {
      return null;
    }
    appendMessageTimestamp(div, evt.timestamp, "msg-assistant-time");
    container.appendChild(div);
    return div;
  }
}

function renderMessage(evt) {
  return renderMessageInto(messagesInner, evt, {
    finalizeActiveThinkingBlock: true,
  });
}

function createToolCard(evt) {
  const card = document.createElement("div");
  card.className = "tool-card";

  const header = document.createElement("div");
  header.className = "tool-header";
  header.innerHTML = `<span class="tool-name">${esc(evt.toolName || t("ui.toolFallback"))}</span>
    <span class="tool-toggle">${renderUiIcon("chevron-right")}</span>`;

  const body = document.createElement("div");
  body.className = "tool-body";
  body.id = "tool_" + evt.id;
  const pre = document.createElement("pre");
  pre.textContent = evt.toolInput || "";
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
  return { card, body };
}

function findLatestPendingToolCard(root) {
  const cards = root?.querySelectorAll?.(".tool-card") || [];
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    if (!cards[index].querySelector(".tool-result")) {
      return cards[index];
    }
  }
  return null;
}

function renderToolUseInto(container, evt, { toolTracker = null } = {}) {
  if (!container) return null;
  if (toolTracker && evt.toolName) {
    toolTracker.add(evt.toolName);
  }
  const { card } = createToolCard(evt);
  container.appendChild(card);
  return card;
}

function renderToolResultInto(container, evt) {
  const targetCard = findLatestPendingToolCard(container);
  if (!targetCard) return null;

  const body = targetCard.querySelector(".tool-body");
  if (!body) return null;

  const label = document.createElement("div");
  label.className = "tool-result-label";
  label.innerHTML =
    esc(t("ui.toolResult")) +
    (evt.exitCode !== undefined
      ? `<span class="exit-code ${evt.exitCode === 0 ? "ok" : "fail"}">${esc(t("ui.toolExitCode", { code: evt.exitCode }))}</span>`
      : "");
  const pre = document.createElement("pre");
  pre.className = "tool-result";
  pre.textContent = evt.output || "";
  if (evt.bodyAvailable && !evt.bodyLoaded) {
    pre.dataset.eventSeq = String(evt.seq || "");
    pre.dataset.bodyPending = "true";
    pre.dataset.preview = evt.output || "";
  }
  body.appendChild(label);
  body.appendChild(pre);
  return targetCard;
}

function renderFileChangeInto(container, evt) {
  if (!container) return null;
  const div = document.createElement("div");
  div.className = "file-card";
  const kind = evt.changeType || "edit";
  const filePath = evt.filePath || "";
  const pathMarkup = `<span class="file-path">${esc(filePath)}</span>`;
  const changeLabel = formatFileChangeTypeLabel(kind);
  div.innerHTML = `${pathMarkup}
    <span class="change-type ${kind}">${esc(changeLabel)}</span>`;
  container.appendChild(div);
  return div;
}

function renderReasoningInto(container, evt) {
  if (!container) return null;
  const div = document.createElement("div");
  div.className = "reasoning md-content";
  if (evt.content) {
    const didRender = renderMarkdownIntoNode(div, evt.content);
    if (!didRender && !evt.bodyAvailable) return null;
  } else if (evt.bodyAvailable && evt.bodyPreview) {
    renderMarkdownIntoNode(div, evt.bodyPreview);
  } else if (!evt.bodyAvailable) {
    return null;
  }
  if (markLazyEventBodyNode(div, evt, {
    preview: evt.bodyPreview || evt.content || "",
    renderMode: "markdown",
  })) {
    if (typeof queueHydrateLazyNodes === "function") {
      queueHydrateLazyNodes(div);
    }
  }
  container.appendChild(div);
  return div;
}

function renderManagerContextInto(container, evt) {
  if (!container) return null;
  const wrap = document.createElement("div");
  wrap.className = "manager-context";

  const label = document.createElement("div");
  label.className = "msg-system";
  label.textContent = t("ui.managerContext");
  wrap.appendChild(label);

  const body = document.createElement("div");
  body.className = "reasoning md-content";
  if (evt.content) {
    const didRender = renderMarkdownIntoNode(body, evt.content);
    if (!didRender && !evt.bodyAvailable) return null;
  } else if (evt.bodyAvailable && evt.bodyPreview) {
    renderMarkdownIntoNode(body, evt.bodyPreview);
  } else if (!evt.bodyAvailable) {
    return null;
  }

  if (markLazyEventBodyNode(body, evt, {
    preview: evt.bodyPreview || evt.content || "",
    renderMode: "markdown",
  })) {
    if (typeof queueHydrateLazyNodes === "function") {
      queueHydrateLazyNodes(wrap);
    }
  }

  wrap.appendChild(body);
  container.appendChild(wrap);
  return wrap;
}

function collectHiddenBlockToolNames(events) {
  const names = [];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== "tool_use") continue;
    const name = typeof event?.toolName === "string" ? event.toolName.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function formatToolListLabel(names, max) {
  if (names.length <= max) return names.join(", ");
  return names.slice(0, max).join(", ") + ` +${names.length - max}`;
}

function buildLoadedHiddenBlockLabel(events) {
  const toolNames = collectHiddenBlockToolNames(events);
  if (toolNames.length > 0) {
    return t("thinking.usedTools", { tools: formatToolListLabel(toolNames, 3) });
  }
  return t("thinking.done");
}

function createDeferredThinkingBlock(label, { collapsed = true } = {}) {
  const block = document.createElement("div");
  block.className = `thinking-block${collapsed ? " collapsed" : ""}`;

  const header = document.createElement("div");
  header.className = "thinking-header";
  header.innerHTML = `${renderUiIcon("gear", "thinking-icon")}
    <span class="thinking-label">${esc(label || t("thinking.active"))}</span>
    <span class="thinking-chevron">${renderUiIcon("chevron-down")}</span>`;

  const body = document.createElement("div");
  body.className = "thinking-body";

  block.appendChild(header);
  block.appendChild(body);
  return {
    block,
    header,
    body,
    label: header.querySelector(".thinking-label"),
  };
}

function parseEventBlockSeq(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function getRenderedEventBlockStartSeq(body) {
  if (!body) return 0;
  return parseEventBlockSeq(body.dataset.renderedBlockStartSeq);
}

function getRenderedEventBlockEndSeq(body) {
  if (!body) return 0;
  return parseEventBlockSeq(body.dataset.renderedBlockEndSeq);
}

function setRenderedEventBlockRange(body, startSeq, endSeq) {
  if (!body) return;
  body.dataset.renderedBlockStartSeq = String(startSeq > 0 ? startSeq : 0);
  body.dataset.renderedBlockEndSeq = String(endSeq > 0 ? endSeq : 0);
}

function hasRenderedEventBlockContent(body) {
  if (!body) return false;
  if (Number.isInteger(body.childElementCount)) {
    return body.childElementCount > 0;
  }
  return Array.isArray(body.children) ? body.children.length > 0 : false;
}

function shouldAppendEventBlockContent(body, evt) {
  if (!body) return false;
  const nextStartSeq = parseEventBlockSeq(evt?.blockStartSeq);
  const nextEndSeq = parseEventBlockSeq(evt?.blockEndSeq);
  const renderedStartSeq = getRenderedEventBlockStartSeq(body);
  const renderedEndSeq = getRenderedEventBlockEndSeq(body);
  if (nextStartSeq < 1 || nextEndSeq < 1) return false;
  if (renderedStartSeq !== nextStartSeq) return false;
  if (renderedEndSeq < 1 || nextEndSeq <= renderedEndSeq) return false;
  return hasRenderedEventBlockContent(body);
}

function clearEventBlockBody(body) {
  if (!body) return;
  body.innerHTML = "";
}

function renderEventBlockBody(body, hiddenEvents) {
  if (!body) return;
  clearEventBlockBody(body);
  renderHiddenBlockEventsInto(body, hiddenEvents);
}

function renderHiddenBlockEventsInto(container, events) {
  if (!container) return;
  for (const event of Array.isArray(events) ? events : []) {
    switch (event?.type) {
      case "message":
        renderMessageInto(container, event);
        break;
      case "reasoning":
        renderReasoningInto(container, event);
        break;
      case "manager_context":
        renderManagerContextInto(container, event);
        break;
      case "tool_use":
        renderToolUseInto(container, event);
        break;
      case "tool_result":
        renderToolResultInto(container, event);
        break;
      case "file_change":
        renderFileChangeInto(container, event);
        break;
      case "status":
        renderStatusInto(container, event);
        break;
      case "context_barrier":
        renderContextBarrierInto(container, event);
        break;
      case "context_operation":
        renderContextOperationInto(container, event);
        break;
      case "usage":
        renderUsageInto(container, event);
        break;
      default:
        renderUnknownEventInto(container, event);
        break;
    }
  }
}

async function ensureEventBlockLoaded(sessionId, body, evt) {
  if (!body || !evt) return;
  const nextStartSeq = parseEventBlockSeq(evt?.blockStartSeq);
  const nextEndSeq = parseEventBlockSeq(evt?.blockEndSeq);
  const rangeKey = `${nextStartSeq}-${nextEndSeq}`;
  const currentRangeKey = body.dataset.blockRange || "";
  const renderedStartSeq = getRenderedEventBlockStartSeq(body);
  const renderedEndSeq = getRenderedEventBlockEndSeq(body);
  if (
    currentRangeKey === rangeKey
    && renderedStartSeq === nextStartSeq
    && renderedEndSeq >= nextEndSeq
  ) {
    return;
  }

  const appendMode = shouldAppendEventBlockContent(body, evt);
  const previousRenderedEndSeq = renderedEndSeq;

  body.dataset.blockRange = rangeKey;
  body.dataset.blockStartSeq = String(nextStartSeq);
  body.dataset.blockEndSeq = String(nextEndSeq);

  try {
    const data = await fetchEventBlock(sessionId, evt.blockStartSeq, evt.blockEndSeq);
    if ((body.dataset.blockRange || "") !== rangeKey) return;
    const hiddenEvents = Array.isArray(data?.events) ? data.events : [];
    if (hiddenEvents.length === 0) return;

    if (appendMode) {
      const appendedEvents = hiddenEvents.filter(
        (event) => Number.isInteger(event?.seq) && event.seq > previousRenderedEndSeq,
      );
      if (appendedEvents.length > 0) {
        renderHiddenBlockEventsInto(body, appendedEvents);
      } else if (
        getRenderedEventBlockStartSeq(body) !== nextStartSeq
        || getRenderedEventBlockEndSeq(body) < previousRenderedEndSeq
      ) {
        renderEventBlockBody(body, hiddenEvents);
      }
    } else {
      renderEventBlockBody(body, hiddenEvents);
    }

    const updatedRenderedStartSeq = Number.isInteger(hiddenEvents[0]?.seq)
      ? hiddenEvents[0].seq
      : nextStartSeq;
    const updatedRenderedEndSeq = Number.isInteger(hiddenEvents[hiddenEvents.length - 1]?.seq)
      ? hiddenEvents[hiddenEvents.length - 1].seq
      : nextEndSeq;
    setRenderedEventBlockRange(body, updatedRenderedStartSeq, updatedRenderedEndSeq);
  } catch (error) {
    if ((body.dataset.blockRange || "") !== rangeKey) return;
    console.warn("[event-block] Failed to load hidden block:", error.message);
  }
}

function isRunningThinkingBlockEvent(evt) {
  return evt?.state === "running";
}

function shouldOpenThinkingBlocksFromPreference() {
  return typeof window.remotelabShouldExpandThinkingBlocksByDefault === "function"
    ? window.remotelabShouldExpandThinkingBlocksByDefault()
    : false;
}

function getThinkingBlockLabel(evt) {
  if (typeof evt?.label === "string" && evt.label.trim()) {
    return evt.label;
  }
  return isRunningThinkingBlockEvent(evt) ? t("thinking.active") : t("thinking.done");
}

function findRenderedThinkingBlock(seq) {
  if (!Number.isInteger(seq)) return null;
  const targetSeq = String(seq);
  for (const node of messagesInner.children || []) {
    if (!node?.classList?.contains("thinking-block")) continue;
    if (node?.dataset?.eventSeq === targetSeq) return node;
  }
  return null;
}

function refreshExpandedRunningThinkingBlock(sessionId, evt) {
  if (!sessionId || !evt) return false;
  const block = findRenderedThinkingBlock(evt.seq);
  if (!block || block.classList?.contains("collapsed")) return false;
  const label = block.querySelector(".thinking-label");
  if (label) {
    label.textContent = getThinkingBlockLabel(evt);
  }
  block.dataset.blockStartSeq = String(Number.isInteger(evt?.blockStartSeq) ? evt.blockStartSeq : 0);
  block.dataset.blockEndSeq = String(Number.isInteger(evt?.blockEndSeq) ? evt.blockEndSeq : 0);
  const body = block.querySelector(".thinking-body");
  if (!body) return false;
  body.dataset.blockStartSeq = block.dataset.blockStartSeq;
  body.dataset.blockEndSeq = block.dataset.blockEndSeq;
  ensureEventBlockLoaded(sessionId, body, evt).catch(() => {});
  return true;
}

function renderCollapsedBlock(evt) {
  renderThinkingBlockEvent({
    ...(evt && typeof evt === "object" ? evt : {}),
    state: typeof evt?.state === "string" ? evt.state : "completed",
  });
}

function renderThinkingBlockEvent(evt) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }

  const sessionId = currentSessionId;
  const running = isRunningThinkingBlockEvent(evt);
  const expandedByDefault = running
    ? renderedEventState?.runningBlockExpanded === true
    : shouldOpenThinkingBlocksFromPreference();
  const thinking = createDeferredThinkingBlock(getThinkingBlockLabel(evt), {
    collapsed: !expandedByDefault,
  });
  thinking.block.dataset.eventSeq = String(Number.isInteger(evt?.seq) ? evt.seq : 0);
  thinking.block.dataset.blockStartSeq = String(Number.isInteger(evt?.blockStartSeq) ? evt.blockStartSeq : 0);
  thinking.block.dataset.blockEndSeq = String(Number.isInteger(evt?.blockEndSeq) ? evt.blockEndSeq : 0);
  thinking.body.dataset.blockRange = "";
  thinking.body.dataset.blockStartSeq = thinking.block.dataset.blockStartSeq;
  thinking.body.dataset.blockEndSeq = thinking.block.dataset.blockEndSeq;

  if (running && typeof setRunningEventBlockExpanded === "function") {
    setRunningEventBlockExpanded(sessionId, expandedByDefault);
  }

  thinking.header.addEventListener("click", () => {
    thinking.block.classList.toggle("collapsed");
    const expanded = !thinking.block.classList.contains("collapsed");
    if (running && typeof setRunningEventBlockExpanded === "function") {
      setRunningEventBlockExpanded(sessionId, expanded);
    }
    if (!expanded) return;
    ensureEventBlockLoaded(sessionId, thinking.body, evt).catch(() => {});
    if (running && typeof refreshCurrentSession === "function") {
      refreshCurrentSession().catch(() => {});
    }
  });

  messagesInner.appendChild(thinking.block);
  if (expandedByDefault) {
    ensureEventBlockLoaded(sessionId, thinking.body, evt).catch(() => {});
  }
}

function renderToolUse(evt) {
  const container = getThinkingBody();
  renderToolUseInto(container, evt, {
    toolTracker: currentThinkingBlock?.tools || null,
  });
}

function renderToolResult(evt) {
  const searchRoot =
    inThinkingBlock && currentThinkingBlock
      ? currentThinkingBlock.body
      : messagesInner;
  renderToolResultInto(searchRoot, evt);
}

function renderFileChange(evt) {
  const container = getThinkingBody();
  renderFileChangeInto(container, evt);
}

function renderReasoning(evt) {
  const container = getThinkingBody();
  renderReasoningInto(container, evt);
}

function isReplySelfCheckStatusEvent(evt) {
  return evt?.type === "status"
    && typeof evt?.content === "string"
    && evt.content.startsWith("Assistant self-check:");
}

function isReplySelfCheckOperationEvent(evt) {
  return evt?.type === "context_operation"
    && evt?.operation === "continue_turn"
    && evt?.trigger === "automatic";
}

function getContainerLastElement(container) {
  if (!container) return null;
  if (container.lastElementChild) return container.lastElementChild;
  if (Array.isArray(container.children) && container.children.length > 0) {
    return container.children[container.children.length - 1] || null;
  }
  return null;
}

function getOrCreateReplySelfCheckDrawer(container) {
  if (!container) return null;
  const existing = replySelfCheckDrawerByContainer.get(container);
  if (
    existing?.drawer
    && existing.drawer.parentNode === container
    && getContainerLastElement(container) === existing.drawer
  ) {
    return existing;
  }

  const drawer = document.createElement("details");
  drawer.className = "turn-collapse-drawer reply-self-check-drawer";

  const summary = document.createElement("summary");
  summary.className = "turn-collapse-summary";
  summary.textContent = t("replySelfCheck.drawerSummary");
  drawer.appendChild(summary);

  const body = document.createElement("div");
  body.className = "turn-collapse-body";
  drawer.appendChild(body);

  container.appendChild(drawer);
  const created = { drawer, summary, body };
  replySelfCheckDrawerByContainer.set(container, created);
  return created;
}

function renderStatusInto(container, evt, { allowReplySelfCheckCollapse = true } = {}) {
  if (!container) return null;
  if (
    !evt?.content
    || evt.content === "completed"
    || evt.content === "thinking"
  ) {
    return null;
  }
  if (allowReplySelfCheckCollapse && isReplySelfCheckStatusEvent(evt)) {
    const drawer = getOrCreateReplySelfCheckDrawer(container);
    if (!drawer?.body) return null;
    return renderStatusInto(drawer.body, evt, {
      allowReplySelfCheckCollapse: false,
    });
  }
  const div = document.createElement("div");
  div.className = "msg-system";
  div.textContent = evt.content;
  container.appendChild(div);
  return div;
}

function renderStatusMsg(evt) {
  // Finalize thinking block when the AI turn ends (completed/error)
  if (inThinkingBlock && evt.content !== "thinking") {
    finalizeThinkingBlock();
  }
  renderStatusInto(messagesInner, evt);
}

function renderContextBarrierInto(container, evt) {
  if (!container) return null;
  const div = document.createElement("div");
  div.className = "context-barrier";
  div.textContent = evt.content || t("context.barrier");
  container.appendChild(div);
  return div;
}

function renderContextBarrier(evt) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }
  renderContextBarrierInto(messagesInner, evt);
}

function humanizeContextOperationValue(value) {
  return String(value || "").trim().replace(/_/g, " ");
}

function renderContextOperationInto(container, evt, { allowReplySelfCheckCollapse = true } = {}) {
  if (!container) return null;
  if (allowReplySelfCheckCollapse && isReplySelfCheckOperationEvent(evt)) {
    const drawer = getOrCreateReplySelfCheckDrawer(container);
    if (!drawer?.body) return null;
    return renderContextOperationInto(drawer.body, evt, {
      allowReplySelfCheckCollapse: false,
    });
  }
  const card = document.createElement("div");
  card.className = "context-operation";
  if (evt?.phase) card.dataset.phase = evt.phase;
  if (evt?.operation) card.dataset.operation = evt.operation;

  const title = document.createElement("div");
  title.className = "context-operation-title";
  title.textContent = evt?.title || evt?.content || t("context.barrier");
  card.appendChild(title);

  const summaryText = typeof evt?.summary === "string" ? evt.summary.trim() : "";
  if (summaryText) {
    const summary = document.createElement("div");
    summary.className = "context-operation-summary";
    summary.textContent = summaryText;
    card.appendChild(summary);
  }

  const metaParts = [];
  const phaseText = humanizeContextOperationValue(evt?.phase);
  if (phaseText) metaParts.push(phaseText);
  const triggerText = humanizeContextOperationValue(evt?.trigger);
  if (triggerText) metaParts.push(triggerText);
  if (Number.isInteger(evt?.compactedThroughSeq) && evt.compactedThroughSeq > 0) {
    metaParts.push(`through #${evt.compactedThroughSeq}`);
  }
  if (metaParts.length > 0) {
    const meta = document.createElement("div");
    meta.className = "context-operation-meta";
    meta.textContent = metaParts.join(" · ");
    card.appendChild(meta);
  }

  const reasonText = typeof evt?.reason === "string" ? evt.reason.trim() : "";
  if (reasonText) {
    const reason = document.createElement("div");
    reason.className = "context-operation-reason";
    reason.textContent = reasonText;
    card.appendChild(reason);
  }

  container.appendChild(card);
  return card;
}

function renderContextOperation(evt) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }
  renderContextOperationInto(messagesInner, evt);
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
      ? t("context.currentShort", {
        tokens: formatCompactTokens(contextSize),
        percent: formatContextPercent(percent),
      })
      : t("context.currentOnly", { tokens: formatCompactTokens(contextSize) });
    contextTokens.title = percent !== null
      ? t("context.currentTitleWithWindow", {
        context: contextSize.toLocaleString(),
        window: contextWindowSize.toLocaleString(),
        percent: formatContextPercent(percent, { precise: true }),
      })
      : t("context.currentTitle", { context: contextSize.toLocaleString() });
    contextTokens.style.display = "";
    compactBtn.style.display = "";
    dropToolsBtn.style.display = "";
  }
}

function renderUsageInto(container, evt, { updateContext = false } = {}) {
  if (!container) return null;
  const contextSize = getContextTokens(evt);
  if (!(contextSize > 0)) return null;
  const contextWindowSize = getContextWindowTokens(evt);
  const percent = getContextPercent(contextSize, contextWindowSize);
  const output = evt.outputTokens || 0;
  const div = document.createElement("div");
  div.className = "usage-info";
  const parts = [t("context.usage.current", { tokens: formatCompactTokens(contextSize) })];
  if (percent !== null) parts.push(t("context.usage.window", { percent: formatContextPercent(percent, { precise: true }) }));
  if (output > 0) parts.push(t("context.usage.output", { tokens: formatCompactTokens(output) }));
  div.textContent = parts.join(" · ");
  const hover = [t("context.currentTitle", { context: contextSize.toLocaleString() })];
  if (contextWindowSize > 0) hover.push(t("context.hover.window", { window: contextWindowSize.toLocaleString() }));
  if (Number.isFinite(evt?.inputTokens) && evt.inputTokens !== contextSize) {
    hover.push(t("context.hover.rawInput", { tokens: evt.inputTokens.toLocaleString() }));
  }
  if (output > 0) hover.push(t("context.hover.output", { tokens: output.toLocaleString() }));
  div.title = hover.join("\n");
  container.appendChild(div);
  if (updateContext) {
    updateContextDisplay(contextSize, contextWindowSize);
  }
  return div;
}

function renderUsage(evt) {
  renderUsageInto(messagesInner, evt, { updateContext: true });
}

function renderUnknownEventInto(container, evt) {
  if (!container) return null;
  const pre = document.createElement("pre");
  pre.className = "tool-result";
  let text = "";
  try {
    text = JSON.stringify(evt || {}, null, 2);
  } catch {
    text = String(evt?.type || "unknown_event");
  }
  pre.textContent = text;
  container.appendChild(pre);
  return pre;
}
