// Scope follows explicit project/group bindings and recorded delegation only.
export function projectDirectoryScope(config, session, sourceContext, sessions = [], byId = new Map(sessions.map(s => [s.id, s]))) {
  const seen = new Set();
  let current = session, input = sourceContext;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const origin = input?.connector === 'feishu' ? input : current.conversation;
    const chatId = origin?.chatId || origin?.target?.chatId;
    const group = config.groups.find(g => g.sourceRouteId === origin?.sourceRouteId && g.chatId === chatId);
    if (group) return { projectIds: group.projectIds, viaSessionId: current.id };
    // An explicit, unregistered external input cannot inherit another group's scope.
    if (input?.connector === 'feishu') return { projectIds: [] };
    const declared = config.sessionBindings.find(s => s.sessionId === current.id);
    if (declared) return { projectIds: declared.projectIds, viaSessionId: current.id };
    current = byId.get(current.delegatedFromSessionId);
    input = null;
  }
  return { projectIds: [] };
}

// Explicit directory-only groups do not assert project ownership or share briefs.
export function groupDirectoryScope(config, session, sourceContext, sessions = [], byId = new Map(sessions.map(s => [s.id, s]))) {
  const seen = new Set();
  let current = session, input = sourceContext;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const origin = input?.connector === 'feishu' ? input : current.conversation;
    const chatId = origin?.chatId || origin?.target?.chatId;
    if (chatId) return (config.directoryGroups || []).find(g => g.sourceRouteId === origin?.sourceRouteId
      && g.chatIds.includes(chatId)) || null;
    if (input?.connector === 'feishu' || config.sessionBindings.some(b => b.sessionId === current.id)) return null;
    current = byId.get(current.delegatedFromSessionId);
    input = null;
  }
  return null;
}
