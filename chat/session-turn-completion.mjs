export function createSessionTurnCompletionHelpers(services) {
  const {
    REPLY_SELF_CHECK_ACCEPT_STATUS,
    REPLY_SELF_CHECK_DEFAULT_REASON,
    REPLY_SELF_CHECK_REVIEWING_STATUS,
    REPLY_SELF_REPAIR_INTERNAL_OPERATION,
    allowsSessionTurnCompletionEffects,
    appendAssistantMessage,
    appendEvent,
    broadcastSessionInvalidation,
    buildReplySelfCheckPrompt,
    buildReplySelfRepairPrompt,
    buildResultAssetReadyMessage,
    clearPendingReplySelfCheck,
    clearRenameState,
    collectGeneratedResultFilesFromRun,
    contextOperationEvent,
    dispatchSessionConnectorActions,
    dispatchSessionEmailCompletionTargets,
    findAssistantAttachmentMessageForRun,
    findResultAssetMessageForRun,
    getCompactionServices,
    getRun,
    getRunManifest,
    getSession,
    getSessionQueueCount,
    getTaskCardFollowupServices,
    getToolDefinitionAsync,
    hasPendingReplySelfCheck,
    isInternalSession,
    isReplySelfRepairOperation,
    isSessionAutoRenamePending,
    isSessionRunning,
    isTerminalRunState,
    listRunIds,
    loadReplySelfCheckTurnContext,
    markPendingReplySelfCheck,
    maybeApplyAssistantTaskCard,
    maybeAutoCompact,
    normalizeAttachmentSizeBytes,
    normalizePublishedResultAssetAttachments,
    normalizeSessionDescription,
    normalizeSessionGroup,
    normalizeSessionWorkflowPriority,
    normalizeSessionWorkflowState,
    nowIso,
    parseReplySelfCheckDecision,
    publishLocalFileAssetFromPath,
    renameSession,
    runDetachedAssistantPrompt,
    sanitizeAllCompletionTargets,
    sanitizeEmailCompletionTargets,
    scheduleQueuedFollowUpDispatch,
    scheduleSessionTaskCardSuggestion,
    sendCompletionPush,
    sendMessage,
    setRenameState,
    statusEvent,
    summarizeReplySelfCheckReason,
    triggerSessionLabelSuggestion,
    triggerSessionWorkflowStateSuggestion,
    updateRun,
    updateSessionGrouping,
    updateSessionWorkflowClassification,
  } = services;

  function queueSessionCompletionTargets(session, run, manifest) {
    if (!session?.id || !run?.id) return false;
    if (manifest?.internalOperation && !isReplySelfRepairOperation(manifest)) return false;
    const targets = sanitizeAllCompletionTargets(session.completionTargets || []);
    if (targets.length === 0) return false;
    dispatchSessionConnectorActions({
      ...session,
      completionTargets: targets,
    }, run).catch((error) => {
      console.error(`[connector-action-dispatcher] ${session.id}/${run.id}: ${error.message}`);
    });
    return true;
  }

  async function maybeSendSessionCompletionPush(sessionId, fallbackSession = null) {
    const currentSession = await getSession(sessionId) || fallbackSession;
    if (!currentSession?.id) return false;
    if (isSessionRunning(currentSession)) return false;
    if (getSessionQueueCount(currentSession) > 0) return false;
    if (hasPendingReplySelfCheck(sessionId)) return false;
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
      if (manifest?.internalOperation && !isReplySelfRepairOperation(manifest)) continue;
      queueSessionCompletionTargets(session, run, manifest);
    }
  }

  function normalizeReplySelfCheckSetting(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'all';
    if (['0', 'false', 'off', 'disabled', 'disable', 'none'].includes(normalized)) {
      return 'off';
    }
    if (['1', 'true', 'on', 'enabled', 'enable', 'all'].includes(normalized)) {
      return 'all';
    }
    return normalized;
  }

  function buildReplySelfCheckReviewingOperation() {
    return contextOperationEvent({
      operation: 'continue_turn',
      phase: 'queued',
      trigger: 'automatic',
      title: 'Automatic continuation reviewing',
      summary: 'RemoteLab is checking whether the latest reply stopped too early.',
    });
  }

  function buildReplySelfCheckSkippedOperation(title, summary, reason = '') {
    return contextOperationEvent({
      operation: 'continue_turn',
      phase: 'skipped',
      trigger: 'automatic',
      title,
      summary,
      reason,
    });
  }

  function buildReplySelfCheckAppliedOperation(reason = '') {
    return contextOperationEvent({
      operation: 'continue_turn',
      phase: 'applied',
      trigger: 'automatic',
      title: 'Automatic continuation started',
      summary: 'RemoteLab launched a follow-up turn to finish avoidable unfinished work.',
      reason,
    });
  }

  function buildReplySelfCheckFailedOperation(title, summary, reason = '') {
    return contextOperationEvent({
      operation: 'continue_turn',
      phase: 'failed',
      trigger: 'automatic',
      title,
      summary,
      reason,
    });
  }

  async function shouldRunReplySelfCheck(session, run, manifest) {
    if (!session?.id || !run?.id) return false;
    if (manifest?.internalOperation) return false;
    if (session.archived || isInternalSession(session)) return false;
    if (run.state !== 'completed') return false;
    const setting = normalizeReplySelfCheckSetting(process.env.REMOTELAB_REPLY_SELF_CHECK);
    if (setting === 'off') return false;
    if (setting === 'all') return true;
    const toolDefinition = await getToolDefinitionAsync(run.tool || session.tool || '');
    if (!toolDefinition) return false;
    if (setting === 'micro-agent') {
      return toolDefinition.id === 'micro-agent' || toolDefinition.toolProfile === 'micro-agent';
    }
    const enabledTools = new Set(setting.split(',').map((entry) => entry.trim()).filter(Boolean));
    return enabledTools.has(toolDefinition.id || '') || enabledTools.has(toolDefinition.toolProfile || '');
  }

  async function prepareReplySelfCheck(sessionId, session, run, manifest) {
    if (!await shouldRunReplySelfCheck(session, run, manifest)) {
      return null;
    }
    const latestSession = await getSession(sessionId);
    if (!latestSession || latestSession.activeRunId || getSessionQueueCount(latestSession) > 0) {
      return null;
    }

    const { userMessage, assistantTurnText } = await loadReplySelfCheckTurnContext(sessionId, run.id, {
      loadSessionHistory: services.loadHistory,
    });
    if (!assistantTurnText) {
      return null;
    }

    markPendingReplySelfCheck(sessionId, run.id);
    await appendEvent(sessionId, statusEvent(REPLY_SELF_CHECK_REVIEWING_STATUS));
    await appendEvent(sessionId, buildReplySelfCheckReviewingOperation());
    broadcastSessionInvalidation(sessionId);

    return {
      session: latestSession,
      userMessage,
      assistantTurnText,
    };
  }

  async function maybeRunReplySelfCheck(sessionId, session, run, manifest, preparedCheck = null) {
    if (!preparedCheck) {
      return { attempted: false, continued: false };
    }

    const { userMessage, assistantTurnText } = preparedCheck;
    const effectiveSession = preparedCheck.session || session;

    let reviewText = '';
    try {
      reviewText = await runDetachedAssistantPrompt({
        id: sessionId,
        folder: effectiveSession.folder,
        tool: run.tool || effectiveSession.tool,
        model: run.model || undefined,
        effort: run.effort || undefined,
        thinking: false,
      }, buildReplySelfCheckPrompt({ userMessage, assistantTurnText }));
    } catch (error) {
      const reason = summarizeReplySelfCheckReason(error.message, 'background reviewer error');
      await appendEvent(sessionId, statusEvent(`Assistant self-check: review failed — ${reason}`));
      await appendEvent(sessionId, buildReplySelfCheckFailedOperation(
        'Automatic continuation review failed',
        'RemoteLab could not complete the background early-stop review.',
        reason,
      ));
      clearPendingReplySelfCheck(sessionId, { broadcast: true });
      return { attempted: true, continued: false };
    }

    const reviewDecision = parseReplySelfCheckDecision(reviewText);
    const refreshed = await getSession(sessionId);
    if (!refreshed || refreshed.activeRunId || getSessionQueueCount(refreshed) > 0) {
      await appendEvent(sessionId, statusEvent('Assistant self-check: skipped automatic continuation because new work arrived first.'));
      await appendEvent(sessionId, buildReplySelfCheckSkippedOperation(
        'Automatic continuation skipped',
        'New work arrived before RemoteLab could launch the follow-up turn.',
        'new work arrived first',
      ));
      clearPendingReplySelfCheck(sessionId, { broadcast: true });
      return { attempted: true, continued: false };
    }

    if (reviewDecision.action !== 'continue') {
      const reason = summarizeReplySelfCheckReason(reviewDecision.reason, 'the latest reply already finished the requested work');
      await appendEvent(sessionId, statusEvent(REPLY_SELF_CHECK_ACCEPT_STATUS));
      await appendEvent(sessionId, buildReplySelfCheckSkippedOperation(
        'Automatic continuation not needed',
        'RemoteLab kept the latest reply as-is after review.',
        reason,
      ));
      clearPendingReplySelfCheck(sessionId, { broadcast: true });
      return { attempted: true, continued: false };
    }

    const reason = summarizeReplySelfCheckReason(reviewDecision.reason, REPLY_SELF_CHECK_DEFAULT_REASON);
    await appendEvent(sessionId, statusEvent(`Assistant self-check: continuing automatically — ${reason}`));
    await appendEvent(sessionId, buildReplySelfCheckAppliedOperation(reason));
    broadcastSessionInvalidation(sessionId);

    try {
      await sendMessage(sessionId, buildReplySelfRepairPrompt({
        userMessage,
        assistantTurnText,
        reviewDecision,
      }), [], {
        tool: run.tool || session.tool,
        model: run.model || undefined,
        effort: run.effort || undefined,
        thinking: !!run.thinking,
        recordUserMessage: false,
        queueIfBusy: false,
        internalOperation: REPLY_SELF_REPAIR_INTERNAL_OPERATION,
      });
    } catch (error) {
      const failureReason = summarizeReplySelfCheckReason(error.message, 'unable to launch follow-up reply');
      await appendEvent(sessionId, statusEvent(`Assistant self-check: failed to continue automatically — ${failureReason}`));
      await appendEvent(sessionId, buildReplySelfCheckFailedOperation(
        'Automatic continuation failed',
        'RemoteLab could not launch the follow-up turn.',
        failureReason,
      ));
      clearPendingReplySelfCheck(sessionId, { broadcast: true });
      return { attempted: true, continued: false };
    }

    clearPendingReplySelfCheck(sessionId);
    return { attempted: true, continued: true };
  }

  async function maybePublishRunResultAssets(sessionId, run, manifest, normalizedEvents) {
    if (manifest?.internalOperation) {
      return false;
    }
    if (await findAssistantAttachmentMessageForRun(sessionId, run.id)) {
      return false;
    }

    let attachments = normalizePublishedResultAssetAttachments(run?.publishedResultAssets || []);
    if (attachments.length === 0) {
      const generatedFiles = await collectGeneratedResultFilesFromRun(run, manifest, normalizedEvents);
      if (generatedFiles.length === 0) {
        return false;
      }

      const publishedAssets = [];
      for (const file of generatedFiles) {
        try {
          const published = await publishLocalFileAssetFromPath({
            sessionId,
            localPath: file.localPath,
            originalName: file.originalName,
            mimeType: file.mimeType,
            createdBy: 'assistant',
          });
          publishedAssets.push({
            assetId: published.id,
            originalName: published.originalName || file.originalName,
            mimeType: published.mimeType || file.mimeType,
            ...(normalizeAttachmentSizeBytes(published.sizeBytes) ? { sizeBytes: normalizeAttachmentSizeBytes(published.sizeBytes) } : {}),
          });
        } catch (error) {
          console.error(`[result-file-assets] Failed to publish ${file.localPath}: ${error?.message || error}`);
        }
      }

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
      attachments = normalizePublishedResultAssetAttachments(updatedRun.publishedResultAssets || publishedAssets);
    }

    if (attachments.length === 0) {
      return false;
    }
    if (await findResultAssetMessageForRun(sessionId, run.id)) {
      return false;
    }

    await appendAssistantMessage(sessionId, buildResultAssetReadyMessage(attachments), [], {
      preSavedAttachments: attachments,
      source: 'result_file_assets',
      resultRunId: run.id,
      ...(run.requestId ? { requestId: run.requestId } : {}),
    });
    return true;
  }

  async function applyGeneratedSessionGrouping(sessionId, summaryResult) {
    const summary = summaryResult?.summary;
    if (!summary) return getSession(sessionId);
    const current = await getSession(sessionId);
    if (!current) return null;

    const nextGroup = summary.group === undefined
      ? (current.group || '')
      : normalizeSessionGroup(summary.group || '');
    const nextDescription = summary.description === undefined
      ? (current.description || '')
      : normalizeSessionDescription(summary.description || '');

    if ((nextGroup || '') === (current.group || '') && (nextDescription || '') === (current.description || '')) {
      return current;
    }

    return updateSessionGrouping(sessionId, {
      group: nextGroup,
      description: nextDescription,
    });
  }

  function scheduleSessionWorkflowStateSuggestion(session, run) {
    if (!session?.id || !run || session.archived || isInternalSession(session)) {
      return false;
    }

    const suggestionDone = triggerSessionWorkflowStateSuggestion({
      id: session.id,
      folder: session.folder,
      name: session.name || '',
      group: session.group || '',
      description: session.description || '',
      workflowState: session.workflowState || '',
      workflowPriority: session.workflowPriority || '',
      tool: run.tool || session.tool,
      model: run.model || undefined,
      thinking: false,
      runState: run.state,
      queuedCount: getSessionQueueCount(session),
    });

    suggestionDone.then(async (result) => {
      const nextWorkflowState = normalizeSessionWorkflowState(result?.workflowState || '');
      const nextWorkflowPriority = normalizeSessionWorkflowPriority(result?.workflowPriority || '');
      const shouldClearWorkflowState = result?.shouldClearWorkflowState === true;
      if (!nextWorkflowState && !nextWorkflowPriority && !shouldClearWorkflowState) return;
      await updateSessionWorkflowClassification(session.id, {
        ...(nextWorkflowState || shouldClearWorkflowState ? { workflowState: nextWorkflowState } : {}),
        ...(nextWorkflowPriority || shouldClearWorkflowState ? { workflowPriority: nextWorkflowPriority } : {}),
      });
    }).catch((error) => {
      console.error(`[workflow-state] Failed to update workflow state for ${session.id?.slice(0, 8)}: ${error.message}`);
    });

    return true;
  }

  async function runSessionTurnCompletionEffects(sessionId, latestSession, finalizedRun, manifest) {
    let session = latestSession;
    let sessionChanged = false;
    const allowCompletionEffects = allowsSessionTurnCompletionEffects(manifest);

    if (allowCompletionEffects) {
      const taskCardSession = await maybeApplyAssistantTaskCard(sessionId, finalizedRun.id, session, getTaskCardFollowupServices());
      if (taskCardSession) {
        session = taskCardSession;
        sessionChanged = true;
      }
    }

    const hasQueuedFollowUps = getSessionQueueCount(session) > 0;
    if (hasQueuedFollowUps) {
      scheduleQueuedFollowUpDispatch(sessionId);
    }

    const autoCompactionQueued = allowCompletionEffects && !hasQueuedFollowUps
      ? await maybeAutoCompact(sessionId, session, finalizedRun, manifest, getCompactionServices())
      : false;

    if (autoCompactionQueued) {
      return { session, sessionChanged };
    }

    if (allowCompletionEffects) {
      scheduleSessionTaskCardSuggestion(session, finalizedRun, getTaskCardFollowupServices());
    }

    if (allowCompletionEffects && !hasQueuedFollowUps) {
      queueSessionCompletionTargets(session, finalizedRun, manifest);
      scheduleSessionWorkflowStateSuggestion(session, finalizedRun);
    }

    const needsRename = isSessionAutoRenamePending(session);
    const needsGrouping = !session.group || !session.description;

    if (needsRename || needsGrouping) {
      if (needsRename) {
        setRenameState(sessionId, 'pending');
      }

      const labelSuggestionDone = triggerSessionLabelSuggestion(
        {
          id: sessionId,
          folder: session.folder,
          name: session.name || '',
          group: session.group || '',
          description: session.description || '',
          sourceName: session.sourceName || '',
          autoRenamePending: session.autoRenamePending,
          tool: finalizedRun.tool || session.tool,
          model: finalizedRun.model || undefined,
          effort: finalizedRun.effort || undefined,
          thinking: !!finalizedRun.thinking,
        },
        async (newName) => {
          const currentSession = await getSession(sessionId);
          if (!isSessionAutoRenamePending(currentSession)) return null;
          return renameSession(sessionId, newName);
        },
      );

      if (needsRename) {
        labelSuggestionDone.then(async (labelResult) => {
          const grouped = await applyGeneratedSessionGrouping(sessionId, labelResult);
          const updated = grouped || await getSession(sessionId);
          const stillPendingRename = !!updated && isSessionAutoRenamePending(updated);
          if (stillPendingRename) {
            setRenameState(
              sessionId,
              'failed',
              labelResult?.rename?.error || labelResult?.error || 'No title generated',
            );
          } else {
            clearRenameState(sessionId, { broadcast: true });
          }
          if (allowCompletionEffects && !hasQueuedFollowUps) {
            await maybeSendSessionCompletionPush(sessionId, updated || session);
          }
        });
        return { session, sessionChanged };
      }

      labelSuggestionDone.then(async (labelResult) => {
        await applyGeneratedSessionGrouping(sessionId, labelResult);
      });
    }

    if (allowCompletionEffects && !hasQueuedFollowUps) {
      void maybeSendSessionCompletionPush(sessionId, session);
    }

    return { session, sessionChanged };
  }

  return {
    applyGeneratedSessionGrouping,
    maybePublishRunResultAssets,
    maybeRunReplySelfCheck,
    maybeSendSessionCompletionPush,
    prepareReplySelfCheck,
    queueSessionCompletionTargets,
    resumePendingCompletionTargets,
    runSessionTurnCompletionEffects,
    scheduleSessionWorkflowStateSuggestion,
  };
}
