export const FEISHU_PROGRESS_MODES = new Set(['messages', 'card', 'default']);

export function sessionProgressMode(session) {
  return session?.feishuProgressMode === 'card' ? 'card' : 'messages';
}

export function describeSessionProgressPolicy(session) {
  const mode = sessionProgressMode(session);
  const inherited = !session?.feishuProgressMode;
  return `进展提示：${mode === 'card' ? '只更新卡片' : '新进展发消息'}${inherited ? '（全局默认）' : ''}`;
}

export function shouldPublishSessionProgress(session, seq) {
  return sessionProgressMode(session) === 'messages'
    && seq > (session?.feishuProgressAfterSeq || 0);
}
