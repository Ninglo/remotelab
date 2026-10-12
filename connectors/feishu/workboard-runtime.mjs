const trim = value => typeof value === 'string' ? value.trim() : '';

// The old worker is stopped before this migration. Move known card receipts,
// including uncertain creates and acknowledgement fences; never replay a send.
export function upgradeFeishuWorkboardState(previous = {}, { sourceRouteId, botConfigPath } = {}) {
  if (!trim(sourceRouteId) || !trim(botConfigPath)) throw new Error('Workboard route and Bot config are required');
  if (previous.sourceRouteId && previous.sourceRouteId !== sourceRouteId) throw new Error('Workboard route cannot change');
  if (previous.scope === 'instance') return { ...structuredClone(previous), botConfigPath };
  const sessions = structuredClone(previous.groupSessions || {});
  if (previous.sessionId) {
    if (sessions[previous.sessionId]) throw new Error('Private and group workboard state overlap');
    sessions[previous.sessionId] = { chatId: previous.chatId, cards: structuredClone(previous.cards || []),
      startedAfterSeq: previous.startedAfterSeq || 0, protocolAfterSeq: previous.protocolAfterSeq || 0 };
  }
  return { scope: 'instance', sourceRouteId, botConfigPath, protocolVersion: 2, sessions,
    ...(previous.senderOpenId ? { legacySenderOpenId: previous.senderOpenId } : {}) };
}

// Fail closed when an earlier standalone worker or connector still owns state.
// PID reuse may require operator inspection; it must never authorize a second writer.
export function assertWorkboardOwnerStopped(state) {
  const pid = state?.runtime?.pid;
  if (!pid || pid === process.pid) return;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; }
  throw new Error(`Card state still owned by pid ${pid}; retire the old writer before starting this connector`);
}
