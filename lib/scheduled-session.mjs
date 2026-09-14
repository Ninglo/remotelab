import { normalizeConversation } from './conversation-target.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

// Both timers use the same Session creation contract. sourceDelivery is read
// only at this compatibility boundary; there is no second scheduled sender.
export function normalizeScheduledSessionTemplate(value, fallbackTool = '', legacy = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const template = {
    folder: trim(raw.folder), tool: trim(raw.tool) || trim(fallbackTool),
    name: trim(raw.name), group: trim(raw.group), description: trim(raw.description),
    systemPrompt: trim(raw.systemPrompt), internalRole: trim(raw.internalRole) || 'scheduled_execution',
  };
  const requested = Object.hasOwn(legacy, 'conversation') ? legacy.conversation
    : Object.hasOwn(legacy, 'sourceDelivery') ? legacy.sourceDelivery : raw.conversation;
  const conversation = normalizeConversation(requested);
  if (requested != null && !conversation) throw new Error('Invalid scheduled conversation');
  if (conversation) template.conversation = conversation;
  return template.folder && template.tool ? template : null;
}

export function buildScheduledSessionTemplate(payload, sourceSession) {
  const name = trim(payload.title || sourceSession.name || 'Scheduled task');
  return normalizeScheduledSessionTemplate(payload.sessionTemplate || {
    folder: sourceSession.folder, tool: payload.tool || sourceSession.tool,
    name, group: sourceSession.group || 'Scheduled executions',
    description: `Execution for ${name}`, systemPrompt: sourceSession.systemPrompt,
  }, payload.tool, payload);
}
