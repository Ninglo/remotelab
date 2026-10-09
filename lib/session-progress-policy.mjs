// Old delivery commands/receipts remain aliases; the current choices only
// control whether the work path starts expanded inside its existing card.
export const FEISHU_PROGRESS_MODES = new Set(['expanded', 'collapsed', 'messages', 'card', 'default']);

// Instance-scoped rollback. Other surfaces and instances keep their current
// behavior; retained Run/card disclosure metadata is never deleted.
export function usesOctober7GroupMessaging(session) {
  return session?.feishuGroupMessagingBaseline === '2026-10-07'
    || process.env.REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE === '2026-10-07'
      && session?.conversation?.connector === 'feishu'
      && session.conversation.target?.chatType === 'group';
}

export function normalizeProgressMode(mode) {
  return mode === 'expanded' || mode === 'messages' ? 'expanded' : 'collapsed';
}

export function progressPolicyForRun(session, runId = session?.feishuProgressRunId) {
  if (usesOctober7GroupMessaging(session)) return {
    feishuGroupMessagingBaseline: '2026-10-07',
    feishuProgressMode: session.feishuProgressMode,
    feishuProgressAfterSeq: session.feishuProgressAfterSeq || 0,
    feishuProgressRevision: session.feishuProgressRevision || 0,
  };
  const policy = session?.feishuProgressRuns?.[runId];
  return {
    feishuProgressMode: normalizeProgressMode(policy?.mode || (session?.feishuProgressRuns && runId ? undefined : session?.feishuProgressMode)),
    feishuProgressAfterSeq: policy?.afterSeq ?? (session?.feishuProgressRuns && runId ? 0 : session?.feishuProgressAfterSeq || 0),
    feishuProgressRevision: session?.feishuProgressRevision || 0,
    ...(runId ? { feishuProgressRunId: runId } : {}),
    ...(policy ? { feishuProgressAutomatic: !policy.manual } : {}),
  };
}

export function sessionProgressMode(session, runId) {
  if (usesOctober7GroupMessaging(session)) return session?.feishuProgressMode === 'card' ? 'card' : 'messages';
  return session?.feishuProgressRuns ? progressPolicyForRun(session, runId).feishuProgressMode
    : normalizeProgressMode(session?.feishuProgressMode);
}

// A display choice belongs to one shared card, not a Person or a Run. Resuming
// that task keeps its anchor; another task starts collapsed again.
export function progressPolicyForCard(session, anchorSeq, runId) {
  const card = session?.feishuProgressCards?.[anchorSeq];
  const run = session?.feishuProgressRuns?.[runId];
  return { mode: card?.mode || (run?.manual ? normalizeProgressMode(run.mode) : 'collapsed'),
    revision: card?.revision || 0 };
}

export function describeSessionProgressPolicy(session) {
  if (usesOctober7GroupMessaging(session)) return `进展提示：${sessionProgressMode(session) === 'card'
    ? '只更新卡片' : '新进展发消息'}${!session?.feishuProgressMode ? '（全局默认）' : ''}`;
  const policy = session?.feishuProgressRuns ? progressPolicyForRun(session) : session;
  const source = policy?.feishuProgressAutomatic === true ? '（按本次任务选择）'
    : policy?.feishuProgressAutomatic === false ? '（本轮手动选择）' : '（默认设置）';
  return `工作过程：${sessionProgressMode(policy) === 'expanded' ? '默认展开' : '默认折叠'}${source}`;
}

export function shouldPublishSessionProgress(session, seq, _runId, messageReplyPolicy) {
  if (messageReplyPolicy?.version === 1) return messageReplyPolicy.progress === 'messages';
  if (usesOctober7GroupMessaging(session)) return sessionProgressMode(session) === 'messages'
    && seq > (session?.feishuProgressAfterSeq || 0);
  // Ordinary Feishu progress stays in the task card or Web/history. Unlisted
  // work has one final reply; questions and exceptional notices stay separate.
  return false;
}
