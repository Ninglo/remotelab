import { FEISHU_PROGRESS_MODES, progressPolicyForRun, normalizeProgressMode } from '../lib/session-progress-policy.mjs';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { findSessionMeta, mutateSessionMeta } from './session-meta-store.mjs';
import { broadcastAll } from './ws-clients.mjs';
import { getRun } from './runs.mjs';
import { loadHistory } from './history.mjs';
import { projectWorkboards } from '../lib/workboard-state.mjs';

// Policy changes and progress outbox admissions share one lock. A notification
// already admitted before a switch may finish; later observations read the new policy.
export const withSessionProgressPolicy = createKeyedTaskQueue();

function invalid(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function requirePolicyRun(id, runId) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(runId)
      || (await getRun(runId))?.sessionId !== id) invalid('无法确认本轮任务，请查看最新卡片。');
}

// The executing Harness chooses from the actual task; no extra model is called.
// A person's explicit click wins for this Run, and never becomes a user habit.
export async function chooseRunProgressPolicy(id, runId, mode) {
  if (!['expanded', 'collapsed'].includes(mode)) invalid('进展展开状态应为 expanded 或 collapsed。');
  await requirePolicyRun(id, runId);
  return withSessionProgressPolicy(id, async () => {
    const current = await findSessionMeta(id);
    if (!current) invalid('会话不存在。', 404);
    if (current.conversation?.connector !== 'feishu') invalid('此设置仅用于飞书会话。');
    if (current.workboardPilot !== true) invalid('当前会话未启用进展卡片，请继续使用新消息提示。');
    const prior = current.feishuProgressRuns?.[runId];
    if (prior?.manual || prior?.mode === mode) return progressPolicyForRun(current, runId);
    const previous = progressPolicyForRun(current, runId);
    const result = await mutateSessionMeta(id, session => {
      session.feishuProgressRuns = { ...session.feishuProgressRuns,
        [runId]: { mode, manual: false,
          afterSeq: previous.feishuProgressAfterSeq } };
      session.feishuProgressRunId = runId;
      session.feishuProgressRevision = (session.feishuProgressRevision || 0) + 1;
      session.updatedAt = new Date().toISOString();
      return true;
    });
    if (result.changed) broadcastAll({ type: 'session_invalidated', sessionId: id });
    return progressPolicyForRun(result.meta, runId);
  });
}

export async function updateSessionProgressPolicy(id, { mode, expectedRevision, changeId, runId } = {}) {
  if (!FEISHU_PROGRESS_MODES.has(mode)) invalid('进展展开状态应为 expanded 或 collapsed。');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) invalid('请先读取当前进展策略版本。');
  if (typeof changeId !== 'string' || !changeId.trim() || changeId.length > 200) invalid('缺少有效的进展策略操作编号。');
  return withSessionProgressPolicy(id, async () => {
    const current = await findSessionMeta(id);
    if (!current) invalid('会话不存在。', 404);
    if (current.conversation?.connector !== 'feishu') invalid('此设置仅用于飞书会话。');
    if (current.workboardPilot !== true) invalid('当前会话未启用进展卡片，请继续使用新消息提示。');
    const policyRunId = runId || current.activeRunId || current.feishuProgressRunId;
    if (policyRunId) await requirePolicyRun(id, policyRunId);
    if (current.feishuProgressChanges?.includes(changeId)) return current;
    if ((current.feishuProgressRevision || 0) !== expectedRevision) invalid('策略已被其他操作更新，请查看最新卡片或输入 /progress 后重试。', 409);
    const nextMode = mode === 'default' ? undefined : mode;
    const result = await mutateSessionMeta(id, session => {
      if (session.feishuProgressChanges?.includes(changeId)) return false;
      if ((session.feishuProgressRevision || 0) !== expectedRevision) invalid('策略已更新，请查看最新卡片后重试。', 409);
      if (policyRunId) {
        const prior = progressPolicyForRun(session, policyRunId);
        const next = normalizeProgressMode(mode);
        session.feishuProgressRuns = { ...session.feishuProgressRuns,
          [policyRunId]: { mode: next, manual: true,
            afterSeq: prior.feishuProgressAfterSeq } };
        session.feishuProgressRunId = policyRunId;
        session.feishuProgressRevision = expectedRevision + 1;
      } else if (session.feishuProgressMode !== nextMode) {
        if (nextMode) session.feishuProgressMode = nextMode;
        else delete session.feishuProgressMode;
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

export async function updateProgressCardDisclosure(id, { anchorSeq, mode, changeId, actorOpenId } = {}) {
  if (!Number.isSafeInteger(anchorSeq) || anchorSeq < 1 || !['expanded', 'collapsed'].includes(mode))
    invalid('无效的进展卡片操作。');
  if (typeof changeId !== 'string' || !changeId.trim() || changeId.length > 200
      || typeof actorOpenId !== 'string' || !actorOpenId.trim() || actorOpenId.length > 200)
    invalid('缺少有效的卡片操作来源。');
  return withSessionProgressPolicy(id, async () => {
    const current = await findSessionMeta(id);
    if (!current) invalid('会话不存在。', 404);
    if (current.conversation?.connector !== 'feishu' || current.workboardPilot !== true)
      invalid('此操作仅用于已启用的飞书任务卡片。');
    if (!projectWorkboards(await loadHistory(id)).some(task => task.anchorSeq === anchorSeq))
      invalid('无法确认这张任务卡片，请查看原话题。');
    const result = await mutateSessionMeta(id, session => {
      const prior = session.feishuProgressCards?.[anchorSeq];
      // Retried older callbacks never undo a more recent click. Each new
      // absolute show/hide intent wins in acceptance order, even from a stale
      // client snapshot; no automatic progress update writes this field.
      if (prior?.changes?.includes(changeId)) return false;
      session.feishuProgressCards = { ...session.feishuProgressCards, [anchorSeq]: {
        mode, revision: (prior?.revision || 0) + 1, actorOpenId,
        changes: [...(prior?.changes || []), changeId].slice(-100),
      } };
      session.updatedAt = new Date().toISOString();
      return true;
    });
    if (result.changed) broadcastAll({ type: 'session_invalidated', sessionId: id,
      progressCard: { anchorSeq, ...progressPolicyForCardHint(result.meta, anchorSeq),
        sourceRouteId: result.meta.conversation.sourceRouteId,
        chatId: result.meta.conversation.target.chatId } });
    return result.meta;
  });
}

function progressPolicyForCardHint(session, anchorSeq) {
  const { mode, revision } = session.feishuProgressCards[anchorSeq];
  return { mode, revision };
}
