import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { loadHistory, readLastTurnEvents } from './history.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { createToolInvocation, resolveCommand, resolveCwd } from './process-runner.mjs';
import { applyManagedRuntimeEnv, applySharedCodexLock } from './runtime-policy.mjs';
import {
  normalizeGeneratedSessionTitle,
  isSessionAutoRenamePending,
  normalizeSessionDescription,
  normalizeSessionGroup,
  normalizeSessionSpace,
} from './session-naming.mjs';
import { appendUsageLedgerRecord, buildDetachedUsageLedgerRecord } from './usage-ledger.mjs';
import { loadSessionLabelPromptContext } from './session-label-context.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import { normalizeSessionTaskCard } from './session-task-card.mjs';
import { assessSessionWorkstream } from './session-dispatch.mjs';

function clipPromptText(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !Number.isInteger(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars === 1) return '…';
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatEventsForPrompt(events, {
  userLimit = 400,
  assistantLimit = 600,
  toolUseLimit = 400,
  toolResultLimit = 600,
  reasoningLimit = 600,
  statusLimit = 200,
} = {}) {
  const lines = [];
  for (const evt of events) {
    switch (evt.type) {
      case 'message':
        if (evt.role === 'user') {
          lines.push(`USER: ${clipPromptText(evt.content || '', userLimit)}`);
        } else if (evt.role === 'assistant') {
          lines.push(`ASSISTANT: ${clipPromptText(evt.content || '', assistantLimit)}`);
        }
        break;
      case 'file_change':
        lines.push(`FILE ${(evt.changeType || 'changed').toUpperCase()}: ${evt.filePath}`);
        break;
      case 'tool_use':
        lines.push(`TOOL CALLED: ${evt.toolName}${evt.toolInput ? ` — ${clipPromptText(evt.toolInput, toolUseLimit)}` : ''}`);
        break;
      case 'tool_result':
        lines.push(`TOOL RESULT: ${evt.toolName || 'tool'}${evt.output ? ` — ${clipPromptText(evt.output, toolResultLimit)}` : ''}`);
        break;
      case 'reasoning':
        if (evt.content) {
          lines.push(`REASONING: ${clipPromptText(evt.content, reasoningLimit)}`);
        }
        break;
      case 'status':
        if (evt.message) {
          lines.push(`STATUS: ${clipPromptText(evt.message, statusLimit)}`);
        }
        break;
    }
  }
  return lines.join('\n');
}

function formatTurnForPrompt(events) {
  return formatEventsForPrompt(events);
}

function formatHistoryForPrompt(events) {
  return formatEventsForPrompt(events, {
    userLimit: 1200,
    assistantLimit: 1800,
    toolUseLimit: 900,
    toolResultLimit: 1200,
    reasoningLimit: 1200,
    statusLimit: 500,
  });
}

function appendSummarizerUsage(sessionMeta, usageEvent, usageTracking = {}, state = 'completed') {
  if (!usageEvent || !usageTracking) return false;
  try {
    const record = buildDetachedUsageLedgerRecord({
      session: sessionMeta,
      usageEvent,
      tracking: {
        tool: sessionMeta.tool,
        model: sessionMeta.model,
        effort: sessionMeta.effort,
        ...usageTracking,
        state,
      },
    });
    if (!record) return false;
    return appendUsageLedgerRecord(record);
  } catch (error) {
    console.error(`[usage-ledger] Failed to append summarizer usage for ${sessionMeta?.id?.slice?.(0, 8) || 'unknown'}: ${error.message}`);
    return false;
  }
}

async function runToolJsonPrompt(sessionMeta, prompt, usageTracking = null) {
  const {
    id: sessionId,
    folder,
    tool,
    model,
    effort,
    thinking,
  } = sessionMeta;

  if (!tool) {
    throw new Error('Session label suggestion requires an explicit tool');
  }

  const { command, adapter, args, envOverrides, runtimeFamily } = await createToolInvocation(tool, prompt, {
    dangerouslySkipPermissions: true,
    model,
    effort,
    thinking,
    systemPrefix: '',
  });
  const resolvedCmd = await resolveCommand(command);
  const lockedInvocation = applySharedCodexLock(tool, resolvedCmd, args, runtimeFamily);
  const resolvedFolder = resolveCwd(folder);
  console.log(
    `[summarizer] Calling tool=${tool} cmd=${lockedInvocation.command} model=${model || 'default'} effort=${effort || 'default'} thinking=${!!thinking} for session ${sessionId.slice(0, 8)}`
  );

  let subEnv = buildToolProcessEnv(envOverrides || {});
  delete subEnv.CLAUDECODE;
  delete subEnv.CLAUDE_CODE_ENTRYPOINT;
  subEnv = await applyManagedRuntimeEnv(tool, subEnv, {
    runtimeFamily,
    codexHomeMode: process.env.REMOTELAB_CODEX_HOME_MODE || 'managed',
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(lockedInvocation.command, lockedInvocation.args, {
      cwd: resolvedFolder,
      env: subEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });
    const textParts = [];
    let latestUsageEvent = null;

    rl.on('line', (line) => {
      const events = adapter.parseLine(line);
      for (const evt of events) {
        if (evt.type === 'message' && evt.role === 'assistant') {
          textParts.push(evt.content || '');
        } else if (evt.type === 'usage') {
          latestUsageEvent = evt;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[summarizer] stderr: ${text.slice(0, 200)}`);
    });

    proc.on('error', (err) => {
      console.error(`[summarizer] ${tool} structured prompt error for ${sessionId.slice(0, 8)}: ${err.message}`);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (latestUsageEvent && usageTracking) {
        appendSummarizerUsage(sessionMeta, latestUsageEvent, usageTracking, code === 0 ? 'completed' : 'failed');
      }
      const raw = textParts.join('\n').trim();
      if (code !== 0 && !raw) {
        reject(new Error(`${tool} exited with code ${code}`));
        return;
      }
      resolve(raw);
    });
  });
}

function parseJsonObject(modelText) {
  try {
    return JSON.parse(modelText);
  } catch {
    const jsonMatch = modelText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

function isNeutralWorkflowStateLabel(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === ''
    || normalized === 'active'
    || normalized === 'neutral'
    || normalized === 'unset'
    || normalized === 'none'
    || normalized === 'keep_active';
}

function getDefaultWorkflowPriorityForState(workflowState) {
  switch (normalizeSessionWorkflowState(workflowState || '')) {
    case 'waiting_user':
      return 'high';
    case 'done':
      return 'low';
    case 'parked':
      return 'medium';
    default:
      return '';
  }
}

function formatTaskCardForPrompt(taskCard) {
  const normalized = normalizeSessionTaskCard(taskCard);
  if (!normalized) return '';
  return JSON.stringify(normalized, null, 2);
}

export function triggerSessionLabelSuggestion(sessionMeta, onRename, options = {}) {
  console.log(`[summarizer] triggerSessionLabelSuggestion called for session ${sessionMeta.id?.slice(0, 8)}`);
  return runSessionLabelSuggestion(sessionMeta, onRename, options).catch((err) => {
    console.error(`[summarizer] Session label suggestion error for ${sessionMeta.id?.slice(0, 8)}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
      rename: { attempted: false, renamed: false },
    };
  });
}

export function triggerSessionWorkflowStateSuggestion(sessionMeta, options = {}) {
  console.log(`[workflow-state] triggerSessionWorkflowStateSuggestion called for session ${sessionMeta.id?.slice(0, 8)}`);
  return runSessionWorkflowStateSuggestion(sessionMeta, options).catch((err) => {
    console.error(`[workflow-state] Session workflow suggestion error for ${sessionMeta.id?.slice(0, 8)}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
    };
  });
}

export function triggerSessionTaskCardSuggestion(sessionMeta, options = {}) {
  console.log(`[task-card] triggerSessionTaskCardSuggestion called for session ${sessionMeta.id?.slice(0, 8)}`);
  return runSessionTaskCardSuggestion(sessionMeta, options).catch((err) => {
    console.error(`[task-card] Session task card suggestion error for ${sessionMeta.id?.slice(0, 8)}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
    };
  });
}

async function runSessionLabelSuggestion(sessionMeta, onRename, options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    space,
    group,
    description,
    sourceName,
    autoRenamePending,
  } = sessionMeta;

  const shouldGenerateTitle = isSessionAutoRenamePending({ name, autoRenamePending });
  const shouldRefreshTitle = options.refreshTitle === true && !shouldGenerateTitle;
  const currentSpace = normalizeSessionSpace(space || '');
  const currentGroup = normalizeSessionGroup(group || '');
  const currentDescription = normalizeSessionDescription(description || '');
  const shouldGenerateGrouping = !currentSpace || !currentGroup || !currentDescription;
  const shouldRefreshGrouping = options.refreshGrouping === true && !shouldGenerateGrouping;
  const currentName = normalizeGeneratedSessionTitle(name || '', currentGroup || '');

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: true });
  if (lastTurnEvents.length === 0) {
    console.log(`[summarizer] Skipping session label suggestion for ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
      rename: { attempted: false, renamed: false },
    };
  }

  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[summarizer] Skipping session label suggestion for ${sessionId.slice(0, 8)}: empty turn text`);
    return {
      ok: false,
      skipped: 'empty_turn',
      rename: { attempted: false, renamed: false },
    };
  }

  let workstreamAssessment = null;
  if (shouldRefreshTitle || shouldRefreshGrouping) {
    const history = await loadHistory(sessionId, { includeBodies: false });
    workstreamAssessment = await assessSessionWorkstream({
      session: sessionMeta,
      text: turnText,
      history,
      candidateLabel: 'Latest completed turn',
      includePlannerAction: false,
      logPrefix: '[session-workstream] Relabel',
      runPrompt: (prompt) => runToolJsonPrompt(sessionMeta, prompt, {
        operation: 'session_workstream_assessment',
      }),
    });
  }

  const allowRefresh = workstreamAssessment?.workstreamRelation === 'same_session_shift';
  const effectiveRefreshTitle = shouldRefreshTitle && allowRefresh;
  const effectiveRefreshGrouping = shouldRefreshGrouping && allowRefresh;
  const shouldEvaluateTitle = shouldGenerateTitle || effectiveRefreshTitle;
  const shouldEvaluateGrouping = shouldGenerateGrouping || effectiveRefreshGrouping;
  if (!shouldEvaluateTitle && !shouldEvaluateGrouping) {
    return {
      ok: true,
      ...(workstreamAssessment ? { workstreamAssessment } : {}),
      skipped: workstreamAssessment?.workstreamRelation === 'separate_workstream'
        ? 'separate_workstream'
        : 'session_labels_not_needed',
      rename: { attempted: false, renamed: false },
    };
  }

  const promptContext = await loadSessionLabelPromptContext({
    ...sessionMeta,
    space: currentSpace,
    group: currentGroup,
    description: currentDescription,
  }, turnText);

  const prompt = [
    'You are naming a developer session. Be concise and literal.',
    'Use these roles: "space" = broad durable context, "group" = a recoverable workstream inside that space, "title" = the current frontier, "description" = the current work semantics.',
    'RemoteLab has a two-level sidebar: Spaces are broad context boundaries, while Projects groups are concrete work-recovery entries inside a Space.',
    'Reuse an existing Space whenever possible. Create a new Space only for a genuinely distinct long-lived domain, role, or context boundary.',
    'Avoid both extremes: do not use a broad repo/product bucket that mixes unrelated decisions, and do not create a new group for every one-off feature slice.',
    'Use existing non-archived sessions as a bounded catalog. Reuse an existing group when this session clearly belongs to the same user-facing workstream.',
    'Create a new group only when the work has a distinct outcome, lifecycle, context, or source boundary from the existing groups.',
    'If the fit is plausible but not perfect, prefer the closest existing workstream group and let the title/description carry the concrete subtask.',
    'The title should name the concrete work happening inside that group.',
    'The latest turn may be underspecified. Use earlier session context, scope-router hints, and existing session metadata to infer the right workstream before naming.',
    'Write user-visible labels in the language used by the user. When the user writes in Chinese, use concise natural Chinese for space, group, and title; reuse a fitting existing label even if the latest turn is brief.',
    '',
    `Session folder: ${folder}`,
    `Current session name: ${name || '(unnamed)'}`,
    currentSpace ? `Current Space: ${currentSpace}` : '',
    currentGroup ? `Current display group: ${currentGroup}` : '',
    currentDescription ? `Current session description: ${currentDescription}` : '',
    sourceName ? `Current source label: ${sourceName}` : '',
    promptContext.contextSummary ? `Earlier session context:\n${promptContext.contextSummary}` : '',
    promptContext.scopeRouter ? `Known scope router entries:\n${promptContext.scopeRouter}` : '',
    promptContext.existingSessions ? `Current non-archived sessions:\n${promptContext.existingSessions}` : '',
    workstreamAssessment?.workstreamRelation === 'same_session_shift'
      ? `Shared workstream assessment: same_session_shift — ${workstreamAssessment.reasoning || 'the current session still owns this turn, but the main frontier has moved.'}`
      : '',
    shouldGenerateTitle ? 'The current name is only a temporary draft. Generate a better final title based on the latest full turn, using the user request as the main signal and the assistant reply to sharpen the task wording.' : '',
    effectiveRefreshTitle ? 'The current title is already user-visible. Keep it exactly as-is unless the session main workstream has materially shifted or the title is now too broad or stale.' : '',
    effectiveRefreshTitle ? 'Do not rename just to polish wording, swap synonyms, or emphasize a minor substep. If the current title still fits, return it unchanged.' : '',
    shouldEvaluateGrouping ? 'Also generate a stable Space and Project group for session-list organization. Neither value is a filesystem path.' : '',
    effectiveRefreshGrouping ? 'The Space should be the most stable label. Do not change it for ordinary project or focus shifts.' : '',
    effectiveRefreshGrouping ? 'The group should be more stable than the title. Do not change the group for small focus shifts inside the same workstream.' : '',
    effectiveRefreshGrouping ? 'Keep the current group and description when they still fit. Only change them when the main workstream has actually moved.' : '',
    shouldEvaluateTitle ? 'The display group is shown separately in the UI. The title must focus on the specific task inside that group and should not repeat the group words unless disambiguation truly requires it.' : '',
    shouldEvaluateTitle ? 'Likewise, avoid repeating connector, provider, or source labels that are already captured elsewhere in session metadata unless they add real disambiguating context.' : '',
    '',
    'Latest turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    shouldEvaluateTitle ? '- "title": 2-6 words — a short descriptive session title. If the current title still fits, return it unchanged.' : '',
    shouldEvaluateGrouping ? '- "space": 1-3 words — a broad, durable context boundary. Prefer an existing fitting Space and keep the total set small. Use "Loose" only for genuinely temporary or ambiguous work.' : '',
    shouldEvaluateGrouping ? '- "group": 1-4 words — a stable display group for the workstream. Prefer an existing fitting workstream over a new one-off label; avoid broad repo/domain buckets. Not a path.' : '',
    shouldEvaluateGrouping ? '- "description": One sentence — a compact hidden description of the current workstream, useful for future regrouping.' : '',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter((line) => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt, {
    operation: 'session_label_suggestion',
  });
  const labelResult = parseJsonObject(modelText);
  if (shouldGenerateTitle && !labelResult?.title) {
    console.error(`[summarizer] Unexpected title output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
      rename: { attempted: true, renamed: false, error: 'Unexpected model output' },
    };
  }

  const suggestedLabels = {};
  if (shouldEvaluateGrouping) {
    const nextSpace = normalizeSessionSpace(labelResult?.space || '');
    const nextGroup = normalizeSessionGroup(labelResult?.group || '');
    const nextDescription = normalizeSessionDescription(labelResult?.description || '');
    if (nextSpace) {
      suggestedLabels.space = nextSpace;
    }
    if (nextGroup) {
      suggestedLabels.group = nextGroup;
    }
    if (nextDescription) {
      suggestedLabels.description = nextDescription;
    }
  }

  if (!shouldEvaluateTitle) {
    return {
      ok: true,
      ...(workstreamAssessment ? { workstreamAssessment } : {}),
      ...(Object.keys(suggestedLabels).length > 0 ? { summary: suggestedLabels } : {}),
      rename: { attempted: false, renamed: false },
    };
  }

  if (!onRename) {
    return {
      ok: true,
      title: labelResult?.title || currentName,
      ...(workstreamAssessment ? { workstreamAssessment } : {}),
      ...(Object.keys(suggestedLabels).length > 0 ? { summary: suggestedLabels } : {}),
      rename: { attempted: true, renamed: false, error: 'No rename callback provided' },
    };
  }

  const finalGroup = normalizeSessionGroup(suggestedLabels.group || currentGroup || '');
  const proposedName = normalizeGeneratedSessionTitle(labelResult?.title || '', finalGroup);
  if (shouldGenerateTitle && !proposedName) {
    return {
      ok: false,
      error: 'Empty title generated',
      rename: { attempted: true, renamed: false, error: 'Empty title generated' },
    };
  }

  const newName = proposedName || currentName;
  if (!newName || newName === currentName) {
    return {
      ok: true,
      title: currentName,
      ...(workstreamAssessment ? { workstreamAssessment } : {}),
      ...(Object.keys(suggestedLabels).length > 0 ? { summary: suggestedLabels } : {}),
      rename: { attempted: false, renamed: false },
    };
  }

  const renamed = await onRename(newName);
  return {
    ok: true,
    title: newName,
    ...(workstreamAssessment ? { workstreamAssessment } : {}),
    ...(Object.keys(suggestedLabels).length > 0 ? { summary: suggestedLabels } : {}),
    rename: renamed
      ? { attempted: true, renamed: true, title: newName }
      : { attempted: true, renamed: false, error: options.skipReason || 'Auto-rename no longer needed' },
  };
}

async function runSessionWorkflowStateSuggestion(sessionMeta, _options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    group,
    description,
    workflowState,
    workflowPriority,
    runState,
    queuedCount,
  } = sessionMeta;

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: true });
  if (lastTurnEvents.length === 0) {
    console.log(`[workflow-state] Skipping workflow state suggestion for ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
    };
  }

  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[workflow-state] Skipping workflow state suggestion for ${sessionId.slice(0, 8)}: empty turn text`);
    return {
      ok: false,
      skipped: 'empty_turn',
    };
  }

  const currentGroup = normalizeSessionGroup(group || '');
  const currentDescription = normalizeSessionDescription(description || '');
  const currentWorkflowState = normalizeSessionWorkflowState(workflowState || '');
  const currentWorkflowPriority = normalizeSessionWorkflowPriority(workflowPriority || '');

  const prompt = [
    'You are updating RemoteLab workflow state for a developer session.',
    'Low-visibility workflow states must be assigned very conservatively because they push the session lower in the sidebar.',
    'Use a two-step decision:',
    '1. First decide whether the latest turn supports a high-confidence durable low-visibility state at all.',
    '2. Only if confidence is high, choose the single best durable state after the latest assistant turn.',
    'Valid states:',
    '- "parked": not currently running and not blocked on immediate user input; paused, deferred, or left open for later.',
    '- "waiting_user": the assistant needs the user before meaningful progress can continue, such as approval, an answer, files, credentials, a choice, or manual validation.',
    '- "done": the current request is clearly closed and delivered; no user feedback, opinion, reaction, or response is still being solicited to wrap the current goal.',
    'Important rules:',
    '- Never output a running state. Live runtime already handles running separately.',
    '- If the assistant asked a direct question or requested approval/input needed to proceed, prefer "waiting_user".',
    '- Do NOT choose "waiting_user" for optional follow-up questions, broad invitations to continue, or open-ended conversation that can keep moving without the user.',
    '- If the assistant delivered the requested result or clearly closed the task, prefer "done".',
    '- Do NOT choose "done" when there is any unresolved open loop, required validation, pending acceptance, or obvious next step still needed to satisfy the current goal.',
    '- Do NOT choose "done" for open-ended wrap-ups that ask for subjective feedback, reactions, opinions, or review. If that input is not a hard blocker, leave the workflow state unset.',
    '- If the assistant delivered work but is still soliciting subjective feedback or a broad reaction, do NOT choose "waiting_user" unless progress truly cannot continue without the user. Otherwise leave the workflow state unset.',
    '- If the session is explicitly paused, deferred, or intentionally left for later, choose "parked".',
    '- On failures that require user intervention, prefer "waiting_user". On failures that simply stop progress without a clear ask, prefer "parked".',
    '- If confidence is not high, do not force a low-visibility state. Leave the workflow state unset so the session can stay active.',
    '- Also choose the user-attention priority for the next glance at the session list, but only when you are setting a workflow state.',
    '- Use "high" when the user should probably look soon, especially for blockers, approvals, decisions, or important next actions.',
    '- Use "medium" for meaningful open work that matters but is not urgent right now.',
    '- Use "low" for safely parked or completed work that does not deserve immediate attention.',
    '',
    `Session folder: ${folder}`,
    `Current session name: ${name || '(unnamed)'}`,
    currentGroup ? `Current display group: ${currentGroup}` : '',
    currentDescription ? `Current session description: ${currentDescription}` : '',
    currentWorkflowState ? `Current workflow state: ${currentWorkflowState}` : '',
    currentWorkflowPriority ? `Current workflow priority: ${currentWorkflowPriority}` : '',
    typeof runState === 'string' && runState ? `Latest run state: ${runState}` : '',
    Number.isInteger(queuedCount) ? `Queued follow-ups after this turn: ${queuedCount}` : '',
    '',
    'Latest turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    '- "shouldSetWorkflowState": true or false.',
    '- "workflowState": "", "parked", "waiting_user", or "done".',
    '- "workflowPriority": "", "high", "medium", or "low".',
    '- "reason": one short sentence explaining the choice.',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter((line) => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt, {
    operation: 'workflow_state_suggestion',
  });
  const stateResult = parseJsonObject(modelText);
  const rawWorkflowState = typeof stateResult?.workflowState === 'string'
    ? stateResult.workflowState.trim()
    : '';
  const rawWorkflowPriority = typeof stateResult?.workflowPriority === 'string'
    ? stateResult.workflowPriority.trim()
    : '';
  const explicitSetDecision = stateResult?.shouldSetWorkflowState === true;
  const explicitClearDecision = stateResult?.shouldSetWorkflowState === false;
  const normalizedWorkflowState = normalizeSessionWorkflowState(rawWorkflowState);
  const shouldSetWorkflowState = explicitSetDecision || Boolean(normalizedWorkflowState);
  const shouldClearWorkflowState = !shouldSetWorkflowState && (
    explicitClearDecision || isNeutralWorkflowStateLabel(rawWorkflowState)
  );

  if (!shouldSetWorkflowState && !shouldClearWorkflowState) {
    console.error(`[workflow-state] Unexpected workflow output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
    };
  }

  const nextWorkflowState = shouldSetWorkflowState ? normalizedWorkflowState : '';
  const nextWorkflowPriority = shouldSetWorkflowState
    ? (
      normalizeSessionWorkflowPriority(rawWorkflowPriority)
      || getDefaultWorkflowPriorityForState(nextWorkflowState)
    )
    : '';

  if (shouldSetWorkflowState && !nextWorkflowState) {
    console.error(`[workflow-state] Invalid workflow state output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Invalid workflow state output: ${modelText.slice(0, 200)}`,
    };
  }

  return {
    ok: true,
    shouldClearWorkflowState,
    workflowState: nextWorkflowState,
    workflowPriority: nextWorkflowPriority,
    reason: typeof stateResult?.reason === 'string' ? stateResult.reason.trim() : '',
  };
}

async function runSessionTaskCardSuggestion(sessionMeta, _options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    sourceName,
    taskCard,
  } = sessionMeta;

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: true });
  if (lastTurnEvents.length === 0) {
    console.log(`[task-card] Skipping task card suggestion for ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
    };
  }

  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[task-card] Skipping task card suggestion for ${sessionId.slice(0, 8)}: empty turn text`);
    return {
      ok: false,
      skipped: 'empty_turn',
    };
  }

  const currentTaskCard = formatTaskCardForPrompt(taskCard);
  const prompt = [
    'You are updating backend-owned task memory for a RemoteLab session.',
    'This task card is hidden state, not user-facing prose.',
    'Update it after the latest turn using stable facts, not speculative filler.',
    'Keep it concise, cumulative, and easy for the main assistant to reuse next turn.',
    'Use "project" mode when the work is multi-step, recurring, or material-heavy; otherwise use "task".',
    'Use rawMaterials only for concrete artifacts such as files, folders, screenshots, links, exports, recordings, or example outputs that matter for the work.',
    'Use memory only for durable user preferences, accepted definitions, reusable context, or lasting collaboration knowledge.',
    'Use reusablePatterns only for short strategy-like lessons, heuristics, or repeatable workflows that the assistant should reuse in later turns or similar sessions.',
    'Do not put one-off facts, temporary TODOs, or ordinary user preferences into reusablePatterns.',
    'Use needsFromUser only for information, files, approvals, or decisions the assistant currently needs from the user.',
    'If something is not clearly supported, leave it empty instead of guessing.',
    '',
    `Session folder: ${folder}`,
    `Current session name: ${name || '(unnamed)'}`,
    sourceName ? `Current source label: ${sourceName}` : '',
    currentTaskCard ? `Current task card:\n${currentTaskCard}` : 'Current task card: none',
    '',
    'Latest turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    '- "mode": "project" or "task".',
    '- "summary": one short cumulative summary sentence.',
    '- "goal": one short current goal sentence.',
    '- "background": array of short factual context bullets.',
    '- "rawMaterials": array of concrete material references.',
    '- "assumptions": array of active assumptions worth carrying.',
    '- "knownConclusions": array of established findings or decisions.',
    '- "reusablePatterns": array of short reusable strategies or heuristics learned from the work so far.',
    '- "nextSteps": array of likely next actions already implied by the work.',
    '- "memory": array of durable reusable user/context memory.',
    '- "needsFromUser": array of current missing user inputs or decisions.',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter((line) => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt, {
    operation: 'task_card_suggestion',
  });
  const nextTaskCard = normalizeSessionTaskCard(parseJsonObject(modelText));
  if (!nextTaskCard) {
    console.error(`[task-card] Unexpected task card output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
    };
  }

  return {
    ok: true,
    taskCard: nextTaskCard,
  };
}
