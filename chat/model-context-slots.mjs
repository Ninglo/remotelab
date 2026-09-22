function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function createModelContextSlot(id, title, content, {
  delivery = 'turn',
} = {}) {
  const normalizedContent = trim(content);
  if (!normalizedContent) return null;
  return {
    id: trim(id),
    title: trim(title) || 'Context',
    delivery: trim(delivery) || 'turn',
    content: normalizedContent,
  };
}

export function compactModelContextSlots(slots = []) {
  return (Array.isArray(slots) ? slots : []).filter((slot) => (
    slot
    && typeof slot === 'object'
    && trim(slot.content)
  ));
}

export function renderModelContextSlots(slots = []) {
  return compactModelContextSlots(slots)
    .map((slot) => `## ${trim(slot.title) || 'Context'}\n\n${trim(slot.content)}`)
    .join('\n\n---\n\n');
}

export function describeModelContextSlots(slots = []) {
  return compactModelContextSlots(slots).map((slot) => ({
    id: trim(slot.id),
    title: trim(slot.title) || 'Context',
    delivery: trim(slot.delivery) || 'turn',
  }));
}
