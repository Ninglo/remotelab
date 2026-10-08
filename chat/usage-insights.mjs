// Product questions are calculated from the entire qualified window, never
// from the capped recent-event list. Raw events stay available for diagnostics.
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const fraction = (numerator, denominator, reliable = true) => ({
  numerator, denominator, rate: denominator && reliable ? numerator / denominator : null,
});
const conversation = event => event.sessionId || '';
const ordinaryInput = event => event.event === 'message_submitted' && event.actorKind === 'human' && event.kind !== 'question_answer';
const settledState = event => ['completed', 'failed', 'cancelled', 'answered', 'timeout', 'unanswered', 'expired'].includes(event.state) ? 1 : 0;
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = timestamp => {
  const parts = Object.fromEntries(dayFormat.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
};

export function buildUsageInsights(events, { start = 0, now = Date.now(), collectionStartedAt = null,
  gaps = [], scanIncomplete = false, dropped = 0, failures = 0 } = {}) {
  // Following a known gap, begin a new continuous observation interval.
  // Pairing events across a missing interval would invent timings/conversions.
  const gapEnd = Math.max(0, ...gaps.map(gap => gap.end).filter(end => Number.isFinite(end) && end <= now));
  const since = Math.max(start, Date.parse(collectionStartedAt) || start, gapEnd);
  const reliable = !scanIncomplete && !dropped && !failures;
  const ids = new Set();
  const qualified = events.filter(event => {
    if (!Number.isFinite(event.timestamp) || event.timestamp < since || event.timestamp > now || ids.has(event.eventId)) return false;
    ids.add(event.eventId); return true;
  }).sort((a, b) => a.timestamp - b.timestamp || (a.ingestedAt || 0) - (b.ingestedAt || 0)
    || (a.historySeq || 0) - (b.historySeq || 0) || settledState(a) - settledState(b));
  const humanInputs = qualified.filter(event => event.event === 'message_submitted' && event.actorKind === 'human');
  const inputs = humanInputs.filter(ordinaryInput), humanSessions = new Set(humanInputs.map(conversation).filter(Boolean));
  const ordinarySessions = new Set(inputs.map(conversation).filter(Boolean));
  const people = new Set(humanInputs.map(event => event.personHash).filter(Boolean));
  const turns = new Map(), days = new Map();
  for (const event of inputs) {
    if (event.sessionId) turns.set(event.sessionId, (turns.get(event.sessionId) || 0) + 1);
  }
  for (const event of humanInputs) {
    const day = dayKey(event.timestamp);
    if (!days.has(day)) days.set(day, { people: new Set(), sessions: new Set(), inputs: 0 });
    const row = days.get(day); row.inputs++;
    if (event.personHash) row.people.add(event.personHash);
    if (event.sessionId) row.sessions.add(event.sessionId);
  }
  const multiTurn = [...turns.values()].filter(count => count >= 2).length;
  const activity = { people: people.size, sessions: humanSessions.size, inputs: inputs.length,
    questionAnswers: humanInputs.length - inputs.length,
    unidentifiedInputs: humanInputs.filter(event => !event.personHash).length,
    multiTurn: fraction(multiTurn, ordinarySessions.size, reliable),
    daily: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, row]) => ({
      day, people: row.people.size, sessions: row.sessions.size, inputs: row.inputs,
    })) };
  const journeys = analyzeJourneys(qualified, reliable);
  const execution = analyzeExecution(qualified, inputs, humanSessions, reliable, now);
  const artifacts = analyzeArtifacts(qualified, reliable);
  return { schemaVersion: 1, since: new Date(since).toISOString(), until: new Date(now).toISOString(),
    quality: { reliable, afterGap: gapEnd > Math.max(start, Date.parse(collectionStartedAt) || start),
      webObserved: qualified.some(event => event.actorKind === 'human' && ['page_enter', 'session_open', 'artifact_open'].includes(event.event)),
      unknownIdentities: activity.unidentifiedInputs }, activity, journeys, execution, artifacts };
}

function analyzeJourneys(events, reliable) {
  const groups = new Map();
  for (const event of events) {
    if (event.actorKind !== 'human' || !event.personHash || !event.sessionId) continue;
    const key = event.personHash + ':' + event.sessionId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  let started = 0, opened = 0, continued = 0, answeredInWeb = 0, returned = 0;
  let webSamples = false;
  for (const group of groups.values()) {
    const first = group.find(ordinaryInput);
    if (first?.surface !== 'feishu') continue;
    started++;
    const later = group.filter(event => event.timestamp > first.timestamp);
    if (later.some(event => event.surface === 'web' && event.event === 'session_open')) { opened++; webSamples = true; }
    const web = later.find(event => event.surface === 'web' && event.event === 'message_submitted');
    if (later.some(event => event.surface === 'web' && event.event === 'message_submitted' && event.kind === 'question_answer')) answeredInWeb++;
    if (!web) continue;
    webSamples = true; continued++;
    if (first.conversationKey && later.some(event => event.event === 'message_submitted' && event.surface === 'feishu'
      && event.timestamp > web.timestamp && event.conversationKey === first.conversationKey)) returned++;
  }
  // Web input is authoritative even when a browser-open record is missing.
  // Opening and continuing are independent branches, not a forced funnel.
  return { started, opened: fraction(opened, started, reliable && opened > 0),
    continued: fraction(continued, started, reliable && webSamples),
    returned: fraction(returned, continued, reliable), answeredInWeb };
}

function analyzeExecution(events, inputs, humanSessions, reliable, now) {
  const runs = new Map(), resultLinks = new Map(), starts = new Map(), linkedRuns = new Set(), questions = new Map();
  for (const event of events) {
    if (event.event === 'run_state' && event.runId) runs.set(event.runId, event);
    if (event.event === 'request_state' && event.requestId && event.runId) resultLinks.set(event.sessionId + ':' + event.requestId, event.runId);
    if (event.event === 'question_state' && event.questionId && humanSessions.has(event.sessionId)) {
      const key = event.sessionId + ':' + event.questionId;
      const question = questions.get(key) || { pending: null };
      if (event.state === 'pending' && !question.pending) question.pending = event;
      question.latest = event; questions.set(key, question);
    }
  }
  for (const input of inputs) {
    const id = resultLinks.get(input.sessionId + ':' + input.requestId) || input.runId;
    if (!id || !runs.has(id)) continue;
    linkedRuns.add(id);
    // A follow-up attached to an older Run is not a new execution start.
    if (input.runId === id) starts.set(id, Math.min(starts.get(id) ?? Infinity, input.timestamp));
  }
  const counts = { observed: linkedRuns.size, completed: 0, failed: 0, cancelled: 0, active: 0, unknown: 0 };
  const durations = [], review = new Map();
  const addReview = (event, reason) => {
    if (!event.sessionId) return;
    const row = review.get(event.sessionId) || { sessionId: event.sessionId, reasons: new Set(), latestAt: 0 };
    row.reasons.add(reason); row.latestAt = Math.max(row.latestAt, event.timestamp); review.set(event.sessionId, row);
  };
  for (const id of linkedRuns) {
    const run = runs.get(id);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) counts[run.state]++;
    else if (['accepted', 'running', 'starting', 'waiting', 'waiting_for_input', 'waiting_for_user'].includes(run.state)) counts.active++;
    else counts.unknown++;
    if (run.state === 'failed') addReview(run, 'execution_failed');
    if (run.state === 'completed' && starts.has(id) && run.timestamp >= starts.get(id)) durations.push(run.timestamp - starts.get(id));
  }
  let raised = 0, answered = 0, pending = 0, closed = 0, outsideWindow = 0;
  const waits = [], askingSessions = new Set();
  for (const question of questions.values()) {
    if (!question.pending) { outsideWindow++; continue; }
    raised++; askingSessions.add(question.pending.sessionId);
    const last = question.latest, run = runs.get(last.runId);
    if (last.state === 'answered') {
      answered++; if (last.timestamp >= question.pending.timestamp) waits.push(last.timestamp - question.pending.timestamp);
    } else if (last.state === 'pending') {
      const expired = last.deadline && last.deadline <= now;
      const runEnded = run && ['completed', 'failed', 'cancelled'].includes(run.state) && run.timestamp >= last.timestamp;
      if (!expired && !runEnded) { pending++; addReview(last, 'answer_not_observed'); }
      else closed++;
    } else closed++;
  }
  return { ...counts, inputToEndMedianMs: reliable ? median(durations) : null, durationSamples: durations.length,
    waiting: { raised, answered, pending, closed, outsideWindow,
      askingSessions: fraction(askingSessions.size, humanSessions.size, reliable),
      answerRate: fraction(answered, raised, reliable), answerMedianMs: reliable ? median(waits) : null, durationSamples: waits.length },
    review: [...review.values()].sort((a, b) => b.latestAt - a.latestAt).slice(0, 5)
      .map(row => ({ ...row, reasons: [...row.reasons] })) };
}

function analyzeArtifacts(events, reliable) {
  const aliases = new Map();
  const root = id => {
    let current = id;
    while (aliases.has(current)) current = aliases.get(current);
    while (aliases.has(id)) { const next = aliases.get(id); aliases.set(id, current); id = next; }
    return current;
  };
  for (const event of events) if (event.event === 'artifact_registered' && event.objectId && event.originObjectId) {
    const asset = root(event.objectId), origin = root(event.originObjectId);
    if (asset !== origin) aliases.set(asset, origin);
  }
  const objects = new Map(), clicked = new Set();
  const object = event => {
    const id = root(event.objectId);
    if (!objects.has(id)) objects.set(id, { kind: event.kind || 'file', createdAt: null, providedAt: null, opened: false, updates: 0 });
    const item = objects.get(id);
    if (event.kind && event.kind !== 'file') item.kind = event.kind;
    return item;
  };
  for (const event of events) {
    if (!event.objectId || !['artifact_generated', 'artifact_attached', 'web_published', 'artifact_open'].includes(event.event)) continue;
    if (event.event === 'artifact_open') {
      if (event.actorKind !== 'human') continue;
      const id = root(event.objectId); clicked.add(id);
      const item = objects.get(id);
      if (item && item.providedAt !== null && event.timestamp >= item.providedAt) item.opened = true;
      continue;
    }
    const item = object(event);
    if (event.event === 'artifact_generated' || (event.event === 'web_published' && event.operation === 'create')) {
      item.createdAt ??= event.timestamp;
    }
    if (event.event === 'artifact_attached' || event.event === 'web_published') item.providedAt ??= event.timestamp;
    if (event.event === 'web_published' && event.operation === 'update') item.updates++;
  }
  const kinds = new Map(); let provided = 0, opened = 0;
  for (const item of objects.values()) {
    if (!kinds.has(item.kind)) kinds.set(item.kind, { kind: item.kind, created: ['web', 'image'].includes(item.kind) ? 0 : null,
      updates: item.kind === 'web' ? 0 : null, provided: 0, opened: 0 });
    const row = kinds.get(item.kind);
    if (item.createdAt !== null && row.created !== null) row.created++;
    if (row.updates !== null) row.updates += item.updates;
    if (item.providedAt !== null) { row.provided++; provided++; }
    if (item.opened) { row.opened++; opened++; }
  }
  const webClicks = events.some(event => event.actorKind === 'human' && ['artifact_open', 'page_enter', 'session_open'].includes(event.event));
  return { byKind: [...kinds.values()], provided, opened: fraction(opened, provided, reliable && webClicks),
    otherOpened: [...clicked].filter(id => !objects.has(id) || objects.get(id).providedAt === null).length };
}
