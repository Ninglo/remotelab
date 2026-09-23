const PHASES = new Set(['attention', 'incident', 'upcoming', 'result', 'progress', 'note']);
const EVIDENCE = new Set(['confirmed', 'source_reported']);
const URGENCY = new Set(['high', 'normal', 'low']);
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

function fail(message) {
  throw Object.assign(new TypeError(message), { status: 400 });
}

function shortText(value, name, max, required = true) {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${name} must not contain control characters`);
  const text = value.trim();
  if ((required && !text) || Array.from(text).length > max) {
    fail(`${name} must contain 1–${max} printable characters`);
  }
  return text;
}

function dateMs(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) fail(`${name} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${name} must be an ISO timestamp`);
  return parsed;
}

export function validateSourcePacket(input, nowMs = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('source packet must be an object');
  if (input.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) fail('sequence must be a non-negative safe integer');
  const label = shortText(input.label, 'label', 36);
  const observedAtMs = dateMs(input.observedAt, 'observedAt');
  const validUntilMs = dateMs(input.validUntil, 'validUntil');
  if (observedAtMs > nowMs + 5 * 60_000 || observedAtMs < nowMs - MAX_LIFETIME_MS) fail('observedAt is outside the allowed window');
  if (validUntilMs <= observedAtMs || validUntilMs > nowMs + MAX_LIFETIME_MS) fail('validUntil is outside the allowed window');
  if (!Array.isArray(input.signals) || input.signals.length > 8) fail('signals must be an array of at most 8 items');
  const ids = new Set();
  const signals = input.signals.map((signal, index) => {
    if (!signal || typeof signal !== 'object' || Array.isArray(signal)) fail(`signals[${index}] must be an object`);
    const id = shortText(signal.id, `signals[${index}].id`, 64);
    if (!/^[a-z][a-z0-9:_-]*$/.test(id) || ids.has(id)) fail(`signals[${index}].id must be a unique slug`);
    ids.add(id);
    if (!PHASES.has(signal.phase)) fail(`signals[${index}].phase is unsupported`);
    if (!EVIDENCE.has(signal.evidence)) fail(`signals[${index}].evidence is unsupported`);
    const urgency = signal.urgency ?? 'normal';
    if (!URGENCY.has(urgency)) fail(`signals[${index}].urgency is unsupported`);
    const occurredAtMs = dateMs(signal.occurredAt, `signals[${index}].occurredAt`);
    const expiresAtMs = dateMs(signal.expiresAt, `signals[${index}].expiresAt`);
    if (occurredAtMs > nowMs + 5 * 60_000 || occurredAtMs < nowMs - MAX_LIFETIME_MS) fail(`signals[${index}].occurredAt is outside the allowed window`);
    if (expiresAtMs <= occurredAtMs || expiresAtMs > nowMs + MAX_LIFETIME_MS) fail(`signals[${index}].expiresAt is outside the allowed window`);
    let dueAt;
    if (signal.phase === 'upcoming') {
      dateMs(signal.dueAt, `signals[${index}].dueAt`);
      dueAt = signal.dueAt;
    }
    return {
      id, phase: signal.phase, urgency,
      title: shortText(signal.title, `signals[${index}].title`, 32),
      summary: shortText(signal.summary, `signals[${index}].summary`, 96),
      subject: shortText(signal.subject, `signals[${index}].subject`, 36),
      destination: shortText(signal.destination, `signals[${index}].destination`, 40),
      occurredAt: signal.occurredAt, expiresAt: signal.expiresAt,
      evidence: signal.evidence,
      ...(dueAt ? { dueAt } : {}),
    };
  });
  return { schemaVersion: 1, sequence: input.sequence, label, observedAt: input.observedAt, validUntil: input.validUntil, signals };
}

export function emptySignalStore() {
  return { schemaVersion: 1, people: {} };
}

export function replaceSource(store, personId, sourceId, input, nowMs = Date.now()) {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(sourceId)) fail('sourceId must be a stable slug');
  const packet = validateSourcePacket(input, nowMs);
  const currentSources = store.people?.[personId] || {};
  const previous = currentSources[sourceId];
  if (!previous && Object.keys(currentSources).length >= 16) fail('a Person may have at most 16 display sources');
  if (previous && packet.sequence < previous.sequence) return { store, changed: false, reason: 'older_sequence' };
  if (previous && packet.sequence === previous.sequence) {
    if (JSON.stringify(previous) !== JSON.stringify(packet)) {
      throw Object.assign(new Error('sequence already used for different content'), { status: 409 });
    }
    return { store, changed: false, reason: 'duplicate' };
  }
  return {
    store: {
      schemaVersion: 1,
      people: { ...store.people, [personId]: { ...currentSources, [sourceId]: packet } },
    },
    changed: true,
    reason: 'updated',
  };
}

export function makeStatusSnapshot(sourcePackets, nowMs = Date.now()) {
  const sources = [];
  const signals = [];
  for (const [sourceId, packet] of Object.entries(sourcePackets || {})) {
    const fresh = Date.parse(packet.validUntil) > nowMs;
    sources.push({ id: sourceId, label: packet.label, observedAt: packet.observedAt, validUntil: packet.validUntil, fresh });
    for (const signal of packet.signals) {
      signals.push({ ...signal, sourceId, sourceLabel: packet.label, active: fresh && Date.parse(signal.expiresAt) > nowMs });
    }
  }
  return { schemaVersion: 1, generatedAt: new Date(nowMs).toISOString(), sources, signals };
}

const RANK = { attention: 0, incident: 1, upcoming: 2, result: 3, progress: 4, note: 5 };
export function selectOfficialScene(snapshot, nowMs = Date.now()) {
  const eligible = snapshot.signals.filter((item) => item.active && (
    item.phase !== 'upcoming' || (Date.parse(item.dueAt) >= nowMs - 5 * 60_000 && Date.parse(item.dueAt) <= nowMs + 60 * 60_000)
  ));
  eligible.sort((a, b) => {
    const phase = RANK[a.phase] - RANK[b.phase];
    if (phase) return phase;
    const urgency = { high: 0, normal: 1, low: 2 }[a.urgency] - { high: 0, normal: 1, low: 2 }[b.urgency];
    if (urgency) return urgency;
    return Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
  });
  if (eligible.length) return { kind: eligible[0].phase, signal: eligible[0], otherCount: eligible.length - 1 };
  if (snapshot.sources.some((source) => !source.fresh)) return { kind: 'stale', otherCount: 0 };
  if (!snapshot.sources.length) return { kind: 'unconfigured', otherCount: 0 };
  return { kind: 'quiet', otherCount: 0 };
}
