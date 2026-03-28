// ---- Send message ----
const fallbackStrings = {
  "compose.pending.uploading": "Uploading attachment\u2026",
  "compose.pending.sendingAttachment": "Sending attachment\u2026",
  "compose.pending.sending": "Sending\u2026",
};

function fallbackTranslate(key) {
  return fallbackStrings[key] || key;
}

function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : fallbackTranslate(key);
}

function getComposerPendingSendSnapshot() {
  return typeof getComposerPendingSendState === "function"
    ? getComposerPendingSendState()
    : null;
}

function getComposerAttachmentsSnapshot(sessionId = currentSessionId) {
  if (!sessionId) return [];
  return typeof getComposerAttachmentsState === "function"
    ? getComposerAttachmentsState(sessionId)
    : [];
}

function syncComposerDraftState(sessionId = currentSessionId, text = "") {
  if (!sessionId) return;
  if (typeof setComposerDraftTextState === "function") {
    setComposerDraftTextState(text, { sessionId });
  }
}

function replaceComposerAttachmentsSnapshot(sessionId = currentSessionId, attachments = []) {
  if (!sessionId) return;
  if (typeof replaceComposerAttachmentsState === "function") {
    replaceComposerAttachmentsState(attachments, { sessionId });
  }
}

function clearComposerPendingSendSnapshot(requestId = "") {
  if (typeof clearComposerPendingSendState === "function") {
    clearComposerPendingSendState(requestId);
  }
}

function getComposerAssetUploadConfig() {
  return typeof getBootstrapAssetUploads === "function"
    ? getBootstrapAssetUploads()
    : { enabled: false, directUpload: false, provider: "" };
}

function shouldUseDirectComposerAssetUploads() {
  const config = getComposerAssetUploadConfig();
  return config.enabled === true
    && config.directUpload === true
    && typeof fetchJsonOrRedirect === "function";
}

const COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY = 3;
const composerAttachmentUploadQueue = [];
const composerAttachmentUploadPromises = new Map();
const composerAttachmentUploadControllers = new Map();
let activeComposerAttachmentUploads = 0;

function createComposerAttachmentAbortError() {
  const error = new Error("Attachment upload cancelled");
  error.name = "AbortError";
  return error;
}

function buildComposerAttachmentUploadKey(sessionId, localId) {
  return `${sessionId || ""}:${localId || ""}`;
}

function normalizeComposerAttachmentUploadState(value) {
  switch (value) {
    case "uploading":
    case "uploaded":
    case "failed":
      return value;
    default:
      return "queued";
  }
}

function refreshComposerAttachmentUi(sessionId = currentSessionId) {
  if (!sessionId || sessionId !== currentSessionId) {
    return;
  }
  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }
  syncComposerPendingUi();
}

function getComposerAttachmentByLocalId(sessionId, localId) {
  if (!sessionId || typeof localId !== "string" || !localId) {
    return null;
  }
  return getComposerAttachmentsSnapshot(sessionId).find((attachment) => attachment?.localId === localId) || null;
}

function updateComposerAttachmentByLocalId(sessionId, localId, updater) {
  if (!sessionId || typeof localId !== "string" || !localId || typeof updater !== "function") {
    return null;
  }
  const attachments = getComposerAttachmentsSnapshot(sessionId);
  let nextAttachment = null;
  let changed = false;
  let found = false;
  const nextAttachments = attachments
    .map((attachment) => {
      if (attachment?.localId !== localId) {
        return attachment;
      }
      found = true;
      const updated = updater(attachment);
      nextAttachment = updated && typeof updated === "object" ? updated : null;
      if (updated !== attachment) {
        changed = true;
      }
      return updated;
    })
    .filter(Boolean);
  if (!found) {
    return null;
  }
  if (changed) {
    replaceComposerAttachmentsSnapshot(sessionId, nextAttachments);
    refreshComposerAttachmentUi(sessionId);
  }
  return nextAttachment;
}

function cancelComposerAttachmentUpload(sessionId, localId) {
  const key = buildComposerAttachmentUploadKey(sessionId, localId);
  const queuedIndex = composerAttachmentUploadQueue.findIndex((job) => job.key === key);
  if (queuedIndex >= 0) {
    const [job] = composerAttachmentUploadQueue.splice(queuedIndex, 1);
    composerAttachmentUploadPromises.delete(key);
    job.reject(createComposerAttachmentAbortError());
    return true;
  }
  const controller = composerAttachmentUploadControllers.get(key);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}

async function uploadComposerAttachmentToAsset(sessionId, attachment, { signal } = {}) {
  const file = attachment?.file;
  if (!file || typeof file.arrayBuffer !== "function") {
    return attachment;
  }

  const intent = await fetchJsonOrRedirect("/api/assets/upload-intents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      originalName: attachment?.originalName || file.name || "attachment",
      mimeType: attachment?.mimeType || file.type || "application/octet-stream",
      sizeBytes: Number.isFinite(file.size) ? file.size : undefined,
    }),
  });

  const asset = intent?.asset && typeof intent.asset === "object"
    ? intent.asset
    : null;
  const upload = intent?.upload && typeof intent.upload === "object"
    ? intent.upload
    : null;
  if (!asset?.id || !upload?.url) {
    throw new Error("Upload intent is incomplete");
  }

  const uploadResponse = await fetch(upload.url, {
    method: upload.method || "PUT",
    headers: upload.headers || {},
    body: file,
    ...(signal ? { signal } : {}),
  });
  if (!uploadResponse.ok) {
    throw new Error(`Attachment upload failed (${uploadResponse.status})`);
  }

  const finalized = await fetchJsonOrRedirect(`/api/assets/${encodeURIComponent(asset.id)}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sizeBytes: Number.isFinite(file.size) ? file.size : undefined,
      etag: uploadResponse.headers.get("etag") || "",
    }),
  });

  const finalizedAsset = finalized?.asset && typeof finalized.asset === "object"
    ? finalized.asset
    : asset;
  return {
    assetId: finalizedAsset.id,
    ...(attachment?.localId ? { localId: attachment.localId } : {}),
    originalName: finalizedAsset.originalName || attachment?.originalName || file.name || "attachment",
    mimeType: finalizedAsset.mimeType || attachment?.mimeType || file.type || "application/octet-stream",
    ...(Number.isFinite(finalizedAsset?.sizeBytes) ? { sizeBytes: finalizedAsset.sizeBytes } : Number.isFinite(file.size) ? { sizeBytes: file.size } : {}),
    ...(finalizedAsset?.downloadUrl ? { downloadUrl: finalizedAsset.downloadUrl } : {}),
    ...(attachment?.renderAs === "file" ? { renderAs: "file" } : {}),
    ...(attachment?.objectUrl ? { objectUrl: attachment.objectUrl } : {}),
  };
}

async function runComposerAttachmentUpload(sessionId, localId) {
  const attachment = getComposerAttachmentByLocalId(sessionId, localId);
  if (!attachment) {
    return null;
  }
  if (attachment.assetId) {
    return attachment;
  }
  if (!attachment.file || typeof attachment.file.arrayBuffer !== "function") {
    throw new Error("Attachment file is unavailable");
  }

  updateComposerAttachmentByLocalId(sessionId, localId, (currentAttachment) => currentAttachment
    ? {
      ...currentAttachment,
      uploadState: "uploading",
      uploadError: "",
    }
    : currentAttachment);

  const key = buildComposerAttachmentUploadKey(sessionId, localId);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  if (controller) {
    composerAttachmentUploadControllers.set(key, controller);
  }

  try {
    const currentAttachment = getComposerAttachmentByLocalId(sessionId, localId);
    if (!currentAttachment) {
      throw createComposerAttachmentAbortError();
    }
    const uploadedAttachment = await uploadComposerAttachmentToAsset(sessionId, currentAttachment, {
      signal: controller?.signal,
    });
    return updateComposerAttachmentByLocalId(sessionId, localId, (nextAttachment) => nextAttachment
      ? {
        ...nextAttachment,
        ...uploadedAttachment,
        file: undefined,
        uploadState: "uploaded",
        uploadError: "",
      }
      : nextAttachment);
  } catch (error) {
    const latestAttachment = getComposerAttachmentByLocalId(sessionId, localId);
    if (latestAttachment) {
      updateComposerAttachmentByLocalId(sessionId, localId, (nextAttachment) => nextAttachment
        ? {
          ...nextAttachment,
          uploadState: error?.name === "AbortError"
            ? "queued"
            : "failed",
          uploadError: error?.name === "AbortError"
            ? nextAttachment?.uploadError || ""
            : (error?.message || "Attachment upload failed"),
        }
        : nextAttachment);
    }
    throw error;
  } finally {
    composerAttachmentUploadControllers.delete(key);
  }
}

function pumpComposerAttachmentUploads() {
  while (activeComposerAttachmentUploads < COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY && composerAttachmentUploadQueue.length > 0) {
    const job = composerAttachmentUploadQueue.shift();
    if (!job) {
      continue;
    }
    const attachment = getComposerAttachmentByLocalId(job.sessionId, job.localId);
    if (!attachment || attachment.assetId || !attachment.file) {
      composerAttachmentUploadPromises.delete(job.key);
      job.resolve(attachment || null);
      continue;
    }
    activeComposerAttachmentUploads += 1;
    void (async () => {
      try {
        job.resolve(await runComposerAttachmentUpload(job.sessionId, job.localId));
      } catch (error) {
        job.reject(error);
      } finally {
        composerAttachmentUploadPromises.delete(job.key);
        activeComposerAttachmentUploads = Math.max(0, activeComposerAttachmentUploads - 1);
        pumpComposerAttachmentUploads();
      }
    })();
  }
}

function scheduleComposerAttachmentUpload(sessionId, localId) {
  const key = buildComposerAttachmentUploadKey(sessionId, localId);
  const existingPromise = composerAttachmentUploadPromises.get(key);
  if (existingPromise) {
    return existingPromise;
  }
  const promise = new Promise((resolve, reject) => {
    composerAttachmentUploadQueue.push({
      sessionId,
      localId,
      key,
      resolve,
      reject,
    });
    pumpComposerAttachmentUploads();
  });
  composerAttachmentUploadPromises.set(key, promise);
  return promise;
}

function collectComposerAttachmentUploadPromises(sessionId, { localIds = [], includeFailed = false } = {}) {
  if (!sessionId || !shouldUseDirectComposerAssetUploads()) {
    return [];
  }
  const trackedIds = new Set(
    (Array.isArray(localIds) ? localIds : [])
      .filter((value) => typeof value === "string" && value),
  );
  const attachments = getComposerAttachmentsSnapshot(sessionId);
  const promises = [];
  for (const attachment of attachments) {
    if (!(attachment && typeof attachment === "object")) continue;
    if (!attachment.file || attachment.assetId) continue;
    const localId = typeof attachment.localId === "string" ? attachment.localId : "";
    if (!localId) continue;
    if (trackedIds.size > 0 && !trackedIds.has(localId)) continue;
    const uploadState = normalizeComposerAttachmentUploadState(attachment.uploadState);
    if (uploadState === "failed" && !includeFailed) continue;
    if (uploadState === "uploaded") continue;
    promises.push(scheduleComposerAttachmentUpload(sessionId, localId));
  }
  return promises;
}

async function ensureComposerAttachmentUploads(sessionId, options = {}) {
  const uploads = collectComposerAttachmentUploadPromises(sessionId, options);
  if (uploads.length === 0) {
    return [];
  }
  return Promise.all(uploads);
}

async function retryComposerAttachmentUpload(sessionId, localId) {
  const attachment = updateComposerAttachmentByLocalId(sessionId, localId, (currentAttachment) => currentAttachment
    ? {
      ...currentAttachment,
      uploadState: "queued",
      uploadError: "",
    }
    : currentAttachment);
  if (!attachment || !attachment.file) {
    throw new Error("Attachment file is unavailable");
  }
  return ensureComposerAttachmentUploads(sessionId, {
    localIds: [localId],
    includeFailed: true,
  });
}

async function prepareComposerAttachmentsForSend(sessionId, attachments) {
  if (!shouldUseDirectComposerAssetUploads()) {
    return attachments;
  }

  const trackedLocalIds = [];
  const trackedAttachmentPositions = [];
  const prepared = [];
  for (const attachment of attachments || []) {
    if (!(attachment && typeof attachment === "object")) continue;
    if (!attachment.file || typeof attachment.assetId === "string") {
      prepared.push(attachment);
      continue;
    }
    if (typeof attachment.localId === "string" && attachment.localId) {
      trackedLocalIds.push(attachment.localId);
      trackedAttachmentPositions.push({
        index: prepared.length,
        localId: attachment.localId,
      });
      prepared.push(null);
      continue;
    }
    prepared.push(await uploadComposerAttachmentToAsset(sessionId, attachment));
  }

  if (trackedLocalIds.length > 0) {
    await ensureComposerAttachmentUploads(sessionId, { localIds: trackedLocalIds });
    const attachmentsByLocalId = new Map(
      getComposerAttachmentsSnapshot(sessionId)
        .filter((attachment) => attachment?.localId)
        .map((attachment) => [attachment.localId, attachment]),
    );
    for (const attachment of attachments || []) {
      if (!(attachment && typeof attachment === "object")) continue;
      if (!attachment.file || typeof attachment.assetId === "string") {
        continue;
      }
      const localId = typeof attachment.localId === "string" ? attachment.localId : "";
      if (!localId) continue;
      const nextAttachment = attachmentsByLocalId.get(localId);
      if (!nextAttachment) {
        throw createComposerAttachmentAbortError();
      }
      if (!nextAttachment.assetId) {
        throw new Error(nextAttachment.uploadError || "Attachment upload did not finish");
      }
    }
    for (const trackedAttachment of trackedAttachmentPositions) {
      const nextAttachment = attachmentsByLocalId.get(trackedAttachment.localId);
      if (!nextAttachment?.assetId) {
        throw new Error(nextAttachment?.uploadError || "Attachment upload did not finish");
      }
      prepared[trackedAttachment.index] = nextAttachment;
    }
  }
  return prepared.filter(Boolean);
}

function hasPendingComposerSend() {
  return !!getComposerPendingSendSnapshot();
}

function isComposerPendingForSession(sessionId = currentSessionId) {
  const pendingSend = getComposerPendingSendSnapshot();
  return !!pendingSend && !!sessionId && pendingSend.sessionId === sessionId;
}

function isComposerPendingForCurrentSession() {
  return isComposerPendingForSession(currentSessionId);
}

function syncComposerPendingUi() {
  const pendingForCurrentSession = isComposerPendingForCurrentSession();
  const pendingSend = getComposerPendingSendSnapshot();
  inputArea.classList.toggle("is-pending-send", pendingForCurrentSession);
  msgInput.readOnly = pendingForCurrentSession;

  if (!composerPendingState) {
    return;
  }
  if (!pendingForCurrentSession) {
    composerPendingState.textContent = "";
    composerPendingState.classList.remove("visible");
    return;
  }

  const hasAttachments = Array.isArray(pendingSend?.images) && pendingSend.images.length > 0;
  composerPendingState.textContent = pendingSend?.stage === "uploading"
    ? t("compose.pending.uploading")
    : (hasAttachments && !pendingSend?.text
      ? t("compose.pending.sendingAttachment")
      : t("compose.pending.sending"));
  composerPendingState.classList.add("visible");
}

function finalizeComposerPendingSend(requestId) {
  const completedSend = getComposerPendingSendSnapshot();
  if (!completedSend) return false;
  if (requestId && completedSend.requestId !== requestId) return false;

  clearComposerPendingSendSnapshot(requestId);
  clearDraft(completedSend.sessionId);
  releaseImageObjectUrls(getComposerAttachmentsSnapshot(completedSend.sessionId));
  if (typeof clearComposerSessionState === "function") {
    clearComposerSessionState(completedSend.sessionId, {
      clearDraft: false,
      clearAttachments: true,
    });
  }
  if (currentSessionId === completedSend.sessionId) {
    msgInput.value = "";
    autoResizeInput();
    if (typeof renderImagePreviews === "function") {
      renderImagePreviews();
    }
  }
  syncComposerPendingUi();
  return true;
}

function createEmptyComposerActivitySnapshot() {
  return {
    run: {
      state: "idle",
      phase: null,
      runId: null,
    },
    queue: {
      state: "idle",
      count: 0,
    },
  };
}

function getComposerSessionActivitySnapshot(session) {
  const raw = session?.activity || {};
  const queueCount = Number.isInteger(raw?.queue?.count) ? raw.queue.count : 0;
  return {
    run: {
      state: raw?.run?.state === "running" ? "running" : "idle",
      phase: typeof raw?.run?.phase === "string" ? raw.run.phase : null,
      runId: typeof raw?.run?.runId === "string" ? raw.run.runId : null,
    },
    queue: {
      state: raw?.queue?.state === "queued" && queueCount > 0 ? "queued" : "idle",
      count: queueCount,
    },
  };
}

function hasCanonicalComposerSendAcceptance(session) {
  const pendingSend = getComposerPendingSendSnapshot();
  if (!pendingSend) return false;
  if (!session?.id || session.id !== pendingSend.sessionId) return false;

  const queuedMessages = Array.isArray(session.queuedMessages) ? session.queuedMessages : [];
  if (queuedMessages.some((item) => item?.requestId === pendingSend.requestId)) {
    return true;
  }

  const previousActivity = pendingSend.baselineActivity || createEmptyComposerActivitySnapshot();
  const nextActivity = getComposerSessionActivitySnapshot(session);

  if (
    nextActivity.queue.state === "queued"
    && nextActivity.queue.count > (previousActivity.queue?.count || 0)
  ) {
    return true;
  }

  if (previousActivity.run.state !== "running") {
    if (nextActivity.run.state === "running") return true;
    if (nextActivity.run.phase === "accepted" || nextActivity.run.phase === "running") return true;
    if (nextActivity.run.runId && nextActivity.run.runId !== (previousActivity.run?.runId || null)) {
      return true;
    }
  }

  return false;
}

function reconcileComposerPendingSendWithSession(session) {
  const pendingSend = getComposerPendingSendSnapshot();
  if (!pendingSend) return false;
  if (!session?.id || session.id !== pendingSend.sessionId) return false;
  if (!hasCanonicalComposerSendAcceptance(session)) return false;
  return finalizeComposerPendingSend(pendingSend.requestId);
}

function reconcileComposerPendingSendWithEvent(event) {
  const pendingSend = getComposerPendingSendSnapshot();
  if (!pendingSend) return false;
  if (event?.type !== "message" || event.role !== "user") return false;
  if (!event.requestId || event.requestId !== pendingSend.requestId) return false;
  return finalizeComposerPendingSend(event.requestId);
}

function getDraftStorageKey(sessionId = currentSessionId) {
  if (!sessionId) return "";
  return `draft_${sessionId}`;
}

function readStoredDraft(sessionId = currentSessionId) {
  const key = getDraftStorageKey(sessionId);
  if (!key) return "";
  return localStorage.getItem(key) || "";
}

function writeStoredDraft(sessionId = currentSessionId, text = "") {
  const key = getDraftStorageKey(sessionId);
  syncComposerDraftState(sessionId, text);
  if (!key) return;
  if (text) {
    localStorage.setItem(key, text);
    return;
  }
  localStorage.removeItem(key);
}

function getComposerDraftText(sessionId = currentSessionId) {
  if (!sessionId) return "";
  if (isComposerPendingForSession(sessionId)) {
    return getComposerPendingSendSnapshot()?.text || "";
  }
  return typeof getComposerDraftTextState === "function"
    ? getComposerDraftTextState(sessionId)
    : readStoredDraft(sessionId);
}

function resolveComposerRequestId(existingRequestId) {
  if (typeof existingRequestId === "string") {
    const normalizedRequestId = existingRequestId.trim();
    if (normalizedRequestId) {
      return normalizedRequestId;
    }
  }
  return createRequestId();
}

function sendMessage(existingRequestId) {
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) return;
  const text = msgInput.value.trim();
  const currentSession = getCurrentSession();
  const queuedImages = getComposerAttachmentsSnapshot(currentSessionId);
  if (hasPendingComposerSend()) return;
  if ((!text && queuedImages.length === 0) || !currentSessionId || currentSession?.archived) return;

  const requestId = resolveComposerRequestId(existingRequestId);
  const sessionId = currentSessionId;
  const sendTool = selectedTool;
  const sendModel = selectedModel;
  const sendReasoningKind = currentToolReasoningKind;
  const sendEffort = selectedEffort;
  const sendThinking = thinkingEnabled === true;

  if (typeof setComposerPendingSendState === "function") {
    setComposerPendingSendState({
      sessionId,
      requestId,
      text,
      images: queuedImages,
      baselineActivity: getComposerSessionActivitySnapshot(currentSession),
      stage: "sending",
    });
  }
  clearDraft(sessionId);
  syncComposerPendingUi();
  autoResizeInput();
  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }

  void (async () => {
    let outboundText = text;
    let outboundImages = queuedImages;
    try {
      if (queuedImages.length > 0) {
        if (typeof patchComposerPendingSendState === "function") {
          patchComposerPendingSendState({ stage: "uploading" });
        }
        syncComposerPendingUi();
        outboundImages = await prepareComposerAttachmentsForSend(sessionId, queuedImages);
        const pendingSend = getComposerPendingSendSnapshot();
        if (!(pendingSend && pendingSend.requestId === requestId)) return;
        replaceComposerAttachmentsSnapshot(sessionId, outboundImages);
        if (typeof patchComposerPendingSendState === "function") {
          patchComposerPendingSendState({
            images: outboundImages,
            stage: "sending",
          });
        }
        syncComposerPendingUi();
        if (typeof renderImagePreviews === "function") {
          renderImagePreviews();
        }
      }

      const msg = {
        action: "send",
        sessionId,
        text: outboundText || "(attachment)",
      };
      msg.requestId = requestId;
      if (!visitorMode) {
        if (sendTool) msg.tool = sendTool;
        if (sendModel) msg.model = sendModel;
        if (sendReasoningKind === "enum") {
          if (sendEffort) msg.effort = sendEffort;
        } else if (sendReasoningKind === "toggle") {
          msg.thinking = sendThinking;
        }
      }
      if (outboundImages.length > 0) {
        msg.images = outboundImages.map((img) => ({
          ...(img.file ? { file: img.file } : {}),
          ...(img.filename ? { filename: img.filename } : {}),
          ...(img.assetId ? { assetId: img.assetId } : {}),
          ...(img.originalName ? { originalName: img.originalName } : {}),
          ...(img.mimeType ? { mimeType: img.mimeType } : {}),
          ...(Number.isFinite(img?.sizeBytes) ? { sizeBytes: img.sizeBytes } : {}),
          ...(img?.renderAs === "file" ? { renderAs: "file" } : {}),
          ...(img.objectUrl ? { objectUrl: img.objectUrl } : {}),
        }));
      }
      const ok = await dispatchAction(msg);
      if (ok) return;
    } catch (error) {
      console.error("Composer send failed:", error?.message || error);
      outboundImages = getComposerAttachmentsSnapshot(sessionId);
    }

    const pendingSend = getComposerPendingSendSnapshot();
    const failedText = pendingSend?.requestId === requestId
      ? (pendingSend.text || outboundText || text)
      : (outboundText || text);
    restoreFailedSendState(sessionId, failedText, outboundImages, requestId);
  })();
}

cancelBtn.addEventListener("click", () => dispatchAction({ action: "cancel" }));

compactBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "compact" });
});

dropToolsBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "drop_tools" });
});

sendBtn.addEventListener("click", () => sendMessage());
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// ---- Composer height ----
const INPUT_MIN_LINES = 3;
const INPUT_AUTO_MAX_LINES = 10;
const INPUT_MANUAL_MIN_H = 100;
const INPUT_MAX_VIEWPORT_RATIO = 0.72;
const INPUT_HEIGHT_STORAGE_KEY = "msgInputHeight";
const LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY = "inputAreaHeight";

let isResizingInput = false;
let resizeStartY = 0;
let resizeStartInputH = 0;

function getInputLineHeight() {
  return parseFloat(getComputedStyle(msgInput).lineHeight) || 24;
}

function getAutoInputMinH() {
  return getInputLineHeight() * INPUT_MIN_LINES;
}

function getAutoInputMaxH() {
  return getInputLineHeight() * INPUT_AUTO_MAX_LINES;
}

function getInputChromeH() {
  if (!inputArea?.getBoundingClientRect || !msgInput?.getBoundingClientRect) {
    return 0;
  }
  const areaH = inputArea.getBoundingClientRect().height || 0;
  const inputH = msgInput.getBoundingClientRect().height || 0;
  return Math.max(0, areaH - inputH);
}

function getViewportHeight() {
  const managedViewportHeight = window.RemoteLabLayout?.getViewportHeight?.();
  if (Number.isFinite(managedViewportHeight) && managedViewportHeight > 0) {
    return managedViewportHeight;
  }
  const visualHeight = window.visualViewport?.height;
  if (Number.isFinite(visualHeight) && visualHeight > 0) {
    return visualHeight;
  }
  return window.innerHeight || 0;
}

function getManualInputMaxH() {
  const viewportMax = Math.floor(getViewportHeight() * INPUT_MAX_VIEWPORT_RATIO);
  return Math.max(INPUT_MANUAL_MIN_H, viewportMax - getInputChromeH());
}

function clampInputHeight(height, { manual = false } = {}) {
  const minH = getAutoInputMinH();
  const maxH = manual
    ? Math.max(minH, getManualInputMaxH())
    : Math.max(minH, getAutoInputMaxH());
  return Math.min(Math.max(height, minH), maxH);
}

function isManualInputHeightActive() {
  return inputArea.classList.contains("is-resized");
}

function setManualInputHeight(height, { persist = true } = {}) {
  const newH = clampInputHeight(height, { manual: true });
  msgInput.style.height = newH + "px";
  inputArea.classList.add("is-resized");
  if (persist) {
    localStorage.setItem(INPUT_HEIGHT_STORAGE_KEY, String(newH));
    localStorage.removeItem(LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY);
  }
  return newH;
}

function autoResizeInput() {
  if (isManualInputHeightActive()) return;
  msgInput.style.height = "auto";
  const newH = clampInputHeight(msgInput.scrollHeight);
  msgInput.style.height = newH + "px";
}

function restoreSavedInputHeight() {
  const savedInputH = localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY);
  if (savedInputH) {
    const height = parseInt(savedInputH, 10);
    if (Number.isFinite(height) && height > 0) {
      setManualInputHeight(height, { persist: false });
      return;
    }
    localStorage.removeItem(INPUT_HEIGHT_STORAGE_KEY);
  }

  const legacyInputAreaH = localStorage.getItem(LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY);
  if (legacyInputAreaH) {
    const legacyHeight = parseInt(legacyInputAreaH, 10);
    if (Number.isFinite(legacyHeight) && legacyHeight > 0) {
      const migratedHeight = Math.max(
        getAutoInputMinH(),
        legacyHeight - getInputChromeH(),
      );
      setManualInputHeight(migratedHeight);
      return;
    }
    localStorage.removeItem(LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY);
  }

  autoResizeInput();
}

function syncInputHeightForLayout() {
  if (!isManualInputHeightActive()) {
    autoResizeInput();
    return;
  }

  const currentHeight = parseFloat(msgInput.style.height);
  if (Number.isFinite(currentHeight) && currentHeight > 0) {
    setManualInputHeight(currentHeight, { persist: false });
    return;
  }

  const savedInputH = parseInt(
    localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY) || "",
    10,
  );
  if (Number.isFinite(savedInputH) && savedInputH > 0) {
    setManualInputHeight(savedInputH, { persist: false });
    return;
  }

  inputArea.classList.remove("is-resized");
  autoResizeInput();
}

function onInputResizeStart(e) {
  isResizingInput = true;
  resizeStartY = e.touches ? e.touches[0].clientY : e.clientY;
  resizeStartInputH = msgInput.getBoundingClientRect().height || getAutoInputMinH();
  document.addEventListener("mousemove", onInputResizeMove);
  document.addEventListener("touchmove", onInputResizeMove, { passive: false });
  document.addEventListener("mouseup", onInputResizeEnd);
  document.addEventListener("touchend", onInputResizeEnd);
  e.preventDefault();
}

function onInputResizeMove(e) {
  if (!isResizingInput) return;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const dy = resizeStartY - clientY;
  setManualInputHeight(resizeStartInputH + dy);
  e.preventDefault();
}

function onInputResizeEnd() {
  isResizingInput = false;
  document.removeEventListener("mousemove", onInputResizeMove);
  document.removeEventListener("touchmove", onInputResizeMove);
  document.removeEventListener("mouseup", onInputResizeEnd);
  document.removeEventListener("touchend", onInputResizeEnd);
}

if (inputResizeHandle) {
  inputResizeHandle.addEventListener("mousedown", onInputResizeStart);
  inputResizeHandle.addEventListener("touchstart", onInputResizeStart, { passive: false });
}

if (window.RemoteLabLayout?.subscribe) {
  window.RemoteLabLayout.subscribe(() => {
    syncInputHeightForLayout();
  });
} else {
  window.addEventListener("resize", syncInputHeightForLayout);
  window.visualViewport?.addEventListener("resize", syncInputHeightForLayout);
}

// ---- Draft persistence ----
function saveDraft() {
  if (!currentSessionId || isComposerPendingForCurrentSession()) return;
  writeStoredDraft(currentSessionId, msgInput.value);
}
function restoreDraft() {
  if (typeof setComposerActiveSession === "function") {
    setComposerActiveSession(currentSessionId);
  }
  syncComposerDraftState(currentSessionId, readStoredDraft(currentSessionId));
  msgInput.value = getComposerDraftText(currentSessionId);
  autoResizeInput();
  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }
  syncComposerPendingUi();
}
function clearDraft(sessionId = currentSessionId) {
  writeStoredDraft(sessionId, "");
}

msgInput.addEventListener("input", () => {
  autoResizeInput();
  saveDraft();
});
// Set initial height
requestAnimationFrame(() => restoreSavedInputHeight());

function releaseImageObjectUrls(images = []) {
  for (const image of images) {
    if (image?.objectUrl) {
      URL.revokeObjectURL(image.objectUrl);
    }
  }
}

function restoreFailedSendState(sessionId, text, images, requestId = "") {
  const pendingSend = getComposerPendingSendSnapshot();
  if (pendingSend && (!requestId || pendingSend.requestId === requestId)) {
    clearComposerPendingSendSnapshot(requestId);
  }
  writeStoredDraft(sessionId, text || "");
  replaceComposerAttachmentsSnapshot(sessionId, images);
  syncComposerPendingUi();
  if (sessionId !== currentSessionId) {
    return;
  }

  if (!msgInput.value.trim() && text) {
    msgInput.value = text;
    autoResizeInput();
    saveDraft();
  }

  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }

  if (typeof focusComposer === "function") {
    focusComposer({ force: true, preventScroll: true });
  } else {
    msgInput.focus();
  }
}

// ---- Sidebar tabs ----
let activeTab = normalizeSidebarTab(
  (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : "") ||
    pendingNavigationState.tab ||
    localStorage.getItem(ACTIVE_SIDEBAR_TAB_STORAGE_KEY) ||
    "sessions",
); // "sessions" | "settings"

if (typeof setChatActiveTab === "function") {
  setChatActiveTab(activeTab, {
    normalizeTab: normalizeSidebarTab,
  });
  activeTab = typeof getActiveSidebarTabValue === "function"
    ? getActiveSidebarTabValue()
    : activeTab;
} else if (typeof dispatchChatStore === "function") {
  dispatchChatStore({
    type: "set-active-tab",
    value: activeTab,
    normalizeTab: normalizeSidebarTab,
  });
}

function switchTab(tab, { syncState = true } = {}) {
  const nextTab = normalizeSidebarTab(tab);
  if (typeof setChatActiveTab === "function") {
    setChatActiveTab(nextTab, {
      normalizeTab: normalizeSidebarTab,
    });
    activeTab = typeof getActiveSidebarTabValue === "function"
      ? getActiveSidebarTabValue()
      : nextTab;
  } else {
    activeTab = nextTab;
    if (typeof dispatchChatStore === "function") {
      dispatchChatStore({
        type: "set-active-tab",
        value: activeTab,
        normalizeTab: normalizeSidebarTab,
      });
    }
  }
  const showingSessions = activeTab === "sessions";
  tabSessions.classList.toggle("active", activeTab === "sessions");
  tabSettings.classList.toggle("active", activeTab === "settings");
  if (typeof syncSidebarFiltersVisibility === "function") {
    syncSidebarFiltersVisibility(showingSessions);
  } else if (sidebarFilters) {
    sidebarFilters.classList.toggle("hidden", !showingSessions);
  }
  sessionList.style.display = showingSessions ? "" : "none";
  settingsPanel.classList.toggle("visible", activeTab === "settings");
  sessionListFooter.classList.toggle("hidden", activeTab === "settings");
  sortSessionListBtn.classList.toggle("hidden", activeTab === "settings");
  newSessionBtn.classList.toggle("hidden", activeTab === "settings");
  if (syncState) {
    syncBrowserState();
  }
}

tabSessions.addEventListener("click", () => switchTab("sessions"));
tabSettings.addEventListener("click", () => switchTab("settings"));

switchTab(activeTab, { syncState: false });
