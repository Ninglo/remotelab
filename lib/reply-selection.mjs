function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function stripHiddenBlocks(text) {
  return String(text || '')
    .replace(/<private>[\s\S]*?<\/private>/gi, '')
    .replace(/<hide>[\s\S]*?<\/hide>/gi, '')
    .trim();
}

export function isChecklistOnlyMessage(text) {
  const normalized = stripHiddenBlocks(text).replace(/\r\n/g, '\n');
  if (!normalized) return false;
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => /^\[(?:x|X| )\]\s+\S/.test(line));
}

export function classifyAssistantReplyCandidate(event) {
  if (!event || event.type !== 'message' || event.role !== 'assistant') {
    return { kind: 'ignore', content: '' };
  }

  const content = stripHiddenBlocks(event.content || '');
  if (!content) {
    return { kind: 'ignore', content };
  }

  const messageKind = trimString(event.messageKind).toLowerCase();
  if (messageKind === 'todo_list') {
    return { kind: 'ignore', content };
  }

  if (isChecklistOnlyMessage(content)) {
    return { kind: 'fallback_checklist', content };
  }

  return { kind: 'select', content };
}

export async function selectAssistantReplyEvent(events = [], options = {}) {
  const match = typeof options.match === 'function' ? options.match : null;
  const hydrate = typeof options.hydrate === 'function' ? options.hydrate : null;
  let checklistFallback = null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    let event = events[index];
    if (!event || event.type !== 'message' || event.role !== 'assistant') {
      continue;
    }
    if (match && !match(event)) {
      continue;
    }

    if (hydrate && event.bodyAvailable && event.bodyLoaded === false && !trimString(event.content)) {
      const hydrated = await hydrate(event);
      if (hydrated) {
        event = hydrated;
      }
    }

    const candidate = classifyAssistantReplyCandidate(event);
    if (candidate.kind === 'select') {
      return event;
    }
    if (candidate.kind === 'fallback_checklist' && !checklistFallback) {
      checklistFallback = event;
    }
  }

  return checklistFallback;
}
