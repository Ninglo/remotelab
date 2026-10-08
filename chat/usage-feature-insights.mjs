import { CAPABILITIES } from './usage-capabilities.mjs';

const distinct = (events, key) => new Set(events.map(event => event[key]).filter(Boolean)).size;
const terminal = state => ['completed', 'failed', 'blocked', 'unknown'].includes(state);
const counts = events => ({ actions: events.length, people: distinct(events, 'personHash'), sessions: distinct(events, 'sessionId') });

export function buildFeatureInsights(events, { since, sessionOrigins = [], featureStartedAt = null } = {}) {
  const requestRuns = new Map(), runPeople = new Map();
  for (const event of events) if (event.event === 'request_state' && event.requestId && event.runId) {
    requestRuns.set(event.sessionId + ':' + event.requestId, event.runId);
  }
  for (const event of events) if (event.event === 'message_submitted' && event.actorKind === 'human' && event.personHash) {
    const id = requestRuns.get(event.sessionId + ':' + event.requestId) || event.runId;
    if (!id) continue;
    if (!runPeople.has(id)) runPeople.set(id, new Set());
    runPeople.get(id).add(event.personHash);
  }
  const operations = new Map();
  for (const event of events) if (event.event === 'capability_state' && CAPABILITIES[event.feature] && event.operationId) {
    const key = event.feature + ':' + event.operationId;
    const row = operations.get(key) || { ...event, started: false, attempts: new Set() };
    row.attempts.add(event.attemptId || event.operationId);
    // A late duplicate of the start cannot reopen a settled invocation.
    if (event.state === 'started') row.started = true;
    if (terminal(event.state) || !terminal(row.state)) Object.assign(row, event);
    operations.set(key, row);
  }
  const features = [];
  for (const [feature, title] of Object.entries(CAPABILITIES)) {
    const rows = [...operations.values()].filter(row => row.feature === feature);
    if (!rows.length) continue; // An uncovered or unobserved capability is not a zero-use claim.
    const people = new Set();
    for (const row of rows) {
      if (row.actorKind !== 'automation' && row.personHash) people.add(row.personHash);
      if (row.actorKind !== 'automation') for (const person of runPeople.get(row.runId) || []) people.add(person);
    }
    features.push({ feature, title, calls: rows.length, people: people.size, sessions: distinct(rows, 'sessionId'),
      automated: rows.filter(row => row.actorKind === 'automation' || row.automationId).length,
      completed: rows.filter(row => row.state === 'completed').length,
      retryAttempts: rows.reduce((sum, row) => sum + Math.max(0, row.attempts.size - 1), 0),
      failed: rows.filter(row => row.state === 'failed').length, blocked: rows.filter(row => row.state === 'blocked').length,
      unfinished: rows.filter(row => !terminal(row.state)).length, unknown: rows.filter(row => row.state === 'unknown').length,
      unpaired: rows.filter(row => !row.started).length,
      unattributed: rows.filter(row => !row.personHash && !runPeople.has(row.runId) && !row.automationId).length });
  }
  const origins = new Map(sessionOrigins.map(origin => [origin.sessionId, origin]));
  const visits = events.filter(event => event.actorKind === 'human' && ['session_open', 'message_submitted'].includes(event.event));
  const known = visits.filter(event => Number.isFinite(origins.get(event.sessionId)?.timestamp));
  const old = known.filter(event => origins.get(event.sessionId).timestamp < since);
  const revisits = { people: distinct(old, 'personHash'), sessions: distinct(old, 'sessionId'),
    opened: distinct(old.filter(event => event.event === 'session_open'), 'sessionId'),
    continued: distinct(old.filter(event => event.event === 'message_submitted'), 'sessionId'),
    unknownOrigins: distinct(visits.filter(event => !origins.has(event.sessionId)), 'sessionId') };
  const interventions = events.filter(event => event.event === 'intervention' && event.actorKind === 'human');
  const interventionTypes = ['follow_up', 'stop', 'runtime_change', 'question_answer'].map(operation => ({
    operation, ...counts(interventions.filter(event => event.operation === operation)),
  })).filter(row => row.actions);
  const materials = events.filter(event => event.event === 'material_submitted' && event.actorKind === 'human');
  const materialTypes = [...new Set(materials.map(event => event.kind || 'file'))].map(kind => {
    const rows = materials.filter(event => (event.kind || 'file') === kind);
    return { kind, files: distinct(rows, 'objectId'), people: distinct(rows, 'personHash'), sessions: distinct(rows, 'sessionId') };
  });
  const changes = events.filter(event => event.event === 'automation_change');
  const automationRuns = new Set(events.filter(event => event.event === 'message_submitted' && event.actorKind === 'automation')
    .map(event => requestRuns.get(event.sessionId + ':' + event.requestId) || event.runId).filter(Boolean));
  const runs = new Map(events.filter(event => event.event === 'run_state').map(event => [event.runId, event]));
  const automation = { changes: counts(changes), byAction: [...new Set(changes.map(event => event.operation))]
    .map(operation => ({ operation, actions: changes.filter(event => event.operation === operation).length })),
    executions: { observed: automationRuns.size, completed: 0, failed: 0, cancelled: 0, active: 0, unknown: 0 } };
  for (const id of automationRuns) {
    const state = runs.get(id)?.state;
    const key = ['completed', 'failed', 'cancelled'].includes(state) ? state
      : ['accepted', 'running', 'starting', 'waiting', 'waiting_for_input'].includes(state) ? 'active' : 'unknown';
    automation.executions[key]++;
  }
  const deliveries = new Map(), failedDeliveries = new Set();
  for (const event of events) if (event.event === 'delivery_state' && event.objectId) {
    const previous = deliveries.get(event.objectId);
    if (event.state === 'delivery_failed') failedDeliveries.add(event.objectId);
    deliveries.set(event.objectId, { ...event, attempts: Math.max(event.attempts || 0, previous?.attempts || 0) });
  }
  const deliveryRows = [...deliveries.values()];
  const delivery = { observed: deliveryRows.length, delivered: deliveryRows.filter(event => event.state === 'delivered').length,
    failed: deliveryRows.filter(event => event.state === 'delivery_failed').length,
    unknown: deliveryRows.filter(event => event.state === 'unknown').length,
    cancelled: deliveryRows.filter(event => event.state === 'cancelled').length,
    retryAttempts: deliveryRows.reduce((sum, event) => sum + Math.max(0, event.attempts - 1), 0),
    recovered: deliveryRows.filter(event => event.state === 'delivered' && failedDeliveries.has(event.objectId)).length };
  const knowledgeRows = events.filter(event => event.event === 'knowledge_state');
  const knowledge = { retrieved: knowledgeRows.filter(event => event.operation === 'read_memory' && event.state === 'delivered').length,
    applied: knowledgeRows.filter(event => event.operation === 'write_memory' && event.state === 'applied').length,
    rejected: knowledgeRows.filter(event => event.operation === 'write_memory' && event.state === 'rejected').length };
  const links = events.filter(event => event.event === 'session_linked');
  const children = new Map(links.map(event => [event.sessionId, event]));
  const delegated = [...children.values()].filter(event => event.operation === 'delegate');
  const delegation = { forks: [...children.values()].filter(event => event.operation === 'fork').length,
    delegated: delegated.length, completed: delegated.filter(event => event.runId && runs.get(event.runId)?.state === 'completed').length,
    failed: delegated.filter(event => event.runId && runs.get(event.runId)?.state === 'failed').length,
    unknown: delegated.filter(event => !event.runId || !runs.has(event.runId)).length,
    opened: distinct(events.filter(event => event.event === 'session_open' && event.actorKind === 'human' && children.has(event.sessionId)), 'sessionId') };
  return { features, featureStartedAt, revisits, interventions: interventionTypes, materials: materialTypes,
    automation, delivery, knowledge, delegation };
}
