import { observeUsage, usageKey } from './usage-events.mjs';

const author = auth => ({ actorKind: auth?.authKind === 'service' ? 'agent' : 'human',
  surface: auth?.authKind === 'service' ? 'agent' : 'web' });
const configKeys = ['status', 'enabled', 'title', 'text', 'scheduledAt', 'cadence', 'cron', 'timezone',
  'lifetime', 'gate', 'wakeOn', 'alerts', 'automationPolicy', 'runtimePolicy', 'tool', 'model', 'effort', 'thinking'];
const configuration = record => JSON.stringify(configKeys.map(key => [key, record?.[key] ?? null]));

export function observeAutomationChange(after, before, auth, operation = '') {
  if (!after?.id || (before && configuration(after) === configuration(before))) return;
  operation ||= !before ? 'create' : after.status !== before.status || after.enabled !== before.enabled
    ? after.status === 'paused' ? 'pause' : after.status === 'cancelled' || after.enabled === false ? 'cancel' : 'resume' : 'update';
  observeUsage({ event: 'automation_change',
    eventId: usageKey(`automation:${after.id}:${after.updatedAt}:${operation}:${configuration(after)}`),
    automationId: after.id, sessionId: after.sourceSessionId, operation, state: 'saved', ...author(auth) },
  { personId: auth?.authKind === 'service' ? '' : auth?.personId });
}

export function observeIntervention(sessionId, operation, auth, runId = '') {
  observeUsage({ ...(operation === 'stop' && runId ? { eventId: usageKey(`stop:${sessionId}:${runId}`) } : {}),
    event: 'intervention', sessionId, runId, operation, state: 'applied', ...author(auth) },
    { personId: auth?.authKind === 'service' ? '' : auth?.personId });
}

export function runtimeUsageChanged(before, after) {
  return JSON.stringify(['tool', 'model', 'effort', 'thinking', 'runtimeTier', 'feishuRuntimeSelection'].map(key => before?.[key] ?? null))
    !== JSON.stringify(['tool', 'model', 'effort', 'thinking', 'runtimeTier', 'feishuRuntimeSelection'].map(key => after?.[key] ?? null));
}
