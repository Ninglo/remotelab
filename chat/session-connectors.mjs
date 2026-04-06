import { sanitizeEmailCompletionTargets } from '../lib/agent-mail-completion-targets.mjs';
import { sanitizeCompletionTargets } from '../lib/connector-action-dispatcher.mjs';
import { findQueueItem } from '../lib/agent-mailbox.mjs';
import { getConnectorBinding, resolveEmailConnectorBinding } from '../lib/connector-bindings.mjs';
import {
  createConnectorActionResult,
  normalizeConnectorCapabilityState,
  pickConnectorCapabilityState,
  pickConnectorDeliveryState,
} from '../lib/connector-state.mjs';
import { isTerminalRunState } from './runs.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function mailboxStatusToDeliveryState(item) {
  const status = trimString(item?.automation?.status || item?.status).toLowerCase();
  if (status === 'reply_sent') return 'delivered';
  if (status === 'reply_failed' || status === 'session_submission_failed') return 'delivery_failed';
  if (status === 'processing_for_reply' || status === 'submitted_to_session') return 'queued';
  if (status === 'approved_for_ai' || status === 'reply_ready') return 'drafted';
  return '';
}

function runTargetStateToDeliveryState(targetState = {}) {
  const state = trimString(targetState?.state).toLowerCase();
  if (state === 'sending') return 'sending';
  if (state === 'sent') return 'delivered';
  if (state === 'failed') return 'delivery_failed';
  return '';
}

function runLifecycleToDeliveryState(run = {}) {
  if (!run?.id) return '';
  if (isTerminalRunState(run.state)) return '';
  return 'queued';
}

function sessionLifecycleToDeliveryState(session = {}) {
  return session?.activity?.run?.state === 'running' ? 'queued' : '';
}

function buildEmailTargetId(target) {
  const threadRef = firstNonEmpty(target?.inReplyTo, target?.references);
  if (threadRef) return `thread:${threadRef}`;
  const recipient = trimString(target?.to).toLowerCase();
  if (recipient) return `recipient:${recipient}`;
  return `action:${trimString(target?.id)}`;
}

function compactBindingSurface(binding) {
  return {
    id: trimString(binding?.id),
    connectorId: trimString(binding?.connectorId),
    kind: trimString(binding?.kind),
    scope: trimString(binding?.scope),
    title: trimString(binding?.title),
    capabilityState: trimString(binding?.capabilityState),
    address: trimString(binding?.identity?.address),
    provider: trimString(binding?.provider),
    outbound: {
      configured: binding?.outbound?.configured === true,
      missing: Array.isArray(binding?.outbound?.missing) ? [...binding.outbound.missing] : [],
      setupHint: trimString(binding?.outbound?.setupHint),
      from: trimString(binding?.outbound?.from),
      replyTo: trimString(binding?.outbound?.replyTo),
    },
  };
}

async function loadMailboxState(target, binding) {
  const mailboxItemId = trimString(target?.mailboxItemId);
  const mailboxRoot = trimString(binding?.mailboxRoot || target?.mailboxRoot);
  if (!mailboxItemId || !mailboxRoot) return null;
  return await findQueueItem(mailboxItemId, mailboxRoot);
}

async function resolveEmailAction(target, { session = null, run = null, bindingCache = new Map() } = {}) {
  const cacheKey = trimString(target?.bindingId) || trimString(target?.mailboxRoot) || 'default-email';
  let binding = bindingCache.get(cacheKey);
  if (!binding) {
    binding = await resolveEmailConnectorBinding({
      bindingId: trimString(target?.bindingId),
      rootDir: trimString(target?.mailboxRoot),
      ensureStored: false,
    });
    bindingCache.set(cacheKey, binding);
  }

  const mailboxState = await loadMailboxState(target, binding);
  const targetRunState = run?.completionTargets?.[target.id] || null;
  const deliveryState = pickConnectorDeliveryState([
    runTargetStateToDeliveryState(targetRunState),
    mailboxStatusToDeliveryState(mailboxState?.item),
    runLifecycleToDeliveryState(run),
    sessionLifecycleToDeliveryState(session),
    'drafted',
  ], 'drafted');
  const lastError = firstNonEmpty(
    targetRunState?.lastError,
    mailboxState?.item?.automation?.lastError,
  );
  const externalId = firstNonEmpty(
    targetRunState?.delivery?.externalId,
    targetRunState?.delivery?.responseId,
    mailboxState?.item?.automation?.delivery?.externalId,
    mailboxState?.item?.automation?.delivery?.responseId,
  );

  return createConnectorActionResult({
    actionId: trimString(target?.id),
    connectorId: 'email',
    bindingId: trimString(binding?.id),
    targetId: buildEmailTargetId(target),
    capabilityState: trimString(binding?.capabilityState) || 'binding_required',
    deliveryState,
    externalId,
    message: lastError || '',
    retryable: deliveryState === 'delivery_failed' && trimString(binding?.capabilityState) === 'ready',
  });
}

function buildConnectorSurface(actions, bindings) {
  if (!actions.length && !bindings.length) return null;
  return {
    capabilityState: pickConnectorCapabilityState([
      ...bindings.map((binding) => binding.capabilityState),
      ...actions.map((action) => action.capabilityState),
    ]),
    deliveryState: pickConnectorDeliveryState(actions.map((action) => action.deliveryState), ''),
    bindings,
    actions,
  };
}

function compactGenericBindingSurface(binding) {
  return {
    id: trimString(binding?.id),
    connectorId: trimString(binding?.connectorId),
    kind: trimString(binding?.kind),
    scope: trimString(binding?.scope),
    title: trimString(binding?.title),
    capabilityState: trimString(binding?.capabilityState),
  };
}

async function resolveCalendarAction(target, { session = null, run = null } = {}) {
  // Calendar uses the iCal subscription feed — always ready, no binding required.
  const targetRunState = run?.completionTargets?.[target.id] || null;
  const deliveryState = pickConnectorDeliveryState([
    runTargetStateToDeliveryState(targetRunState),
    runLifecycleToDeliveryState(run),
    sessionLifecycleToDeliveryState(session),
    'drafted',
  ], 'drafted');

  return createConnectorActionResult({
    actionId: trimString(target?.id),
    connectorId: 'calendar',
    targetId: `event:${trimString(target?.title).slice(0, 50)}`,
    capabilityState: 'ready',
    deliveryState,
    message: targetRunState?.lastError || '',
  });
}

async function buildConnectorSurfaceFromSession(session, run = null) {
  const emailTargets = sanitizeEmailCompletionTargets(session?.completionTargets || []);
  const calendarTargets = sanitizeCompletionTargets(session?.completionTargets || [])
    .filter((t) => t.type === 'calendar');
  if (emailTargets.length === 0 && calendarTargets.length === 0) return null;

  const bindingCache = new Map();
  const bindingSurfaces = new Map();
  const actions = [];

  for (const target of emailTargets) {
    const action = await resolveEmailAction(target, { session, run, bindingCache });
    actions.push(action);
    const binding = await resolveEmailConnectorBinding({
      bindingId: action.bindingId,
      rootDir: trimString(target?.mailboxRoot),
      ensureStored: false,
    });
    if (binding?.id && !bindingSurfaces.has(binding.id)) {
      bindingSurfaces.set(binding.id, compactBindingSurface(binding));
    }
  }

  for (const target of calendarTargets) {
    const action = await resolveCalendarAction(target, { session, run });
    actions.push(action);
    const bindingId = trimString(target?.bindingId);
    if (bindingId && !bindingSurfaces.has(bindingId)) {
      const binding = await getConnectorBinding(bindingId);
      if (binding) {
        bindingSurfaces.set(binding.id, compactGenericBindingSurface(binding));
      }
    }
  }

  return buildConnectorSurface(actions, [...bindingSurfaces.values()]);
}

export async function buildSessionConnectorSurface(session) {
  return await buildConnectorSurfaceFromSession(session, null);
}

export async function buildRunConnectorSurface(session, run) {
  return await buildConnectorSurfaceFromSession(session, run);
}
