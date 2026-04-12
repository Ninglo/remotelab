/**
 * Pre-execution session continuation planning.
 *
 * Before a user message enters the normal turn lifecycle, this module
 * decides whether the input should:
 * - continue in the current session
 * - fork into one or more related child sessions
 * - start one or more fresh sessions with minimal forwarded context
 */

import {
  buildContinuationPlannerPrompt,
  parseContinuationPlan,
} from './session-dispatch-prompt.mjs';
import { isEnvToggleEnabled } from '../lib/env-toggle.mjs';

const CONTINUATION_PLANNER_THRESHOLD = 0.75;
const DISPATCH_SETTING_ENV = 'REMOTELAB_SESSION_DISPATCH';
const CURRENT_TRANSCRIPT_MAX_CHARS = 22000;

function isDispatchEnabled() {
  return isEnvToggleEnabled(process.env[DISPATCH_SETTING_ENV], { defaultValue: true });
}

export function shouldRunDispatch(session, options = {}) {
  if (!isDispatchEnabled()) return false;
  if (options.internalOperation) return false;
  if (options.skipDispatch) return false;
  if (session?.visitorId) return false;
  if (options.queueIfBusy === false && options.recordUserMessage === false) return false;
  return true;
}

export function shouldUseAsyncDispatchPlanning(session, message) {
  const trimmedMessage = String(message || '').trim();
  if (trimmedMessage.length < 5) {
    return false;
  }
  if (Number(session?.messageCount || 0) < 2) {
    return false;
  }
  if (!session?.name || session.name.startsWith('New Session') || session.autoRenamePending === true) {
    return false;
  }
  return true;
}

function clipTranscript(text, maxChars) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  const headChars = Math.max(1, Math.floor(maxChars * 0.65));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${normalized.slice(0, headChars).trimEnd()}\n[... transcript clipped ...]\n${normalized.slice(-tailChars).trimStart()}`;
}

function buildTranscriptFromHistory(events, maxChars = CURRENT_TRANSCRIPT_MAX_CHARS) {
  if (!Array.isArray(events) || events.length === 0) return '';
  const lines = [];
  for (const event of events) {
    if (event?.type !== 'message') continue;
    const content = String(event.content || '').trim();
    if (!content) continue;
    const roleLabel = event.role === 'user'
      ? 'User'
      : (event.role === 'assistant' ? 'Assistant' : 'System');
    lines.push(`[${roleLabel}]: ${content}`);
  }
  return clipTranscript(lines.join('\n\n'), maxChars);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildDefaultPlan(message, reason = 'default') {
  const deliveryText = trimString(message);
  return {
    confidence: 1,
    reasoning: reason,
    userVisibleSummary: '',
    destinations: [
      {
        destinationId: 'dest_1',
        mode: 'continue',
        inheritanceProfile: 'reuse_current_context',
        reasoning: reason,
        scopeFraming: '',
        deliveryText,
        forwardedContext: '',
        titleHint: '',
      },
    ],
  };
}

function normalizeDestinations(plan, originalMessage) {
  const trimmedMessage = trimString(originalMessage);
  const rawDestinations = Array.isArray(plan?.destinations) ? plan.destinations : [];
  const normalized = [];
  let continueSeen = false;

  for (const destination of rawDestinations) {
    const mode = destination?.mode === 'fork'
      ? 'fork'
      : (destination?.mode === 'fresh' ? 'fresh' : 'continue');

    if (mode === 'continue' && continueSeen) {
      continue;
    }
    if (mode === 'continue') {
      continueSeen = true;
    }

    const inheritanceProfile = mode === 'fork'
      ? 'full_parent_context'
      : (mode === 'fresh' ? 'minimal_forwarded_context' : 'reuse_current_context');
    const deliveryText = trimString(destination?.deliveryText) || trimmedMessage;

    normalized.push({
      destinationId: trimString(destination?.destinationId) || `dest_${normalized.length + 1}`,
      mode,
      inheritanceProfile: trimString(destination?.inheritanceProfile) || inheritanceProfile,
      reasoning: trimString(destination?.reasoning),
      scopeFraming: trimString(destination?.scopeFraming),
      deliveryText,
      forwardedContext: trimString(destination?.forwardedContext),
      titleHint: trimString(destination?.titleHint),
    });
  }

  if (normalized.length === 0) {
    return buildDefaultPlan(trimmedMessage, trimString(plan?.reasoning) || 'default').destinations;
  }

  return normalized;
}

function normalizePlan(plan, originalMessage) {
  const destinations = normalizeDestinations(plan, originalMessage);
  const nonContinueCount = destinations.filter((destination) => destination.mode !== 'continue').length;
  const confidence = typeof plan?.confidence === 'number'
    ? Math.max(0, Math.min(1, plan.confidence))
    : 0;

  if ((nonContinueCount > 0 || destinations.length > 1) && confidence < CONTINUATION_PLANNER_THRESHOLD) {
    return buildDefaultPlan(originalMessage, `low confidence: ${trimString(plan?.reasoning) || 'continuation planner'}`);
  }

  return {
    confidence: confidence || 1,
    reasoning: trimString(plan?.reasoning),
    userVisibleSummary: trimString(plan?.userVisibleSummary),
    destinations,
  };
}

export function isTrivialContinuationPlan(plan) {
  const destinations = Array.isArray(plan?.destinations) ? plan.destinations : [];
  return destinations.length === 1 && destinations[0]?.mode === 'continue';
}

export async function planSessionContinuations({
  session,
  message,
  loadSessionHistory,
  runPrompt,
}) {
  const defaultPlan = buildDefaultPlan(message, 'default');
  const trimmedMessage = trimString(message);
  if (!shouldUseAsyncDispatchPlanning(session, trimmedMessage)) {
    return defaultPlan;
  }

  let currentTranscript = '';
  try {
    const currentHistory = typeof loadSessionHistory === 'function'
      ? await loadSessionHistory(session.id)
      : [];
    currentTranscript = buildTranscriptFromHistory(currentHistory, CURRENT_TRANSCRIPT_MAX_CHARS);
  } catch (error) {
    console.error(`[session-continuation] Failed to load current transcript: ${error.message}`);
    return defaultPlan;
  }

  if (!currentTranscript) {
    return defaultPlan;
  }

  const prompt = buildContinuationPlannerPrompt({
    currentSession: session,
    currentTranscript,
    message: trimmedMessage,
  });

  let rawResponse = '';
  try {
    rawResponse = await runPrompt(prompt);
  } catch (error) {
    console.error(`[session-continuation] Continuation planner failed: ${error.message}`);
    return defaultPlan;
  }

  const parsedPlan = parseContinuationPlan(rawResponse);
  const normalizedPlan = normalizePlan(parsedPlan, trimmedMessage);

  console.log(
    `[session-continuation] Plan: ${normalizedPlan.destinations.map((destination) => destination.mode).join(', ')}`
    + ` (confidence: ${(normalizedPlan.confidence || 0).toFixed(2)})`
    + ` for session ${session.id?.slice(0, 8)}`
    + ` reason: ${normalizedPlan.reasoning || 'n/a'}`
  );

  return normalizedPlan;
}

function buildPrivatePlannerBlock(lines = []) {
  const content = lines
    .map((line) => trimString(line))
    .filter(Boolean)
    .join('\n');
  if (!content) return '';
  return `<private>\n${content}\n</private>`;
}

function buildDestinationPromptInput(destination, originalMessage, { multipleDestinations = false } = {}) {
  const deliveryText = trimString(destination?.deliveryText) || trimString(originalMessage);
  const scopeFraming = trimString(destination?.scopeFraming);
  const forwardedContext = trimString(destination?.forwardedContext);
  const mode = trimString(destination?.mode) || 'continue';

  const privateLines = [
    'RemoteLab continuation planner handoff:',
    `- continuation mode: ${mode}`,
    ...(multipleDestinations ? ['- this user turn was split into multiple downstream destinations'] : []),
    ...(scopeFraming ? [`- scope framing: ${scopeFraming}`] : []),
    ...(mode === 'fork' ? ['- this session should inherit the parent session context as a rich branch continuation'] : []),
    ...(mode === 'fresh' ? ['- treat this as a new workstream and use only the forwarded bridge context below as the carry-over from the source session'] : []),
    ...(forwardedContext ? ['- forwarded bridge context:', forwardedContext] : []),
  ];
  const privateBlock = buildPrivatePlannerBlock(privateLines);
  if (!privateBlock) return deliveryText;
  return `${privateBlock}\n\n${deliveryText}`;
}

function buildDestinationNoticeLabel(destination) {
  if (destination?.mode === 'fork') return 'branch session';
  if (destination?.mode === 'fresh') return 'new session';
  return 'current session';
}

function buildContinuationNoticeMessage(plan, destinations, buildSessionNavigationHref) {
  const summary = trimString(plan?.userVisibleSummary);
  const lines = [];
  if (summary) {
    lines.push(summary);
  } else if (destinations.length > 1) {
    lines.push(`This user turn was split into ${destinations.length} follow-up sessions.`);
  } else {
    lines.push('This user turn continues in another session.');
  }

  for (const destination of destinations) {
    const session = destination?.session;
    const sessionId = trimString(session?.id);
    if (!sessionId) continue;
    const sessionName = trimString(session?.name) || 'Untitled session';
    const href = typeof buildSessionNavigationHref === 'function'
      ? trimString(buildSessionNavigationHref(sessionId))
      : '';
    const linkedName = href ? `[${sessionName}](${href})` : sessionName;
    const reason = trimString(destination?.reasoning);
    const label = buildDestinationNoticeLabel(destination);
    if (reason) {
      lines.push(`A ${label} was created as ${linkedName}. Reason: ${reason}`);
    } else {
      lines.push(`A ${label} was created as ${linkedName}.`);
    }
    if (href) {
      lines.push(`Open it here: ${href}`);
    }
  }

  return lines.join('\n\n');
}

export async function executeContinuationPlan({
  plan,
  sourceSession,
  sourceSessionId,
  message,
  images,
  options,
  createSession,
  submitMessage,
  appendEvent,
  broadcastInvalidation,
  messageEvent,
  contextOperationEvent,
  buildSessionNavigationHref,
  prepareFullParentContext,
  setPreparedChildContext,
  createDerivedRequestId,
}) {
  const destinations = Array.isArray(plan?.destinations) ? plan.destinations : [];
  if (destinations.length === 0) {
    return { applied: false, submittedCurrent: false, created: [] };
  }

  const multipleDestinations = destinations.length > 1;
  const currentDestination = destinations.find((destination) => destination?.mode === 'continue') || null;
  const childDestinations = destinations.filter((destination) => destination?.mode === 'fork' || destination?.mode === 'fresh');
  const createdDestinations = [];
  let currentOutcome = null;
  let preparedFullParentContext = null;

  if (currentDestination) {
    currentOutcome = await submitMessage(sourceSessionId, buildDestinationPromptInput(currentDestination, message, {
      multipleDestinations,
    }), images, {
      ...options,
      skipDispatch: true,
      skipPendingDispatchLookup: true,
      recordedUserText: trimString(currentDestination.deliveryText) || trimString(message),
    });
  }

  for (let index = 0; index < childDestinations.length; index += 1) {
    const destination = childDestinations[index];
    const requestId = typeof createDerivedRequestId === 'function'
      ? createDerivedRequestId(destination, index)
      : `continuation_${destination.mode}_${index + 1}`;
    const inheritRuntimePreferences = true;
    const titleHint = trimString(destination.titleHint);
    const child = await createSession(
      sourceSession.folder,
      (options.tool || sourceSession.tool || '').trim(),
      titleHint,
      {
        group: destination.mode === 'fork' ? (sourceSession.group || '') : '',
        description: destination.mode === 'fork' ? (sourceSession.description || '') : '',
        sourceId: sourceSession.sourceId || '',
        sourceName: sourceSession.sourceName || '',
        templateId: sourceSession.templateId || '',
        templateName: sourceSession.templateName || '',
        systemPrompt: sourceSession.systemPrompt || '',
        activeAgreements: sourceSession.activeAgreements || [],
        model: inheritRuntimePreferences ? sourceSession.model || '' : '',
        effort: inheritRuntimePreferences ? sourceSession.effort || '' : '',
        thinking: inheritRuntimePreferences && sourceSession.thinking === true,
        userId: sourceSession.userId || '',
        userName: sourceSession.userName || '',
        ...(destination.mode === 'fork'
          ? {
              forkedFromSessionId: sourceSession.id,
              forkedFromSeq: sourceSession.latestSeq || 0,
              rootSessionId: sourceSession.rootSessionId || sourceSession.id,
              forkedAt: new Date().toISOString(),
            }
          : {}),
      },
    );
    if (!child?.id) {
      continue;
    }

    if (destination.mode === 'fork' && typeof prepareFullParentContext === 'function' && typeof setPreparedChildContext === 'function') {
      if (!preparedFullParentContext) {
        preparedFullParentContext = await prepareFullParentContext();
      }
      if (preparedFullParentContext) {
        await setPreparedChildContext(child.id, {
          ...preparedFullParentContext,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const outcome = await submitMessage(child.id, buildDestinationPromptInput(destination, message, {
      multipleDestinations,
    }), images, {
      ...options,
      requestId,
      skipDispatch: true,
      recordedUserText: trimString(destination.deliveryText) || trimString(message),
    });

    createdDestinations.push({
      ...destination,
      session: outcome.session || child,
      run: outcome.run || null,
    });
  }

  if (createdDestinations.length > 0) {
    await appendEvent(sourceSessionId, contextOperationEvent({
      operation: 'session_continuation_plan',
      phase: 'applied',
      trigger: 'continuation_planner',
      title: 'Continuation plan applied',
      summary: trimString(plan?.userVisibleSummary)
        || (createdDestinations.length > 1
          ? `Created ${createdDestinations.length} continuation destinations`
          : 'Created 1 continuation destination'),
      reason: trimString(plan?.reasoning),
    }));

    await appendEvent(sourceSessionId, messageEvent(
      'assistant',
      buildContinuationNoticeMessage(plan, createdDestinations, buildSessionNavigationHref),
      undefined,
      { messageKind: 'session_continuation_notice' },
    ));

    broadcastInvalidation(sourceSessionId);
  }

  return {
    applied: true,
    submittedCurrent: !!currentOutcome,
    currentOutcome,
    created: createdDestinations,
  };
}
