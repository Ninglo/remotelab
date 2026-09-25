function time(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Feishu sessions only cover conversations that entered RemoteLab through its
// connector. This is not a Feishu account's full notification inbox.
export function summarizeFeishuSessions(sessions, identityIds, linked, nowMs = Date.now()) {
  const owned = sessions.filter((session) => identityIds.has(session?.initiatedByIdentityId)
    && session?.conversation?.connector === 'feishu');
  const latestInboundAt = Math.max(0, ...owned.map((session) => time(session.lastUserMessageAt)));
  return {
    scope: 'remotelab_bot_conversations',
    linked,
    conversations: owned.length,
    recentConversations: owned.filter((session) => time(session.lastUserMessageAt) >= nowMs - 24 * 60 * 60 * 1000).length,
    latestInboundAt: latestInboundAt ? new Date(latestInboundAt).toISOString() : null,
  };
}

export function summarizeAutomationTasks(tasks, identityIds, nowMs = Date.now()) {
  const owned = tasks.filter((task) => identityIds.has(task?.createdByIdentityId));
  const active = owned.filter((task) => task.enabled === true && ['active', 'scheduled', 'starting', 'running'].includes(task.state));
  const next = active.map((task) => time(task.nextRunAt)).filter((value) => value > nowMs).sort((a, b) => a - b)[0];
  const failures24h = owned.filter((task) => task.lastExecution?.state === 'failed'
    && time(task.lastExecution.completedAt || task.lastExecution.attemptedAt) >= nowMs - 24 * 60 * 60 * 1000).length;
  return {
    available: true,
    configured: owned.length,
    active: active.length,
    failures24h,
    nextRunAt: next ? new Date(next).toISOString() : null,
  };
}
