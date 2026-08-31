import { loadHistory } from './history.mjs';
import { parseWorkSummaryFromAssistantContent } from './session-work-summary.mjs';

export async function findLatestAssistantMessageForRun(sessionId, runId) {
  const events = await loadHistory(sessionId, { includeBodies: true });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'message' || event.role !== 'assistant') continue;
    if (runId && event.runId !== runId) continue;
    return event;
  }
  return null;
}

export async function maybeApplyAssistantWorkSummary(sessionId, runId, session = null, services = {}) {
  const currentSession = session || await services.getSession(sessionId);
  if (!currentSession || !services.isWorkSummaryEnabledForSession(currentSession)) {
    return null;
  }

  const assistantEvent = await findLatestAssistantMessageForRun(sessionId, runId);
  const workSummary = parseWorkSummaryFromAssistantContent(assistantEvent?.content || '');
  if (!workSummary) return null;

  return services.updateSessionWorkSummary(sessionId, workSummary);
}
