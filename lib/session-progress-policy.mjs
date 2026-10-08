// Old delivery commands/receipts remain aliases; the current choices only
// control whether the work path starts expanded inside its existing card.
export const FEISHU_PROGRESS_MODES = new Set(['expanded', 'collapsed', 'messages', 'card', 'default']);

export function normalizeProgressMode(mode) {
  return mode === 'expanded' || mode === 'messages' ? 'expanded' : 'collapsed';
}

export function progressPolicyForRun(session, runId = session?.feishuProgressRunId) {
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
  return session?.feishuProgressRuns ? progressPolicyForRun(session, runId).feishuProgressMode
    : normalizeProgressMode(session?.feishuProgressMode);
}

export function describeSessionProgressPolicy(session) {
  const policy = session?.feishuProgressRuns ? progressPolicyForRun(session) : session;
  const source = policy?.feishuProgressAutomatic === true ? '（按本次任务选择）'
    : policy?.feishuProgressAutomatic === false ? '（本轮手动选择）' : '（默认设置）';
  return `工作过程：${sessionProgressMode(policy) === 'expanded' ? '默认展开' : '默认折叠'}${source}`;
}

export function shouldPublishSessionProgress(session, seq, runId) {
  // Both expansion states update the same card. Questions/notices/finals have
  // separate surfaces. Sessions without cards still send useful progress.
  return session?.workboardPilot !== true && seq > progressPolicyForRun(session, runId).feishuProgressAfterSeq;
}
