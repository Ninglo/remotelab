import { progressPolicyForRun } from '../lib/session-progress-policy.mjs';

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function stripSessionShape(session, {
  includeQueuedMessages = false,
} = {}) {
  if (!session || typeof session !== 'object') return null;
  const cloned = cloneJson(session);
  delete cloned.task;
  delete cloned.sourceContext;
  delete cloned.delegatedFromSessionId;
  delete cloned.delegatedAt;
  delete cloned.titleLocked;
  delete cloned.feishuProgressChanges;
  if (cloned.feishuProgressCards) cloned.feishuProgressCards = Object.fromEntries(
    Object.entries(cloned.feishuProgressCards).map(([anchor, { mode, revision, page }]) =>
      [anchor, { mode, revision, ...(page != null ? { page } : {}) }]));
  if (cloned.feishuProgressRuns) Object.assign(cloned, progressPolicyForRun(cloned, cloned.activeRunId || cloned.feishuProgressRunId));
  if (!includeQueuedMessages) {
    if (Array.isArray(cloned.workAwareness?.works)) cloned.workAwareness = { revision: cloned.workAwareness.revision,
      activeCount: cloned.workAwareness.works.filter(work => work.status === 'active').length };
    delete cloned.queuedMessages;
    delete cloned.deliveryIssues;
  }
  return cloned;
}

export function createSessionListItem(session) {
  return stripSessionShape(session, { includeQueuedMessages: false });
}

export function createSessionDetail(session) {
  return stripSessionShape(session, { includeQueuedMessages: true });
}
