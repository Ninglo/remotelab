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

export function buildFeishuWorkboardService({ node, projectRoot, statePath, configDir, sourceFreezePath }) {
  for (const value of [node, projectRoot, statePath, configDir, ...(sourceFreezePath ? [sourceFreezePath] : [])]) {
    if (typeof value !== 'string' || !value.startsWith('/') || /[\r\n\0]/.test(value)) throw new Error('Service paths must be absolute');
  }
  const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
  return `[Unit]\nDescription=RemoteLab instance Feishu task cards\nAfter=network-online.target\n${sourceFreezePath ? `ConditionPathExists=!${quote(sourceFreezePath)}\n` : ''}StartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${quote(projectRoot)}\nEnvironment=${quote(`REMOTELAB_CONFIG_DIR=${configDir}`)}\nExecStart=${quote(node)} ${quote(`${projectRoot}/scripts/feishu-workboard-pilot.mjs`)} ${quote(statePath)}\nRestart=on-failure\nRestartSec=2\nRuntimeMaxSec=infinity\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
