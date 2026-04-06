const CONNECTOR_CAPABILITY_STATES = Object.freeze([
  'connector_unavailable',
  'binding_required',
  'authorization_required',
  'ready',
]);

const CONNECTOR_DELIVERY_STATES = Object.freeze([
  'drafted',
  'queued',
  'sending',
  'delivered',
  'delivery_failed',
  'cancelled',
]);

const CAPABILITY_STATE_SET = new Set(CONNECTOR_CAPABILITY_STATES);
const DELIVERY_STATE_SET = new Set(CONNECTOR_DELIVERY_STATES);

const CAPABILITY_STATE_PRIORITY = new Map([
  ['connector_unavailable', 4],
  ['binding_required', 3],
  ['authorization_required', 2],
  ['ready', 1],
]);

const DELIVERY_STATE_PRIORITY = new Map([
  ['delivery_failed', 6],
  ['sending', 5],
  ['queued', 4],
  ['drafted', 3],
  ['delivered', 2],
  ['cancelled', 1],
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function connectorLabel(connectorId) {
  const normalized = trimString(connectorId).toLowerCase();
  if (!normalized) return 'connector';
  if (normalized === 'email') return 'email';
  return normalized.replace(/[_-]+/g, ' ');
}

export function normalizeConnectorCapabilityState(value, fallback = 'connector_unavailable') {
  const normalized = trimString(value).toLowerCase();
  if (CAPABILITY_STATE_SET.has(normalized)) return normalized;
  return fallback;
}

export function normalizeConnectorDeliveryState(value, fallback = '') {
  const normalized = trimString(value).toLowerCase();
  if (DELIVERY_STATE_SET.has(normalized)) return normalized;
  return fallback;
}

export function pickConnectorCapabilityState(values = [], fallback = '') {
  let best = normalizeConnectorCapabilityState(fallback || '', '');
  let bestPriority = best ? (CAPABILITY_STATE_PRIORITY.get(best) || 0) : 0;
  for (const value of values) {
    const normalized = normalizeConnectorCapabilityState(value, '');
    if (!normalized) continue;
    const priority = CAPABILITY_STATE_PRIORITY.get(normalized) || 0;
    if (priority > bestPriority) {
      best = normalized;
      bestPriority = priority;
    }
  }
  return best;
}

export function pickConnectorDeliveryState(values = [], fallback = '') {
  let best = normalizeConnectorDeliveryState(fallback || '', '');
  let bestPriority = best ? (DELIVERY_STATE_PRIORITY.get(best) || 0) : 0;
  for (const value of values) {
    const normalized = normalizeConnectorDeliveryState(value, '');
    if (!normalized) continue;
    const priority = DELIVERY_STATE_PRIORITY.get(normalized) || 0;
    if (priority > bestPriority) {
      best = normalized;
      bestPriority = priority;
    }
  }
  return best;
}

function defaultRequiresUserAction(capabilityState) {
  if (capabilityState === 'binding_required') {
    return { kind: 'connect_binding' };
  }
  if (capabilityState === 'authorization_required') {
    return { kind: 'authorize_binding' };
  }
  return null;
}

function defaultMessage({ connectorId, capabilityState, deliveryState }) {
  const label = connectorLabel(connectorId);

  if (capabilityState === 'binding_required') {
    return `This instance does not have a ${label} binding yet.`;
  }
  if (capabilityState === 'authorization_required') {
    return `This instance has a ${label} binding, but it still needs authorization.`;
  }
  if (capabilityState === 'connector_unavailable') {
    return `This instance does not have a usable ${label} connector.`;
  }
  if (deliveryState === 'delivery_failed') {
    return `${label[0]?.toUpperCase() || 'C'}${label.slice(1)} delivery failed.`;
  }
  if (deliveryState === 'delivered') {
    return `Sent through the bound ${label} connector.`;
  }
  if (deliveryState === 'sending') {
    return `Sending through the bound ${label} connector.`;
  }
  if (deliveryState === 'queued') {
    return `${label[0]?.toUpperCase() || 'C'}${label.slice(1)} delivery is queued.`;
  }
  if (deliveryState === 'drafted') {
    return `${label[0]?.toUpperCase() || 'C'}${label.slice(1)} delivery is drafted but not sent yet.`;
  }
  if (deliveryState === 'cancelled') {
    return `${label[0]?.toUpperCase() || 'C'}${label.slice(1)} delivery was cancelled.`;
  }
  return '';
}

export function createConnectorActionResult(input = {}) {
  const connectorId = trimString(input.connectorId).toLowerCase();
  const capabilityState = normalizeConnectorCapabilityState(input.capabilityState);
  const deliveryState = normalizeConnectorDeliveryState(input.deliveryState, 'drafted');
  const explicitRetryable = typeof input.retryable === 'boolean' ? input.retryable : null;

  return {
    actionId: trimString(input.actionId),
    connectorId,
    bindingId: trimString(input.bindingId),
    targetId: trimString(input.targetId),
    capabilityState,
    deliveryState,
    externalId: trimString(input.externalId),
    message: trimString(input.message) || defaultMessage({ connectorId, capabilityState, deliveryState }),
    retryable: explicitRetryable !== null
      ? explicitRetryable
      : (deliveryState === 'delivery_failed' && capabilityState === 'ready'),
    requiresUserAction: input.requiresUserAction === undefined
      ? defaultRequiresUserAction(capabilityState)
      : (input.requiresUserAction || null),
  };
}

export {
  CONNECTOR_CAPABILITY_STATES,
  CONNECTOR_DELIVERY_STATES,
};
