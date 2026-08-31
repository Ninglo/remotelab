import { normalizeReplyPublicationResponseIds } from './reply-publication.mjs';

export function createSessionTurnCompletionHelpers(services) {
  const {
    allowsSessionTurnCompletionEffects,
    applySessionStateSuggestion,
    appendAssistantMessage,
    buildResultAssetReadyMessage,
    collectAssistantLocalMarkdownImageRewrites,
    collectGeneratedResultFilesFromRun,
    dispatchSessionConnectorActions,
    findAssistantAttachmentMessageForRun,
    findResultAssetMessageForRun,
    getCompactionServices,
    getRun,
    getRunManifest,
    getSession,
    getSessionQueueCount,
    getWorkSummaryFollowupServices,
    isInternalSession,
    isSessionRunning,
    isTerminalRunState,
    listRunIds,
    loadHistory,
    maybeApplyAssistantWorkSummary,
    maybeAutoCompact,
    normalizeAttachmentSizeBytes,
    normalizePublishedResultAssetAttachments,
    nowIso,
    publishLocalFileAssetFromPath,
    sanitizeAllCompletionTargets,
    scheduleQueuedFollowUpDispatch,
    sendCompletionPush,
    triggerSessionStateSuggestion,
    updateRun,
  } = services;

  function trimString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function getReplyPublicationRootRunId(run) {
    return trimString(run?.replyPublicationRootRunId) || trimString(run?.id);
  }

  async function updateReplyPublication(run, updater) {
    const rootRunId = getReplyPublicationRootRunId(run);
    if (!rootRunId || typeof updater !== 'function') return null;
    return updateRun(rootRunId, (existing) => {
      const current = existing?.replyPublication && typeof existing.replyPublication === 'object'
        ? existing.replyPublication
        : {
            responseIds: normalizeReplyPublicationResponseIds([], trimString(existing?.responseId || existing?.requestId || run?.responseId || run?.requestId)),
            state: 'running',
            resolution: '',
            rootRunId,
            finalRunId: rootRunId,
            continuationRunIds: [],
            updatedAt: nowIso(),
            readyAt: null,
            failedAt: null,
            lastError: null,
          };
      const next = updater(current, existing);
      if (!next || typeof next !== 'object') {
        return existing;
      }
      return {
        ...existing,
        replyPublication: {
          ...current,
          ...next,
          responseIds: normalizeReplyPublicationResponseIds(
            next.responseIds,
            trimString(existing?.responseId || existing?.requestId || run?.responseId || run?.requestId),
          ),
          updatedAt: trimString(next.updatedAt) || nowIso(),
        },
      };
    });
  }

  async function queueSessionCompletionTargets(session, run, manifest) {
    if (!session?.id || !run?.id || manifest?.internalOperation) return false;
    const latestRun = await getRun(run.id) || run;
    const publication = latestRun?.replyPublication;
    if (!publication || trimString(publication.state).toLowerCase() !== 'ready') {
      return false;
    }
    if (trimString(publication.finalRunId) !== trimString(latestRun.id)) {
      return false;
    }
    const targets = sanitizeAllCompletionTargets(session.completionTargets || []);
    if (targets.length === 0) return false;
    dispatchSessionConnectorActions({
      ...session,
      completionTargets: targets,
    }, latestRun).catch((error) => {
      console.error(`[connector-action-dispatcher] ${session.id}/${latestRun.id}: ${error.message}`);
    });
    return true;
  }

  async function maybeSendSessionCompletionPush(sessionId, fallbackSession = null) {
    const currentSession = await getSession(sessionId) || fallbackSession;
    if (!currentSession?.id) return false;
    if (isSessionRunning(currentSession)) return false;
    if (getSessionQueueCount(currentSession) > 0) return false;
    sendCompletionPush({ ...currentSession, id: sessionId }).catch(() => {});
    return true;
  }

  async function resumePendingCompletionTargets() {
    for (const runId of await listRunIds()) {
      const run = await getRun(runId);
      if (!run || !isTerminalRunState(run.state)) continue;
      const session = await getSession(run.sessionId);
      if (!session?.completionTargets?.length) continue;
      const manifest = await getRunManifest(runId);
      if (manifest?.internalOperation) continue;
      await queueSessionCompletionTargets(session, run, manifest);
    }
  }

  async function loadLatestTurnBodyEvents(sessionId) {
    const history = await loadHistory(sessionId, { includeBodies: true });
    const body = [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const event = history[index];
      if (event?.type === 'message' && event.role === 'user') {
        return body.reverse();
      }
      body.push(event);
    }
    return body.reverse();
  }

  async function maybePublishRunResultAssets(sessionId, run, manifest, normalizedEvents) {
    if (manifest?.internalOperation) {
      return false;
    }
    if (await findAssistantAttachmentMessageForRun(sessionId, run.id)) {
      return false;
    }

    let publishedResultAssets = Array.isArray(run?.publishedResultAssets)
      ? run.publishedResultAssets
      : [];
    let attachments = normalizePublishedResultAssetAttachments(publishedResultAssets);
    if (attachments.length === 0) {
      const generatedFiles = await collectGeneratedResultFilesFromRun(run, manifest, normalizedEvents);
      if (generatedFiles.length === 0) {
        return false;
      }

      const publishedAssets = (await Promise.all(generatedFiles.map(async (file) => {
        try {
          const published = await publishLocalFileAssetFromPath({
            sessionId,
            localPath: file.localPath,
            originalName: file.originalName,
            mimeType: file.mimeType,
            createdBy: 'assistant',
          });
          return {
            assetId: published.id,
            localPath: file.localPath,
            originalName: published.originalName || file.originalName,
            mimeType: published.mimeType || file.mimeType,
            ...(normalizeAttachmentSizeBytes(published.sizeBytes) ? { sizeBytes: normalizeAttachmentSizeBytes(published.sizeBytes) } : {}),
          };
        } catch (error) {
          console.error(`[result-file-assets] Failed to publish ${file.localPath}: ${error?.message || error}`);
          return null;
        }
      }))).filter(Boolean);

      if (publishedAssets.length === 0) {
        return false;
      }

      const updatedRun = await updateRun(run.id, (current) => ({
        ...current,
        publishedResultAssets: Array.isArray(current.publishedResultAssets) && current.publishedResultAssets.length > 0
          ? current.publishedResultAssets
          : publishedAssets,
        publishedResultAssetsAt: current.publishedResultAssetsAt || nowIso(),
      })) || run;
      publishedResultAssets = Array.isArray(updatedRun.publishedResultAssets) && updatedRun.publishedResultAssets.length > 0
        ? updatedRun.publishedResultAssets
        : publishedAssets;
      attachments = normalizePublishedResultAssetAttachments(publishedResultAssets);
    }

    if (attachments.length === 0) {
      return false;
    }

    let didPublish = false;
    const latestTurnBodyEvents = await loadLatestTurnBodyEvents(sessionId);
    const localMarkdownImageRewrites = await collectAssistantLocalMarkdownImageRewrites(
      manifest,
      latestTurnBodyEvents,
      publishedResultAssets,
    );

    if (!(await findResultAssetMessageForRun(sessionId, run.id))) {
      await appendAssistantMessage(sessionId, buildResultAssetReadyMessage(attachments), [], {
        preSavedAttachments: attachments,
        source: 'result_file_assets',
        resultRunId: run.id,
        ...(run.responseId ? { responseId: run.responseId } : {}),
        ...(localMarkdownImageRewrites.length > 0 ? { localMarkdownImageRewrites } : {}),
        ...(run.requestId ? { requestId: run.requestId } : {}),
      });
      didPublish = true;
    }

    return didPublish;
  }

  function scheduleSessionStateSuggestion(session, run) {
    if (!session?.id || !run || session.archived || isInternalSession(session)) {
      return false;
    }

    const suggestionDone = triggerSessionStateSuggestion({
      id: session.id,
      folder: session.folder,
      name: session.name || '',
      space: session.space || '',
      group: session.group || '',
      description: session.description || '',
      sourceName: session.sourceName || '',
      workflowState: session.workflowState || '',
      workflowPriority: session.workflowPriority || '',
      workSummary: session.workSummary || null,
      autoRenamePending: session.autoRenamePending,
      tool: run.tool || session.tool,
      model: run.model || undefined,
      effort: 'low',
      thinking: false,
      runState: run.state,
      queuedCount: getSessionQueueCount(session),
    });

    suggestionDone.then(async (result) => {
      if (!result?.ok) return;
      await applySessionStateSuggestion(session.id, result, run.id);
    }).catch((error) => {
      console.error(`[session-state] Failed to update session state for ${session.id?.slice(0, 8)}: ${error.message}`);
    });

    return true;
  }

  async function runSessionTurnCompletionEffects(sessionId, latestSession, finalizedRun, manifest) {
    let session = latestSession;
    let sessionChanged = false;
    const allowCompletionEffects = allowsSessionTurnCompletionEffects(manifest);

    if (finalizedRun.state === 'failed' || finalizedRun.state === 'cancelled') {
      await updateReplyPublication(finalizedRun, (current) => ({
        ...current,
        state: finalizedRun.state,
        resolution: '',
        finalRunId: trimString(finalizedRun.id),
        failedAt: current.failedAt || nowIso(),
        readyAt: null,
        lastError: trimString(finalizedRun.failureReason),
      }));
    } else if (finalizedRun.state === 'completed') {
      await updateReplyPublication(finalizedRun, (current) => ({
        ...current,
        state: 'ready',
        resolution: 'accepted_as_is',
        finalRunId: trimString(finalizedRun.id),
        readyAt: current.readyAt || nowIso(),
        failedAt: null,
        lastError: null,
      }));
    }

    if (allowCompletionEffects) {
      const workSummarySession = await maybeApplyAssistantWorkSummary(sessionId, finalizedRun.id, session, getWorkSummaryFollowupServices());
      if (workSummarySession) {
        session = workSummarySession;
        sessionChanged = true;
      }
    }

    const hasQueuedFollowUps = getSessionQueueCount(session) > 0;
    if (hasQueuedFollowUps) {
      scheduleQueuedFollowUpDispatch(sessionId);
    }

    if (allowCompletionEffects && !hasQueuedFollowUps) {
      await queueSessionCompletionTargets(session, finalizedRun, manifest);
      scheduleSessionStateSuggestion(session, finalizedRun);
    }

    const autoCompactionQueued = allowCompletionEffects && !hasQueuedFollowUps
      ? await maybeAutoCompact(sessionId, session, finalizedRun, manifest, getCompactionServices())
      : false;
    if (autoCompactionQueued) {
      return { session, sessionChanged };
    }

    if (allowCompletionEffects && !hasQueuedFollowUps) {
      void maybeSendSessionCompletionPush(sessionId, session);
    }

    return { session, sessionChanged };
  }

  return {
    maybePublishRunResultAssets,
    maybeSendSessionCompletionPush,
    queueSessionCompletionTargets,
    resumePendingCompletionTargets,
    runSessionTurnCompletionEffects,
    scheduleSessionStateSuggestion,
  };
}
