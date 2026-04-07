import { sanitizeEmailCompletionTargets, dispatchSessionEmailCompletionTargets } from './agent-mail-completion-targets.mjs';
import { createCalendarEvent } from './connector-calendar.mjs';
import { dispatchCalendarToFeed } from './connector-calendar-feed.mjs';
import { createConnectorActionResult } from './connector-state.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTargetType(target) {
  return trimString(target?.type || target?.kind).toLowerCase() || 'email';
}

function sanitizeCalendarTarget(target, index) {
  const title = trimString(target?.title || target?.summary);
  if (!title) return null;
  const id = trimString(target?.id) || `calendar_target_${index + 1}`;
  return {
    id,
    type: 'calendar',
    enabled: target?.enabled !== false,
    requestId: trimString(target?.requestId),
    bindingId: trimString(target?.bindingId),
    title,
    startTime: trimString(target?.startTime || target?.start),
    endTime: trimString(target?.endTime || target?.end),
    location: trimString(target?.location),
    description: trimString(target?.description),
    calendarId: trimString(target?.calendarId),
    timezone: trimString(target?.timezone),
    credentialsPath: trimString(target?.credentialsPath),
    reminderMinutesBefore: target?.reminderMinutesBefore,
  };
}

export function sanitizeCompletionTargets(targets = []) {
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target, index) => {
      const type = normalizeTargetType(target);
      if (type === 'email') return null;
      if (type === 'calendar') return sanitizeCalendarTarget(target, index);
      return null;
    })
    .filter(Boolean);
}

export function sanitizeAllCompletionTargets(targets = []) {
  if (!Array.isArray(targets)) return [];
  const emailTargets = sanitizeEmailCompletionTargets(targets);
  const otherTargets = sanitizeCompletionTargets(targets);
  return [...emailTargets, ...otherTargets];
}

function groupTargetsByType(targets) {
  const groups = new Map();
  for (const target of targets) {
    const type = normalizeTargetType(target);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(target);
  }
  return groups;
}

async function dispatchCalendarTarget(target, { sessionId, runId, baseUrl } = {}) {
  try {
    const result = target.bindingId && target.credentialsPath
      ? await createCalendarEvent({
          bindingId: target.bindingId,
          credentialsPath: target.credentialsPath,
          title: target.title,
          startTime: target.startTime,
          endTime: target.endTime,
          description: target.description,
          location: target.location,
          calendarId: target.calendarId,
          timezone: target.timezone,
          reminderMinutesBefore: target.reminderMinutesBefore,
        })
      : await dispatchCalendarToFeed(target, { sessionId, runId, baseUrl });
    return {
      id: target.id,
      connectorId: 'calendar',
      state: result.deliveryState === 'delivered' ? 'sent' : 'failed',
      result,
    };
  } catch (error) {
    return {
      id: target.id,
      connectorId: 'calendar',
      state: 'failed',
      error: error.message,
      result: createConnectorActionResult({
        actionId: target.id,
        connectorId: 'calendar',
        bindingId: target.bindingId,
        capabilityState: target.bindingId ? 'ready' : 'connector_unavailable',
        deliveryState: 'delivery_failed',
        message: `${target.bindingId && target.credentialsPath ? 'Bound calendar' : 'Calendar feed'} delivery failed: ${error.message}`,
      }),
    };
  }
}

export async function dispatchSessionConnectorActions(session, run, options = {}) {
  const allTargets = sanitizeAllCompletionTargets(session?.completionTargets || []);
  if (!session?.id || !run?.id || allTargets.length === 0) {
    return [];
  }

  const grouped = groupTargetsByType(allTargets);
  const results = [];

  const emailTargets = grouped.get('email') || [];
  if (emailTargets.length > 0) {
    const emailSession = {
      ...session,
      completionTargets: emailTargets,
    };
    const emailResults = await dispatchSessionEmailCompletionTargets(emailSession, run, options);
    results.push(...emailResults.map((result) => ({
      ...result,
      connectorId: 'email',
    })));
  }

  const calendarTargets = grouped.get('calendar') || [];
  for (const target of calendarTargets) {
    if (!target.enabled) continue;
    const calResult = await dispatchCalendarTarget(target, {
      sessionId: session.id,
      runId: run.id,
      baseUrl: trimString(options?.baseUrl),
    });
    results.push(calResult);
  }

  return results;
}
