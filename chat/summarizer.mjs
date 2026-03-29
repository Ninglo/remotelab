import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { readLastTurnEvents } from './history.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { createToolInvocation, resolveCommand, resolveCwd } from './process-runner.mjs';
import {
  normalizeGeneratedSessionTitle,
  isSessionAutoRenamePending,
  normalizeSessionDescription,
  normalizeSessionGroup,
} from './session-naming.mjs';
import { loadSessionLabelPromptContext } from './session-label-context.mjs';
import {
  inferSessionWorkflowPriorityFromText,
  inferSessionWorkflowStateFromText,
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import { normalizeSessionTaskCard } from './session-task-card.mjs';

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

async function runToolJsonPrompt(sessionMeta, prompt) {
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

  const { command, adapter, args, envOverrides } = await createToolInvocation(tool, prompt, {
    dangerouslySkipPermissions: true,
    model,
    effort,
    thinking,
    systemPrefix: '',
  });
  const resolvedCmd = await resolveCommand(command);
  const resolvedFolder = resolveCwd(folder);
  console.log(
    `[summarizer] Calling tool=${tool} cmd=${resolvedCmd} model=${model || 'default'} effort=${effort || 'default'} thinking=${!!thinking} for session ${sessionId.slice(0, 8)}`
  );

  const subEnv = buildToolProcessEnv(envOverrides || {});
  delete subEnv.CLAUDECODE;
  delete subEnv.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve, reject) => {
    const proc = spawn(resolvedCmd, args, {
      cwd: resolvedFolder,
      env: subEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });
    const textParts = [];

    rl.on('line', (line) => {
      const events = adapter.parseLine(line);
      for (const evt of events) {
        if (evt.type === 'message' && evt.role === 'assistant') {
          textParts.push(evt.content || '');
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
    group,
    description,
    sourceName,
    autoRenamePending,
  } = sessionMeta;

  const shouldGenerateTitle = isSessionAutoRenamePending({ name, autoRenamePending });
  const currentGroup = normalizeSessionGroup(group || '');
  const currentDescription = normalizeSessionDescription(description || '');
  const shouldGenerateGrouping = !currentGroup || !currentDescription;
  if (!shouldGenerateTitle && !shouldGenerateGrouping) {
    return {
      ok: true,
      skipped: 'session_labels_not_needed',
      rename: { attempted: false, renamed: false },
    };
  }

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

  const promptContext = await loadSessionLabelPromptContext({
    ...sessionMeta,
    group: currentGroup,
    description: currentDescription,
  }, turnText);

  const prompt = [
    'You are naming a developer session. Be concise and literal.',
    'Treat the display group as a flexible project-like container: usually the top-level project or recurring domain. The title should name the concrete subtask inside that group.',
    'Reuse an existing display group when the scope clearly matches. Create a new group only when the work clearly belongs to a different project or domain.',
    'The latest turn may be underspecified. Use earlier session context, scope-router hints, and existing session metadata to infer the right top-level project before naming.',
    '',
    `Session folder: ${folder}`,
    `Current session name: ${name || '(unnamed)'}`,
    currentGroup ? `Current display group: ${currentGroup}` : '',
    currentDescription ? `Current session description: ${currentDescription}` : '',
    sourceName ? `Current source label: ${sourceName}` : '',
    promptContext.contextSummary ? `Earlier session context:\n${promptContext.contextSummary}` : '',
    promptContext.scopeRouter ? `Known scope router entries:\n${promptContext.scopeRouter}` : '',
    promptContext.existingSessions ? `Current non-archived sessions:\n${promptContext.existingSessions}` : '',
    shouldGenerateTitle ? 'The current name is only a temporary draft. Generate a better final title based on the latest full turn, using the user request as the main signal and the assistant reply to sharpen the task wording.' : '',
    shouldGenerateGrouping ? 'Also generate a stable one-level display group for session-list organization. This is not a filesystem path.' : '',
    shouldGenerateTitle ? 'The display group is shown separately in the UI. The title must focus on the specific task inside that group and should not repeat the group/domain words unless disambiguation truly requires it.' : '',
    shouldGenerateTitle ? 'Likewise, avoid repeating connector, provider, or source labels that are already captured elsewhere in session metadata unless they add real disambiguating context.' : '',
    '',
    'Latest turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    shouldGenerateTitle ? '- "title": 2-5 words — a short descriptive session title (for example: "Fix auth bug", "Refactor naming flow").' : '',
    shouldGenerateGrouping ? '- "group": 1-3 words — a stable display group for similar work (for example: "RemoteLab", "Video tooling", "Hiring"). Not a path.' : '',
    shouldGenerateGrouping ? '- "description": One sentence — a compact hidden description of the work, useful for future regrouping.' : '',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter((line) => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt);
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
  if (shouldGenerateGrouping) {
    const nextGroup = normalizeSessionGroup(labelResult?.group || '');
    const nextDescription = normalizeSessionDescription(labelResult?.description || '');
    if (nextGroup) {
      suggestedLabels.group = nextGroup;
    }
    if (nextDescription) {
      suggestedLabels.description = nextDescription;
    }
  }

  if (!shouldGenerateTitle) {
    return {
      ok: true,
      ...(Object.keys(suggestedLabels).length > 0 ? { summary: suggestedLabels } : {}),
      rename: { attempted: false, renamed: false },
    };
  }

  if (!onRename) {
    return {
      ok: true,
      title: labelResult.title,
      ...(Object.keys(suggestedLabels).length > 0 ? { summary: suggestedLabels } : {}),
      rename: { attempted: true, renamed: false, error: 'No rename callback provided' },
    };
  }

  const finalGroup = normalizeSessionGroup(suggestedLabels.group || currentGroup || '');
  const newName = normalizeGeneratedSessionTitle(labelResult.title, finalGroup);
  if (!newName) {
    return {
      ok: false,
      error: 'Empty title generated',
      rename: { attempted: true, renamed: false, error: 'Empty title generated' },
    };
  }

  const renamed = await onRename(newName);
  return {
    ok: true,
    title: newName,
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
    'Choose the single best durable state after the latest assistant turn.',
    'Valid states:',
    '- "parked": not currently running and not blocked on immediate user input; paused, deferred, or left open for later.',
    '- "waiting_user": the assistant needs the user before meaningful progress can continue, such as approval, an answer, files, credentials, a choice, or manual validation.',
    '- "done": the current request is complete; follow-up is optional, not required to finish the current goal.',
    'Important rules:',
    '- Never output a running state. Live runtime already handles running separately.',
    '- If the assistant asked a direct question or requested approval/input needed to proceed, prefer "waiting_user".',
    '- If the assistant delivered the requested result or clearly closed the task, prefer "done".',
    '- If the session is paused, open-ended, or only loosely pending without needing the user right now, choose "parked".',
    '- On failures that require user intervention, prefer "waiting_user". On failures that simply stop progress without a clear ask, prefer "parked".',
    '- Also choose the user-attention priority for the next glance at the session list.',
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
    '- "workflowState": one of "parked", "waiting_user", or "done".',
    '- "workflowPriority": one of "high", "medium", or "low".',
    '- "reason": one short sentence explaining the choice.',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter((line) => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt);
  const stateResult = parseJsonObject(modelText);
  const nextWorkflowState = inferSessionWorkflowStateFromText(
    stateResult?.workflowState
    || stateResult?.reason
    || modelText,
  );
  const nextWorkflowPriority = inferSessionWorkflowPriorityFromText(
    stateResult?.workflowPriority
    || stateResult?.reason
    || modelText,
    nextWorkflowState,
  );
  if (!nextWorkflowState) {
    console.error(`[workflow-state] Unexpected workflow output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
    };
  }

  return {
    ok: true,
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

  const modelText = await runToolJsonPrompt(sessionMeta, prompt);
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
