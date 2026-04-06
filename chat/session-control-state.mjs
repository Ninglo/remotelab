import { normalizeSessionAgreements } from './session-agreements.mjs';
import { resolveSessionEntryMode } from './session-entry-mode.mjs';
import { buildSessionContinuationContextFromBody } from './session-continuation.mjs';
import { normalizeSessionTaskCard } from './session-task-card.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';

function normalizePromptBlock(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeIsoTimestamp(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    return '';
  }
  return new Date(normalized).toISOString();
}

function withOptionalString(target, key, value) {
  const normalized = normalizePromptBlock(value);
  if (normalized) target[key] = normalized;
}

function withOptionalInteger(target, key, value, { allowZero = false } = {}) {
  if (!Number.isInteger(value)) return;
  if (!allowZero && value <= 0) return;
  target[key] = value;
}

export function buildManagerMemorySearchPolicy(promptContext = null) {
  const scopeRouter = normalizePromptBlock(promptContext?.scopeRouter);
  if (scopeRouter) {
    return [
      'Memory/search policy for this turn:',
      '- Prefer carried context, matched scope-router hints, and imported related-session memory before filesystem discovery.',
      '- Reuse the best-matching summary, task card, or referenced memory/doc packet before broad search.',
      '- If those sources do not reveal a concrete entry point, ask the user for a project, path, file, or link before widening search.',
      '- Use machine-wide search only after targeted context misses and a concrete lead exists.',
    ].join('\n');
  }

  return 'Memory/search policy for this turn: prefer targeted memory, referenced docs, continuity, or known project pointers before filesystem search. If those do not reveal the entry point, ask the user for one instead of widening into machine-wide search. Use machine-wide search only as a last resort after a concrete lead exists.';
}

export function normalizeSessionContinuationHead(context = null) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;

  const normalized = {
    mode: context.mode === 'summary' ? 'summary' : 'history',
  };

  withOptionalString(normalized, 'summary', context.summary);
  withOptionalInteger(normalized, 'activeFromSeq', context.activeFromSeq);
  withOptionalInteger(normalized, 'compactedThroughSeq', context.compactedThroughSeq);
  if (Number.isInteger(context.inputTokens)) normalized.inputTokens = context.inputTokens;
  withOptionalString(normalized, 'updatedAt', normalizeIsoTimestamp(context.updatedAt));
  withOptionalString(normalized, 'source', context.source);
  withOptionalString(normalized, 'toolIndex', context.toolIndex);
  withOptionalInteger(normalized, 'barrierSeq', context.barrierSeq, { allowZero: true });
  withOptionalInteger(normalized, 'handoffSeq', context.handoffSeq, { allowZero: true });
  withOptionalString(normalized, 'compactionSessionId', context.compactionSessionId);

  return Object.keys(normalized).length > 1 ? normalized : null;
}

export function normalizeSessionPreparedContinuation(context = null) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;

  const normalized = {
    mode: context.mode === 'summary' ? 'summary' : 'history',
  };

  withOptionalString(normalized, 'summary', context.summary);
  withOptionalString(normalized, 'continuationBody', context.continuationBody);
  withOptionalInteger(normalized, 'activeFromSeq', context.activeFromSeq);
  withOptionalInteger(normalized, 'preparedThroughSeq', context.preparedThroughSeq);
  withOptionalString(normalized, 'contextUpdatedAt', normalizeIsoTimestamp(context.contextUpdatedAt));
  withOptionalString(normalized, 'updatedAt', normalizeIsoTimestamp(context.updatedAt));
  withOptionalString(normalized, 'source', context.source);

  return Object.keys(normalized).length > 1 ? normalized : null;
}

export function buildSessionManagerState(session = {}, options = {}) {
  const activeAgreements = normalizeSessionAgreements(session?.activeAgreements || []);
  const promptContext = options?.promptContext && typeof options.promptContext === 'object' && !Array.isArray(options.promptContext)
    ? options.promptContext
    : null;
  const scopeRouter = normalizePromptBlock(promptContext?.scopeRouter);
  const relatedSessions = normalizePromptBlock(promptContext?.relatedSessions);
  const searchPolicy = normalizePromptBlock(
    typeof options?.memorySearchPolicy === 'string'
      ? options.memorySearchPolicy
      : buildManagerMemorySearchPolicy(promptContext),
  );

  const managerState = {};
  if (activeAgreements.length > 0) {
    managerState.activeAgreements = activeAgreements;
  }

  if (scopeRouter || relatedSessions || searchPolicy) {
    managerState.memoryActivation = {
      ...(scopeRouter ? { scopeRouter } : {}),
      ...(relatedSessions ? { relatedSessions } : {}),
      ...(searchPolicy ? { searchPolicy } : {}),
    };
  }

  return managerState;
}

export function buildSessionWorkState(session = {}, options = {}) {
  const taskCard = normalizeSessionTaskCard(session?.taskCard);
  const workflowState = normalizeSessionWorkflowState(session?.workflowState || '');
  const workflowPriority = normalizeSessionWorkflowPriority(session?.workflowPriority || '');
  const lastReviewedAt = normalizeIsoTimestamp(session?.lastReviewedAt);
  const contextHead = normalizeSessionContinuationHead(options?.contextHead || null);
  const preparedContinuation = normalizeSessionPreparedContinuation(options?.forkContext || null);

  const workState = {
    workflow: {
      entryMode: resolveSessionEntryMode(session?.entryMode),
      ...(workflowState ? { state: workflowState } : {}),
      ...(workflowPriority ? { priority: workflowPriority } : {}),
      ...(lastReviewedAt ? { lastReviewedAt } : {}),
    },
  };

  if (taskCard) {
    workState.taskCard = taskCard;
  }

  if (contextHead || preparedContinuation) {
    workState.continuation = {
      ...(contextHead ? { head: contextHead } : {}),
      ...(preparedContinuation ? { prepared: preparedContinuation } : {}),
    };
  }

  return workState;
}

export function buildSessionControlState(session = {}, options = {}) {
  return {
    managerState: buildSessionManagerState(session, options),
    workState: buildSessionWorkState(session, options),
  };
}

export function buildPreparedContinuationPromptFromWorkState(workState, previousTool, effectiveTool) {
  const prepared = workState?.continuation?.prepared;
  const summary = normalizePromptBlock(prepared?.summary);
  const continuationBody = normalizePromptBlock(prepared?.continuationBody);
  const continuation = continuationBody
    ? buildSessionContinuationContextFromBody(continuationBody, {
        fromTool: previousTool,
        toTool: effectiveTool,
      })
    : '';

  let prompt = '';
  if (summary) {
    prompt = `[Conversation summary]\n\n${summary}`;
    if (continuation) {
      prompt = `${prompt}\n\n---\n\n${continuation}`;
    }
  } else {
    prompt = continuation;
  }

  const toolIndex = normalizePromptBlock(workState?.continuation?.head?.toolIndex);
  if (!toolIndex) return prompt;

  return prompt
    ? `${prompt}\n\n---\n\n[Earlier tool activity index]\n\n${toolIndex}`
    : `[Earlier tool activity index]\n\n${toolIndex}`;
}
