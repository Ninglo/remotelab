import { listSourceDeliveryIssues } from './source-deliveries.mjs';
import { broadcastOwners } from './ws-clients.mjs';

// Time alone can turn a pending delivery into a visible delay. Wake open pages
// even when its connector is stopped and no delivery mutation can broadcast.
export function createSourceDeliveryIssueObserver({
  loadIssues = listSourceDeliveryIssues,
  notify = sessionId => broadcastOwners({ type: 'session_invalidated', sessionId }),
  onError = error => console.error(`[source-deliveries] issue observation failed: ${error.message}`),
  intervalMs = 10_000,
} = {}) {
  let previous = new Map();
  let timer;
  let pending;
  const tick = () => pending ||= Promise.resolve().then(async () => {
    const grouped = new Map();
    for (const issue of await loadIssues()) {
      if (!grouped.has(issue.sessionId)) grouped.set(issue.sessionId, []);
      grouped.get(issue.sessionId).push(issue);
    }
    const next = new Map([...grouped].map(([id, issues]) => [id, JSON.stringify(issues)]));
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      if (previous.get(id) !== next.get(id)) notify(id);
    }
    previous = next;
  }).catch(onError).finally(() => { pending = null; });
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => void tick(), intervalMs); timer.unref?.(); } void tick(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
