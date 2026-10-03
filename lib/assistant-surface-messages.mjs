import { isFinalAssistantMessage, isWorkboardMessage } from './assistant-message-phase.mjs';
import { stripHiddenBlocks } from './reply-selection.mjs';

// Control tags in Markdown examples are literal text, not publication requests.
function maskCode(text) {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(`+)[^\n]*?\1/g,
    match => match.replace(/[^\n]/g, ' '));
}

export function parseProgressMessage(content) {
  const text = stripHiddenBlocks(content);
  const masked = maskCode(text);
  const blocks = [...masked.matchAll(/<progress>([\s\S]*?)<\/progress>/gi)];
  const progress = blocks.map(match => text.slice(match.index + 10, match.index + match[0].length - 11).trim())
    .filter(Boolean).join('\n\n');
  let unwrapped = text;
  for (const match of [...blocks].reverse()) {
    unwrapped = unwrapped.slice(0, match.index)
      + text.slice(match.index + 10, match.index + match[0].length - 11)
      + unwrapped.slice(match.index + match[0].length);
  }
  return { progress, text: unwrapped.trim() };
}

// A projection only: callers retain the original event in durable history.
// Phase-less adapters get an opening only before their first tool starts;
// their final answer remains the existing terminal-publication fallback.
export function collectAssistantSurfaceMessages(events = [], { includeProgress = true, completed = false } = {}) {
  const messages = new Map();
  const lastMessage = completed ? [...events].reverse().find(event => event?.type === 'message'
    && event.role === 'assistant' && !event.phase && !isWorkboardMessage(event)
    && event.messageKind !== 'execution_plan' && event.source !== 'result_file_assets') : null;
  const legacyFinal = lastMessage && !events.slice(events.indexOf(lastMessage) + 1)
    .some(event => ['tool_use', 'tool_result', 'reasoning', 'file_change', 'manager_context'].includes(event?.type))
    ? lastMessage : null;
  let firstMessageSeen = false;
  let workStarted = false;
  let workboardStarted = false;
  for (const event of events) {
    if (event?.type === 'message' && event.role === 'user') {
      firstMessageSeen = false;
      workStarted = false;
      workboardStarted = false;
      continue;
    }
    if (event?.source === 'workboard_checklist') workboardStarted = true;
    if (['tool_use', 'tool_result', 'file_change'].includes(event?.type)) workStarted = true;
    if (event?.type !== 'message' || event.role !== 'assistant'
        || isWorkboardMessage(event) || ['execution_plan', 'workboard_progress', 'session_delegate_notice'].includes(event.messageKind)
        || event.source === 'result_file_assets') continue;
    const parsed = parseProgressMessage(event.content);
    if (isFinalAssistantMessage(event) || event === legacyFinal) {
      messages.set(event, { ...event, content: parsed.text, surfaceKind: 'final' });
      firstMessageSeen = true;
      continue;
    }
    if (!parsed.text) continue;
    const legacyOpening = !workStarted && !/^\s*Artifacts:\s*$/mi.test(event.content || '')
      && !event.attachments?.length && !event.images?.length;
    const opening = !firstMessageSeen && !workboardStarted && (event.phase === 'commentary' || legacyOpening);
    firstMessageSeen = true;
    if (!includeProgress || (!opening && !parsed.progress && event.messageKind !== 'user_question')) continue;
    messages.set(event, {
      ...event,
      content: parsed.progress || parsed.text,
      surfaceKind: opening ? 'opening' : 'progress',
    });
  }
  return messages;
}

export function assistantSurfaceMessageId(event) {
  if (event?.providerMessageId) return event.providerMessageId;
  return Number.isInteger(event?.seq) ? `event:${event.seq}` : '';
}
