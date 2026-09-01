import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { readLastTurnEvents } from './history.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { createToolInvocation, resolveCommand, resolveCwd } from './process-runner.mjs';
import { applyProviderRuntimeEnv } from './runtime-policy.mjs';
import {
  normalizeGeneratedSessionTitle,
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
import { normalizeSessionWorkSummary } from './session-work-summary.mjs';

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
    console.error(`[usage-ledger] Failed to append session-state classifier usage for ${sessionMeta?.id?.slice?.(0, 8) || 'unknown'}: ${error.message}`);
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
  const resolvedFolder = resolveCwd(folder);
  console.log(
    `[session-state] Calling tool=${tool} cmd=${resolvedCmd} model=${model || 'default'} effort=${effort || 'default'} thinking=${!!thinking} for session ${sessionId.slice(0, 8)}`
  );

  let subEnv = buildToolProcessEnv(envOverrides || {});
  delete subEnv.CLAUDECODE;
  delete subEnv.CLAUDE_CODE_ENTRYPOINT;
  subEnv = applyProviderRuntimeEnv(tool, subEnv, {
    runtimeFamily,
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(resolvedCmd, args, {
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
      if (text) console.log(`[session-state] stderr: ${text.slice(0, 200)}`);
    });

    proc.on('error', (err) => {
      console.error(`[session-state] ${tool} structured prompt error for ${sessionId.slice(0, 8)}: ${err.message}`);
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

function formatWorkSummaryForPrompt(workSummary) {
  const normalized = normalizeSessionWorkSummary(workSummary);
  if (!normalized) return '';
  return JSON.stringify(normalized, null, 2);
}

export function triggerSessionStateSuggestion(sessionMeta, options = {}) {
  console.log(`[session-state] triggerSessionStateSuggestion called for session ${sessionMeta.id?.slice(0, 8)}`);
  return runSessionStateSuggestion(sessionMeta, options).catch((err) => {
    console.error(`[session-state] Session state suggestion error for ${sessionMeta.id?.slice(0, 8)}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
    };
  });
}

async function runSessionStateSuggestion(sessionMeta, _options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    space,
    group,
    description,
    sourceName,
    workflowState,
    workflowPriority,
    workSummary,
    runState,
    queuedCount,
  } = sessionMeta;

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: true });
  if (lastTurnEvents.length === 0) {
    return { ok: false, skipped: 'no_history' };
  }
  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    return { ok: false, skipped: 'empty_turn' };
  }

  const currentSpace = normalizeSessionSpace(space || '');
  const currentGroup = normalizeSessionGroup(group || '');
  const currentDescription = normalizeSessionDescription(description || '');
  const currentWorkflowState = normalizeSessionWorkflowState(workflowState || '');
  const currentWorkflowPriority = normalizeSessionWorkflowPriority(workflowPriority || '');
  const currentWorkSummary = formatWorkSummaryForPrompt(workSummary);
  const promptContext = await loadSessionLabelPromptContext({
    ...sessionMeta,
    space: currentSpace,
    group: currentGroup,
    description: currentDescription,
  }, turnText);

  const prompt = [
    'You are RemoteLab\'s single post-turn session-state classifier.',
    'Update the provider-neutral session state after the latest completed turn so Codex, Claude, Pi, and future Harnesses can share the same current understanding.',
    'This is metadata and continuity state, not a second task planner. Do not critique, continue, or rewrite the assistant answer.',
    '',
    'Classification rules:',
    '- Keep title, Space, Project group, and description unchanged unless the session\'s durable workstream or current frontier materially shifted.',
    '- Title is the current frontier. Space is a broad durable context boundary. Project group is a recoverable workstream inside a Space. Description is one compact sentence about the workstream.',
    '- Reuse an existing Space and Project group when they still fit. Use "Loose" only for genuinely temporary or ambiguous work.',
    '- Workflow state may be "parked", "waiting_user", "done", or empty. Leave it empty unless the latest turn supports a high-confidence durable state.',
    '- Use "waiting_user" only for a real blocker, approval, missing input, credential, file, or decision. Use "done" only when the current goal is clearly delivered. Use "parked" only when work is intentionally deferred.',
    '- Optional subjective feedback, broad invitations to continue, or open-ended conversation are not blockers. Leave workflow state unset unless the turn clearly reaches one of the durable states above.',
    '- Set workflow priority only when workflow state is set: high for user attention, medium for meaningful deferred work, low for safely parked or completed work.',
    '- Refresh the work summary cumulatively from supported facts. Preserve accepted decisions, materials, conclusions, reusable patterns, next steps, and real user blockers. Remove stale items that the latest turn superseded.',
    '- Keep durable cross-task user knowledge out of the work summary; RemoteLab handles durable memory promotion separately.',
    '- Do not invent facts or add speculative filler.',
    '',
    `Session folder: ${folder}`,
    `Current title: ${name || '(unnamed)'}`,
    `Current Space: ${currentSpace || '(unset)'}`,
    `Current Project group: ${currentGroup || '(unset)'}`,
    `Current description: ${currentDescription || '(unset)'}`,
    sourceName ? `Current source: ${sourceName}` : '',
    currentWorkflowState ? `Current workflow state: ${currentWorkflowState}` : 'Current workflow state: unset',
    currentWorkflowPriority ? `Current workflow priority: ${currentWorkflowPriority}` : 'Current workflow priority: unset',
    typeof runState === 'string' && runState ? `Latest run state: ${runState}` : '',
    Number.isInteger(queuedCount) ? `Queued follow-ups: ${queuedCount}` : '',
    currentWorkSummary ? `Current provider-neutral work summary:\n${currentWorkSummary}` : 'Current provider-neutral work summary: none',
    promptContext.contextSummary ? `Earlier session context:\n${promptContext.contextSummary}` : '',
    promptContext.scopeRouter ? `Known scope router entries:\n${promptContext.scopeRouter}` : '',
    promptContext.existingSessions ? `Current non-archived sessions:\n${promptContext.existingSessions}` : '',
    '',
    'Latest completed turn:',
    turnText,
    '',
    'Return ONLY one valid JSON object with exactly these fields:',
    '- "title": 2-6 words. Return the current title unchanged when it still fits.',
    '- "space": 1-3 words.',
    '- "group": 1-4 words.',
    '- "description": one compact sentence.',
    '- "shouldSetWorkflowState": boolean.',
    '- "workflowState": "", "parked", "waiting_user", or "done".',
    '- "workflowPriority": "", "high", "medium", or "low".',
    '- "workSummary": an object with fields "mode", "summary", "goal", "background", "rawMaterials", "assumptions", "knownConclusions", "reusablePatterns", "nextSteps", "memory", and "needsFromUser".',
    'Use arrays of short strings for every workSummary list. Use mode "project" for multi-step, recurring, or material-heavy work; otherwise "task".',
  ].filter((line) => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt, {
    operation: 'session_state_suggestion',
  });
  const result = parseJsonObject(modelText);
  if (!result || typeof result !== 'object') {
    throw new Error(`Unexpected model output: ${modelText.slice(0, 200)}`);
  }

  const nextSpace = normalizeSessionSpace(result.space || '') || currentSpace;
  const nextGroup = normalizeSessionGroup(result.group || '') || currentGroup;
  const nextDescription = normalizeSessionDescription(result.description || '') || currentDescription;
  const nextTitle = normalizeGeneratedSessionTitle(result.title || '', nextGroup)
    || normalizeGeneratedSessionTitle(name || '', nextGroup);
  const explicitWorkflow = result.shouldSetWorkflowState === true;
  const nextWorkflowState = explicitWorkflow
    ? normalizeSessionWorkflowState(result.workflowState || '')
    : '';
  const nextWorkflowPriority = nextWorkflowState
    ? (normalizeSessionWorkflowPriority(result.workflowPriority || '') || getDefaultWorkflowPriorityForState(nextWorkflowState))
    : '';
  const nextWorkSummary = normalizeSessionWorkSummary(result.workSummary)
    || normalizeSessionWorkSummary(workSummary);

  return {
    ok: true,
    title: nextTitle,
    space: nextSpace,
    group: nextGroup,
    description: nextDescription,
    workflowState: nextWorkflowState,
    workflowPriority: nextWorkflowPriority,
    shouldClearWorkflowState: !nextWorkflowState,
    workSummary: nextWorkSummary,
  };
}
