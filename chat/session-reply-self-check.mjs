import { buildSessionDisplayEvents } from './session-display-events.mjs';
import { prepareSessionContinuationBody } from './session-continuation.mjs';
import { extractTaggedBlock, parseJsonObjectText } from './session-text-parsing.mjs';

function normalizeReplySelfCheckText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function clipReplySelfCheckText(value, maxChars = 5000) {
  const text = normalizeReplySelfCheckText(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[... truncated by RemoteLab ...]\n${text.slice(-tailChars).trimStart()}`;
}

function formatReplySelfCheckDisplayEvent(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'message' && event.role === 'assistant') {
    return normalizeReplySelfCheckText(event.content || '');
  }
  if (event.type === 'attachment_delivery') {
    const attachments = Array.isArray(event.attachments) ? event.attachments : [];
    const names = attachments
      .map((attachment) => typeof attachment?.originalName === 'string' ? attachment.originalName.trim() : '')
      .filter(Boolean);
    if (names.length > 0) {
      return `[Displayed attachment delivery: ${names.join(', ')}]`;
    }
    return '[Displayed attachment delivery]';
  }
  if (event.type === 'thinking_block') {
    const label = normalizeReplySelfCheckText(event.label || 'Thought');
    return label ? `[Displayed thought block: ${label}]` : '[Displayed thought block]';
  }
  if (event.type === 'status') {
    const content = normalizeReplySelfCheckText(event.content || '');
    return content ? `[Displayed status: ${content}]` : '';
  }
  return '';
}

function buildReplySelfCheckDisplayedAssistantTurn(history = []) {
  const displayEvents = buildSessionDisplayEvents(history, { sessionRunning: false });
  const parts = [];
  for (const event of displayEvents) {
    if (event?.type === 'message' && event.role === 'user') continue;
    const text = formatReplySelfCheckDisplayEvent(event);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join('\n\n').trim();
}

function buildReplySelfCheckPriorContext(history = [], beforeSeq = 0) {
  if (!Number.isInteger(beforeSeq) || beforeSeq < 1) {
    return '';
  }
  const priorHistory = history.filter((event) => !Number.isInteger(event?.seq) || event.seq < beforeSeq);
  if (priorHistory.length === 0) {
    return '';
  }
  return clipReplySelfCheckText(prepareSessionContinuationBody(priorHistory), 6000);
}

function isReplySelfCheckRunEvent(event, runId = '') {
  if (!runId) return true;
  if (event?.runId === runId) return true;
  return event?.source === 'result_file_assets' && event?.resultRunId === runId;
}

export async function loadReplySelfCheckTurnContext(sessionId, runId, { loadSessionHistory } = {}) {
  if (typeof loadSessionHistory !== 'function') {
    throw new TypeError('loadReplySelfCheckTurnContext requires loadSessionHistory');
  }

  const history = await loadSessionHistory(sessionId, { includeBodies: true });
  const runHistory = [];
  let userMessage = null;
  let latestAssistantMessage = null;

  for (const event of history) {
    if (!isReplySelfCheckRunEvent(event, runId)) continue;
    runHistory.push(event);
    if (event?.type === 'message' && event.role === 'user') {
      userMessage = event;
      continue;
    }
    if (event?.type === 'message' && event.role === 'assistant') {
      latestAssistantMessage = event;
    }
  }

  const turnHistory = Number.isInteger(userMessage?.seq)
    ? runHistory.filter((event) => !Number.isInteger(event?.seq) || event.seq >= userMessage.seq)
    : runHistory;
  const assistantTurnText = buildReplySelfCheckDisplayedAssistantTurn(turnHistory)
    || normalizeReplySelfCheckText(latestAssistantMessage?.content || '');
  const priorContextText = buildReplySelfCheckPriorContext(history, userMessage?.seq);

  return {
    priorContextText,
    userMessage,
    assistantTurnText,
  };
}

export function summarizeReplySelfCheckReason(value, fallback = 'the latest reply left avoidable unfinished work') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (text.length <= 160) return text;
  return `${text.slice(0, 157).trimEnd()}…`;
}

export function extractReplySelfCheckCheckpointPolicy(systemPrompt) {
  const text = normalizeReplySelfCheckText(systemPrompt);
  if (!text) return '';
  const segments = text
    .split(/\n+|(?<=[.!?。！？；;])\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => /\bgate\b|checkpoint|review gate|approval|approve|confirm|确认|审批|审核|关口/i.test(segment));
  return clipReplySelfCheckText([...new Set(segments)].join('\n'), 4000);
}

export function buildReplySelfCheckPrompt({
  userMessage,
  assistantTurnText,
  priorContextText,
  checkpointPolicyText = '',
}) {
  return [
    'You are RemoteLab\'s hidden end-of-turn completion reviewer.',
    'Judge only whether the latest assistant reply stopped too early for the current user turn.',
    'Unless the reply clearly completed the requested work or hit a real blocker, prefer "continue".',
    'Judge branch-first: the question is not "should the assistant continue?" but "does a real logical fork or forced human checkpoint require the user right now?"',
    'When uncertain between "accept" and "continue", choose "continue".',
    'If there is no explicit user-side blocker, assume the assistant should continue with the obvious next step.',
    'Single-track work with an obvious next step must be marked "continue" when the reply only asks generic permission to proceed or frames a fake choice.',
    'Accept only when the reply already reaches a meaningful stopping point for this turn or it clearly states the exact blocker that truly requires the user.',
    'Real blockers are explicit user-side dependencies such as missing required input, genuine ambiguity that prevents safe progress, a real branch whose choice depends on user preference, missing access / credentials / files, or destructive / irreversible actions that need confirmation.',
    'A concrete review gate is also a real user checkpoint: for example, the assistant presents a proposed scope, contract, sample direction, selection criteria, budget, output standard, or external action and asks the user to confirm or change those terms before the next phase.',
    'If the applied Agent instructions define a named confirmation or review gate and the latest reply has reached that gate, choose "accept". Never override that interaction contract merely because a reasonable default exists.',
    'The confirmation round trip may itself be the behavior being tested. Do not skip it in the name of speed or autonomy.',
    'Do not treat a fabricated menu of options or a vague "pick a direction" pause as a real branch when the task still has a natural default continuation.',
    'Do not treat optional clarification, extra polish, or the assistant\'s own caution as blockers.',
    'A reply that ends with an open offer or permission request such as "if you want I can...", "I can do that next", or "let me know and I\'ll continue" is never a meaningful stopping point by itself and must be marked "continue" unless the same reply clearly states a real blocker.',
    'If the only remaining work is something the assistant could already do with the current context, you must choose "continue".',
    'Strong continue signals include: promising to do the next step later, asking permission to continue without a real blocker, offering to continue if the user wants, summarizing a plan while leaving the requested action undone, or stopping after analysis when execution was still possible.',
    'Do not require extra artifacts the user did not ask for. Conceptual discussion can already be complete when the user asked only for discussion.',
    'Return exactly one <hide> JSON object with keys "action", "reason", and "continuationPrompt".',
    'Valid actions: "accept" or "continue".',
    'If action is "accept", set continuationPrompt to an empty string.',
    'If action is "continue", continuationPrompt must tell the next assistant how to finish the missing work immediately without asking permission and without repeating the whole previous reply.',
    'Write reason and continuationPrompt in the user\'s language.',
    'Do not output any text outside the <hide> block.',
    '',
    priorContextText ? 'Relevant earlier session context before this turn:' : '',
    priorContextText ? clipReplySelfCheckText(priorContextText, 6000) : '',
    priorContextText ? '' : '',
    checkpointPolicyText ? 'Applied Agent review-gate policy:' : '',
    checkpointPolicyText ? clipReplySelfCheckText(checkpointPolicyText, 4000) : '',
    checkpointPolicyText ? '' : '',
    'Current user message:',
    clipReplySelfCheckText(userMessage?.content || '', 3000) || '[none]',
    '',
    'Latest assistant turn content shown to the user:',
    clipReplySelfCheckText(assistantTurnText || '', 5000) || '[none]',
  ].filter(Boolean).join('\n');
}

export function parseReplySelfCheckDecision(content) {
  const hidden = extractTaggedBlock(content, 'hide');
  const parsed = parseJsonObjectText(hidden || content);
  const rawAction = String(parsed?.action || '').trim().toLowerCase();
  const action = rawAction === 'accept'
    ? 'accept'
    : 'continue';
  return {
    action,
    reason: summarizeReplySelfCheckReason(parsed?.reason || ''),
    continuationPrompt: action === 'continue' ? String(parsed?.continuationPrompt || '').trim() : '',
  };
}

export function buildReplySelfRepairPrompt({ userMessage, assistantTurnText, priorContextText, reviewDecision }) {
  const continuationPrompt = String(reviewDecision?.continuationPrompt || '').trim();
  const reason = summarizeReplySelfCheckReason(reviewDecision?.reason || 'finish the missing work now');
  return [
    'You are continuing the same user-facing reply after a hidden self-check found an avoidable early stop.',
    'The previous assistant reply is already visible to the user.',
    'Add only the missing completion now.',
    'Default to taking the obvious next step with the information already available.',
    'If there is no real logical fork or forced human checkpoint, continue on the default single-track path.',
    'Prefer doing the work over describing what you would do.',
    'Replace any prior open offer or permission request with the actual next action or result now.',
    'Do not turn a single-track task into a menu of options or ask the user to choose a direction when the next step is already clear.',
    'Do not ask for permission to continue.',
    'Do not mention the hidden self-check or internal review process.',
    'Do not end with another open offer such as "if you want I can continue" or "I can do that next".',
    'Only stop if a concrete user-side blocker truly prevents safe progress.',
    'If you still truly need user input, state exactly what is missing and why it is required.',
    '',
    priorContextText ? 'Relevant earlier session context before this turn:' : '',
    priorContextText ? clipReplySelfCheckText(priorContextText, 6000) : '',
    priorContextText ? '' : '',
    'Original user message:',
    clipReplySelfCheckText(userMessage?.content || '', 3000) || '[none]',
    '',
    'Previous assistant turn content already shown to the user:',
    clipReplySelfCheckText(assistantTurnText || '', 5000) || '[none]',
    '',
    'Hidden reviewer guidance:',
    continuationPrompt || `Finish the missing work now. Reviewer reason: ${reason}`,
    '',
    'Return only the next user-visible assistant message.',
  ].filter(Boolean).join('\n');
}
