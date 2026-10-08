export const FEISHU_PROGRESS_MODES = new Set(['messages', 'card', 'default']);

export function sessionProgressMode(session) {
  if (session?.workboardPilot === false) return 'messages';
  const mode = session?.feishuProgressMode || session?.feishuProgressDefault?.mode;
  return mode === 'card' ? 'card' : 'messages';
}

// A task's admission snapshot belongs to its actual author, not the Session creator
// or the last person to submit another task in the shared conversation.
export function progressPolicyForTask(session, input = {}) {
  return { ...session, feishuProgressDefault: input.feishuProgressDefault || null };
}

export function describeSessionProgressPolicy(session) {
  const mode = sessionProgressMode(session);
  const source = session?.feishuProgressMode ? '会话明确选择'
    : session?.feishuProgressDefault?.mode ? '本任务发起人的个人默认' : '全局默认';
  return `进展提示：${mode === 'card' ? '只更新卡片' : '卡片＋新消息'}（${source}）`;
}

export function shouldPublishSessionProgress(session, seq) {
  return sessionProgressMode(session) === 'messages'
    && seq > (session?.feishuProgressAfterSeq || 0);
}
