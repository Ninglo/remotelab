import { FEISHU_PROGRESS_MODES, sessionProgressMode } from '../lib/session-progress-policy.mjs';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { getHistoryHeadSeq } from './history.mjs';
import { findSessionMeta, mutateSessionMeta } from './session-meta-store.mjs';
import { broadcastAll } from './ws-clients.mjs';

// Policy changes and progress outbox admissions share one lock. A notification
// already admitted before a switch may finish; later observations read the new policy.
export const withSessionProgressPolicy = createKeyedTaskQueue();

function invalid(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export async function updateSessionProgressPolicy(id, { mode, expectedRevision, changeId } = {}) {
  if (!FEISHU_PROGRESS_MODES.has(mode)) invalid('进展策略应为 messages、card 或 default。');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) invalid('请先读取当前进展策略版本。');
  if (typeof changeId !== 'string' || !changeId.trim() || changeId.length > 200) invalid('缺少有效的进展策略操作编号。');
  return withSessionProgressPolicy(id, async () => {
    const current = await findSessionMeta(id);
    if (!current) invalid('会话不存在。', 404);
    if (current.conversation?.connector !== 'feishu') invalid('此设置仅用于飞书会话。');
    if (mode === 'card' && current.workboardPilot !== true) invalid('当前会话未启用进展卡片，请继续使用新消息提示。');
    if (current.feishuProgressChanges?.includes(changeId)) return current;
    if ((current.feishuProgressRevision || 0) !== expectedRevision) invalid('策略已被其他操作更新，请查看最新卡片或输入 /progress 后重试。', 409);
    const nextMode = mode === 'default' ? undefined : mode;
    const head = await getHistoryHeadSeq(id);
    const result = await mutateSessionMeta(id, session => {
      if (session.feishuProgressChanges?.includes(changeId)) return false;
      if ((session.feishuProgressRevision || 0) !== expectedRevision) invalid('策略已更新，请查看最新卡片后重试。', 409);
      if (session.feishuProgressMode !== nextMode) {
        const changesDelivery = sessionProgressMode(session) !== (nextMode === 'card' ? 'card' : 'messages');
        if (nextMode) session.feishuProgressMode = nextMode;
        else delete session.feishuProgressMode;
        if (changesDelivery) session.feishuProgressAfterSeq = head;
        session.feishuProgressRevision = expectedRevision + 1;
      }
      session.feishuProgressChanges = [...(session.feishuProgressChanges || []), changeId].slice(-100);
      session.updatedAt = new Date().toISOString();
      return true;
    });
    if (result.changed) broadcastAll({ type: 'session_invalidated', sessionId: id });
    return result.meta;
  });
}
