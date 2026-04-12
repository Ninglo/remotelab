function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getEventAttachments(event) {
  const attachments = Array.isArray(event?.attachments) && event.attachments.length > 0
    ? event.attachments
    : (Array.isArray(event?.images) ? event.images : []);
  return attachments.filter((attachment) => attachment && typeof attachment === 'object');
}

function getAttachmentDisplayName(attachment) {
  return trimString(attachment?.originalName) || trimString(attachment?.filename) || 'attachment';
}

export function stripHiddenBlocks(text) {
  return String(text || '')
    .replace(/<private>[\s\S]*?<\/private>/gi, '')
    .replace(/<hide>[\s\S]*?<\/hide>/gi, '')
    .trim();
}

export function getAssistantReplyAttachments(event) {
  return getEventAttachments(event).map((attachment) => ({ ...attachment }));
}

export function hasAssistantReplyAttachments(event) {
  return getAssistantReplyAttachments(event).length > 0;
}

export function buildAssistantReplyAttachmentFallbackText(
  event,
  {
    maxNames = 3,
    prefixSingular = 'Attached file',
    prefixPlural = 'Attached files',
  } = {},
) {
  const attachments = getAssistantReplyAttachments(event);
  if (attachments.length === 0) return '';

  const names = attachments
    .map((attachment) => getAttachmentDisplayName(attachment))
    .filter(Boolean);
  if (names.length === 0) return attachments.length === 1 ? prefixSingular : prefixPlural;

  const visibleNames = names.slice(0, maxNames);
  const suffix = names.length > maxNames
    ? ` (+${names.length - maxNames} more)`
    : '';
  return `${attachments.length === 1 ? prefixSingular : prefixPlural}: ${visibleNames.join(', ')}${suffix}`;
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
  if (!event || event.role !== 'assistant') {
    return { kind: 'ignore', content: '' };
  }

  const content = stripHiddenBlocks(event.content || '');
  const hasAttachments = hasAssistantReplyAttachments(event);

  if (event.type === 'attachment_delivery') {
    return hasAttachments
      ? { kind: 'fallback_attachment', content }
      : { kind: 'ignore', content };
  }

  if (event.type !== 'message') {
    return { kind: 'ignore', content };
  }

  const messageKind = trimString(event.messageKind).toLowerCase();
  if (messageKind === 'todo_list') {
    return { kind: 'ignore', content };
  }

  if (!content) {
    return hasAttachments
      ? { kind: 'fallback_attachment', content }
      : { kind: 'ignore', content };
  }

  if (isChecklistOnlyMessage(content)) {
    return { kind: 'fallback_checklist', content };
  }

  return { kind: 'select', content };
}

export async function selectAssistantReplyEvent(events = [], options = {}) {
  const match = typeof options.match === 'function' ? options.match : null;
  const hydrate = typeof options.hydrate === 'function' ? options.hydrate : null;
  let attachmentFallback = null;
  let checklistFallback = null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    let event = events[index];
    if (!event || event.role !== 'assistant') {
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
    if (candidate.kind === 'fallback_attachment' && !attachmentFallback) {
      attachmentFallback = event;
    }
    if (candidate.kind === 'fallback_checklist' && !checklistFallback) {
      checklistFallback = event;
    }
  }

  return attachmentFallback || checklistFallback;
}
