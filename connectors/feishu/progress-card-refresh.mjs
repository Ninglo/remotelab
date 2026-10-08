// Only the route worker writes provider cards and their durable receipts.
// A disclosure hint can repaint its last acknowledged snapshot immediately,
// without rereading Session history or replaying unrelated task checkpoints.
export function createProgressCardRefresh(pilot) {
  const snapshots = new Map();
  const choices = new Map();
  const pending = new Map();
  const keyFor = (sessionId, anchorSeq) => `${sessionId}:${anchorSeq}`;
  const storedFor = sessionId => pilot.scope === 'instance' ? pilot.sessions?.[sessionId]
    : sessionId === pilot.sessionId ? pilot : pilot.groupSessions?.[sessionId];

  function apply(cycle) {
    const key = keyFor(cycle.sessionId, cycle.anchorSeq);
    const hinted = choices.get(key);
    const acknowledged = snapshots.get(key)?.cardDisclosure;
    const choice = (acknowledged?.revision || 0) > (hinted?.revision || 0) ? acknowledged : hinted;
    return choice && choice.revision >= (cycle.cardDisclosure?.revision || 0)
      ? { ...cycle, cardDisclosure: { mode: choice.mode, revision: choice.revision } } : cycle;
  }

  function remember(cycle) {
    const card = storedFor(cycle.sessionId)?.cards?.find(item => item.anchorSeq === cycle.anchorSeq);
    if (!card?.messageId || card.latestSeq !== cycle.latestSeq) return;
    const key = keyFor(cycle.sessionId, cycle.anchorSeq);
    const prior = snapshots.get(key);
    if (prior && prior.latestSeq > cycle.latestSeq) return;
    // Store only the existing card's display material, not raw Session events
    // or its checkpoint replay list. The renderer shows the last ten entries.
    const { updates, ...snapshot } = apply(cycle);
    snapshots.set(key, { ...snapshot, progressHistory: (snapshot.progressHistory || [])
      .filter(progress => progress.seq <= snapshot.latestSeq).slice(-10) });
  }

  function accept(message) {
    const choice = message.progressCard;
    if (message.type !== 'session_invalidated' || typeof message.sessionId !== 'string'
        || !Number.isSafeInteger(choice?.anchorSeq) || choice.anchorSeq < 1
        || !Number.isSafeInteger(choice.revision) || choice.revision < 1
        || !['expanded', 'collapsed'].includes(choice.mode)
        || choice.sourceRouteId !== pilot.sourceRouteId) return false;
    const stored = storedFor(message.sessionId);
    if (stored?.chatId !== choice.chatId || !stored?.cards?.some(card =>
      card.anchorSeq === choice.anchorSeq && card.messageId)) return false;
    const key = keyFor(message.sessionId, choice.anchorSeq);
    const knownRevision = Math.max(choices.get(key)?.revision || 0, snapshots.get(key)?.cardDisclosure?.revision || 0);
    if (knownRevision >= choice.revision) return true;
    choices.set(key, choice);
    pending.set(key, { sessionId: message.sessionId, anchorSeq: choice.anchorSeq, receivedAt: Date.now() });
    return true;
  }

  function take() {
    const key = pending.keys().next().value;
    if (!key) return null;
    const change = pending.get(key);
    pending.delete(key);
    const snapshot = snapshots.get(key);
    return { ...change, cycle: snapshot ? apply(snapshot) : null };
  }
  return { apply, remember, accept, take, get size() { return pending.size; } };
}
