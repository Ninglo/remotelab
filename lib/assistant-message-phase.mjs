export function isFinalAssistantMessage(event) {
  return event?.type === 'message' && event.role === 'assistant'
    && ['final', 'final_answer'].includes(event.phase);
}

export function isWorkboardMessage(event) {
  return event?.type === 'message' && event.role === 'assistant'
    && (event.source === 'workboard_checklist' || event.messageKind === 'todo_list');
}

export function isReplyMessage(event) {
  return event?.type === 'message' && event.role === 'assistant'
    && event.phase !== 'commentary' && !isWorkboardMessage(event);
}
