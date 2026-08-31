import { buildSessionDisplayEvents } from './session-display-events.mjs';
import { prepareSessionContinuationBody } from './session-continuation.mjs';

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function clipText(value, maxChars = 5000) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[... truncated by RemoteLab ...]\n${text.slice(-tailChars).trimStart()}`;
}

function formatDisplayedAssistantEvent(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'message' && event.role === 'assistant') {
    return normalizeText(event.content || '');
  }
  if (event.type === 'attachment_delivery') {
    const names = (Array.isArray(event.attachments) ? event.attachments : [])
      .map((attachment) => typeof attachment?.originalName === 'string' ? attachment.originalName.trim() : '')
      .filter(Boolean);
    return names.length > 0
      ? `[Displayed attachment delivery: ${names.join(', ')}]`
      : '[Displayed attachment delivery]';
  }
  return '';
}

function buildDisplayedAssistantTurn(history = []) {
  return buildSessionDisplayEvents(history, { sessionRunning: false })
    .filter((event) => !(event?.type === 'message' && event.role === 'user'))
    .map(formatDisplayedAssistantEvent)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function buildPriorContext(history = [], beforeSeq = 0) {
  if (!Number.isInteger(beforeSeq) || beforeSeq < 1) return '';
  const priorHistory = history.filter((event) => !Number.isInteger(event?.seq) || event.seq < beforeSeq);
  return priorHistory.length > 0
    ? clipText(prepareSessionContinuationBody(priorHistory), 6000)
    : '';
}

function belongsToRun(event, runId = '') {
  if (!runId) return true;
  if (event?.runId === runId) return true;
  return event?.source === 'result_file_assets' && event?.resultRunId === runId;
}

export async function loadCompletedTurnContext(sessionId, runId, { loadSessionHistory } = {}) {
  if (typeof loadSessionHistory !== 'function') {
    throw new TypeError('loadCompletedTurnContext requires loadSessionHistory');
  }

  const history = await loadSessionHistory(sessionId, { includeBodies: true });
  const runHistory = [];
  let userMessage = null;
  let latestAssistantMessage = null;

  for (const event of history) {
    if (!belongsToRun(event, runId)) continue;
    runHistory.push(event);
    if (event?.type === 'message' && event.role === 'user') {
      userMessage = event;
    } else if (event?.type === 'message' && event.role === 'assistant') {
      latestAssistantMessage = event;
    }
  }

  const turnHistory = Number.isInteger(userMessage?.seq)
    ? runHistory.filter((event) => !Number.isInteger(event?.seq) || event.seq >= userMessage.seq)
    : runHistory;

  return {
    priorContextText: buildPriorContext(history, userMessage?.seq),
    userMessage,
    assistantTurnText: buildDisplayedAssistantTurn(turnHistory)
      || normalizeText(latestAssistantMessage?.content || ''),
  };
}
