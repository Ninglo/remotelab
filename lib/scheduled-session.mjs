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
  if (raw.reuse === 'calendar_day') {
    const timezone = trim(raw.reuseTimezone) || 'Asia/Shanghai';
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    template.reuse = 'calendar_day';
    template.reuseTimezone = timezone;
  } else if (raw.reuse) throw new Error('Unsupported scheduled Session reuse policy');
  return template.folder && template.tool ? template : null;
}

export function scheduledSessionIdentity(trigger, template) {
  if (template.reuse !== 'calendar_day') return trigger.id;
  if (!trigger.scheduleId) throw new Error('Calendar-day reuse requires a recurring schedule');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: template.reuseTimezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(trigger.scheduledAt));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `schedule-day:${trigger.scheduleId}:${fields.year}-${fields.month}-${fields.day}`;
}

export function buildScheduledSessionTemplate(payload, sourceSession) {
  const name = trim(payload.title || sourceSession.name || 'Scheduled task');
  return normalizeScheduledSessionTemplate(payload.sessionTemplate || {
    folder: sourceSession.folder, tool: payload.tool || sourceSession.tool,
    name, group: sourceSession.group || 'Scheduled executions',
    description: `Execution for ${name}`, systemPrompt: sourceSession.systemPrompt,
  }, payload.tool, payload);
}
