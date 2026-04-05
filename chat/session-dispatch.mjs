/**
 * Pre-execution session dispatch.
 *
 * Before a user message enters the normal turn lifecycle, this module
 * classifies whether it belongs in the current session or should be
 * routed to an existing or new session.
 */

import { buildDispatchClassifierPrompt, parseDispatchDecision } from './session-dispatch-prompt.mjs';

const DISPATCH_CONFIDENCE_THRESHOLD = 0.75;
const DISPATCH_SETTING_ENV = 'REMOTELAB_SESSION_DISPATCH';

function normalizeDispatchSetting(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || ['0', 'false', 'off', 'disabled', 'disable', 'none'].includes(normalized)) {
    return 'off';
  }
  if (['1', 'true', 'on', 'enabled', 'enable', 'all'].includes(normalized)) {
    return 'on';
  }
  return normalized;
}

function isDispatchEnabled() {
  return normalizeDispatchSetting(process.env[DISPATCH_SETTING_ENV]) === 'on';
}

/**
 * Quick keyword pre-check: does the message text match any App's trigger keywords?
 * Returns the matched App or null. Used as a fast path before the LLM classifier.
 */
function matchAppByTriggers(message, apps) {
  if (!message || !apps?.length) return null;
  const lowerMessage = message.toLowerCase();
  for (const app of apps) {
    const triggers = app.scopeHints?.triggers;
    if (!Array.isArray(triggers) || triggers.length === 0) continue;
    for (const trigger of triggers) {
      if (trigger && lowerMessage.includes(trigger.toLowerCase())) {
        return app;
      }
    }
  }
  return null;
}

/**
 * Determines whether dispatch classification should run for this message.
 */
export function shouldRunDispatch(session, options = {}) {
  if (!isDispatchEnabled()) return false;
  if (options.internalOperation) return false;
  if (options.skipDispatch) return false;
  if (session?.visitorId) return false;
  // Don't dispatch queued follow-up flushes
  if (options.queueIfBusy === false && options.recordUserMessage === false) return false;
  return true;
}

/**
 * Run the dispatch classifier and return a decision.
 *
 * @param {object} params
 * @param {object} params.session - Current session metadata
 * @param {string} params.message - Incoming user message text
 * @param {Function} params.listSessions - Async function returning active sessions
 * @param {Function} params.listApps - Async function returning available apps
 * @param {Function} params.runPrompt - Async function to run a one-shot LLM prompt
 * @returns {Promise<object>} Dispatch decision
 */
export async function classifyDispatch({
  session,
  message,
  listSessions,
  listApps,
  runPrompt,
}) {
  const defaultDecision = { action: 'continue', confidence: 1, reason: 'default' };

  // Short messages (greetings, acknowledgments) almost always belong in current session
  const trimmedMessage = String(message || '').trim();
  if (trimmedMessage.length < 5) {
    return defaultDecision;
  }

  // New/empty sessions always continue
  if (!session?.name || session.name.startsWith('New Session') || session.autoRenamePending === true) {
    return defaultDecision;
  }

  let recentSessions = [];
  let availableApps = [];

  try {
    [recentSessions, availableApps] = await Promise.all([
      listSessions(),
      listApps(),
    ]);
  } catch (error) {
    console.error(`[session-dispatch] Failed to load context: ${error.message}`);
    return defaultDecision;
  }

  // Quick keyword match against App triggers
  const triggerMatch = matchAppByTriggers(trimmedMessage, availableApps);

  // If the current session already belongs to the matched App, no routing needed
  if (triggerMatch && session.sourceId === triggerMatch.id) {
    return defaultDecision;
  }

  // Build and run the classifier prompt
  const prompt = buildDispatchClassifierPrompt({
    currentSession: session,
    message: trimmedMessage,
    recentSessions,
    availableApps,
  });

  let rawResponse = '';
  try {
    rawResponse = await runPrompt(prompt);
  } catch (error) {
    console.error(`[session-dispatch] Classifier failed: ${error.message}`);
    return defaultDecision;
  }

  const decision = parseDispatchDecision(rawResponse);

  // Apply confidence threshold
  if (decision.action !== 'continue' && decision.confidence < DISPATCH_CONFIDENCE_THRESHOLD) {
    console.log(
      `[session-dispatch] Low confidence ${decision.confidence.toFixed(2)} for ${decision.action}, falling back to continue. Reason: ${decision.reason}`
    );
    return { ...decision, action: 'continue', reason: `low confidence: ${decision.reason}` };
  }

  // Validate route_existing target
  if (decision.action === 'route_existing') {
    const targetExists = recentSessions.some((s) => s.id === decision.targetSessionId);
    if (!targetExists) {
      console.log(`[session-dispatch] Target session ${decision.targetSessionId} not found, falling back to route_new`);
      decision.action = 'route_new';
      decision.targetSessionId = '';
    }
  }

  // Inject trigger-matched App if classifier didn't suggest one
  if (triggerMatch && !decision.targetAppId) {
    decision.targetAppId = triggerMatch.id;
  }

  console.log(
    `[session-dispatch] Decision: ${decision.action} (confidence: ${decision.confidence.toFixed(2)}) for session ${session.id?.slice(0, 8)}. Reason: ${decision.reason}`
  );

  return decision;
}

/**
 * Execute a dispatch decision by routing the message to the appropriate session.
 *
 * @param {object} params
 * @param {object} params.decision - The dispatch decision from classifyDispatch
 * @param {string} params.sourceSessionId - The session the message was originally sent to
 * @param {string} params.message - The original user message
 * @param {Array} params.images - The original images
 * @param {object} params.options - The original submitHttpMessage options
 * @param {Function} params.createSession - Async fn to create a new session
 * @param {Function} params.submitMessage - Async fn to submit message to a session
 * @param {Function} params.getSession - Async fn to get session metadata
 * @param {Function} params.getApp - Async fn to get app by id
 * @param {Function} params.appendEvent - Async fn to append event to session
 * @param {Function} params.broadcastInvalidation - Fn to broadcast session invalidation
 * @param {Function} params.messageEvent - Fn to create a message event
 * @param {Function} params.statusEvent - Fn to create a status event
 * @param {Function} params.contextOperationEvent - Fn to create a context operation event
 * @param {Function} params.buildSessionNavigationHref - Fn to build session navigation href
 * @returns {Promise<object>} Routing outcome
 */
export async function executeDispatchRouting({
  decision,
  sourceSessionId,
  message,
  images,
  options,
  createSession,
  submitMessage,
  getSession,
  getApp,
  appendEvent,
  broadcastInvalidation,
  messageEvent,
  statusEvent,
  contextOperationEvent,
  buildSessionNavigationHref,
}) {
  const targetAppId = decision.targetAppId || '';
  let targetSessionId = decision.targetSessionId || '';
  let targetSession = null;

  if (decision.action === 'route_existing' && targetSessionId) {
    targetSession = await getSession(targetSessionId);
    if (!targetSession) {
      // Target vanished, fall back to new session
      decision.action = 'route_new';
      targetSessionId = '';
    }
  }

  if (decision.action === 'route_new') {
    // Resolve target App for defaults
    let app = null;
    if (targetAppId) {
      app = await getApp(targetAppId);
    }

    // Create new session with App defaults
    targetSession = await createSession(
      app?.tool || '',
      '',  // name will be auto-generated
      {
        sourceId: targetAppId || '',
        sourceName: app?.name || '',
        systemPrompt: app?.systemPrompt || '',
      },
    );

    if (!targetSession?.id) {
      console.error('[session-dispatch] Failed to create target session');
      return { routed: false };
    }
    targetSessionId = targetSession.id;
  }

  if (!targetSessionId) {
    return { routed: false };
  }

  // Submit the user's original message to the target session
  const outcome = await submitMessage(targetSessionId, message, images, {
    ...options,
    skipDispatch: true,  // Prevent recursive dispatch
  });

  // Add routing notice to source session
  const targetName = targetSession?.name || 'new session';
  const link = buildSessionNavigationHref
    ? `[${targetName}](${buildSessionNavigationHref(targetSessionId)})`
    : targetName;

  await appendEvent(sourceSessionId, contextOperationEvent({
    operation: 'dispatch_route',
    phase: 'applied',
    trigger: 'session_dispatch',
    title: 'Message routed to another session',
    summary: `Routed to ${targetName} because: ${decision.reason}`,
    targetSessionId,
  }));

  await appendEvent(sourceSessionId, messageEvent(
    'assistant',
    [
      `This message is about a different topic, so I've moved it to ${link}.`,
      '',
      `Reason: ${decision.reason}`,
    ].join('\n'),
    undefined,
    { messageKind: 'session_dispatch_notice' },
  ));

  broadcastInvalidation(sourceSessionId);

  return {
    routed: true,
    targetSessionId,
    targetSession: outcome.session || targetSession,
    run: outcome.run || null,
  };
}
