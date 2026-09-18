const versions = new Map();
const waiters = new Map();

function routeKey(value = {}) {
  const connector = typeof value.connector === 'string' ? value.connector.trim().toLowerCase() : '';
  const sourceRouteId = typeof value.sourceRouteId === 'string' && value.sourceRouteId.trim()
    ? value.sourceRouteId.trim()
    : 'default';
  return JSON.stringify([connector, sourceRouteId]);
}

export function getSourceDeliverySignalVersion(options = {}) {
  return versions.get(routeKey(options)) || 0;
}

// Durability belongs to the outbox. This signal only removes idle claim latency;
// a missed signal is harmless because every waiter scans the outbox first and
// again when its bounded wait expires.
export function notifySourceDeliveryAvailable(deliveries = []) {
  const keys = new Set((Array.isArray(deliveries) ? deliveries : [deliveries])
    .filter(entry => entry?.state === 'pending')
    .map(routeKey));
  for (const key of keys) {
    const version = (versions.get(key) || 0) + 1;
    versions.set(key, version);
    for (const wake of [...(waiters.get(key) || [])]) wake('notified', version);
  }
}

export function waitForSourceDeliverySignal(options = {}) {
  const key = routeKey(options);
  const afterVersion = Number.isFinite(options.afterVersion) ? options.afterVersion : 0;
  const timeoutMs = Math.max(0, Number.parseInt(options.timeoutMs, 10) || 0);
  const signal = options.signal;
  const currentVersion = getSourceDeliverySignalVersion(options);
  if (currentVersion !== afterVersion) return Promise.resolve({ reason: 'notified', version: currentVersion });
  if (signal?.aborted) return Promise.resolve({ reason: 'aborted', version: currentVersion });
  if (!timeoutMs) return Promise.resolve({ reason: 'timeout', version: currentVersion });

  return new Promise(resolve => {
    let settled = false;
    let timer;
    const routeWaiters = waiters.get(key) || new Set();
    waiters.set(key, routeWaiters);
    const finish = (reason, version = getSourceDeliverySignalVersion(options)) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      routeWaiters.delete(finish);
      if (!routeWaiters.size) waiters.delete(key);
      resolve({ reason, version });
    };
    const abort = () => finish('aborted');
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    routeWaiters.add(finish);
    signal?.addEventListener('abort', abort, { once: true });

    // Close the notification-before-registration race without coupling the
    // durable writer to the HTTP waiter.
    const registeredVersion = getSourceDeliverySignalVersion(options);
    if (signal?.aborted) finish('aborted', registeredVersion);
    else if (registeredVersion !== afterVersion) finish('notified', registeredVersion);
  });
}
