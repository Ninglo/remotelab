import { normalizeMessageEventAttachments } from './attachment-utils.mjs';

let counter = 0;

function createEvent(type, fields = {}) {
  counter += 1;
  return {
    type,
    id: `evt_${String(counter).padStart(6, '0')}`,
    timestamp: Date.now(),
    ...fields,
  };
}

export function messageEvent(role, content, images, extra = {}) {
  const fields = { role, content, ...extra };
  if (images && images.length > 0) fields.attachments = images;
  return normalizeMessageEventAttachments(createEvent('message', fields));
}

export function toolUseEvent(toolName, toolInput) {
  return createEvent('tool_use', { role: 'assistant', toolName, toolInput });
}

export function toolResultEvent(toolName, output, exitCode) {
  return createEvent('tool_result', { role: 'system', toolName, output, exitCode });
}

export function fileChangeEvent(filePath, changeType) {
  return createEvent('file_change', { role: 'system', filePath, changeType });
}

export function reasoningEvent(content) {
  return createEvent('reasoning', { role: 'assistant', content });
}

export function managerContextEvent(content, extra = {}) {
  return createEvent('manager_context', { role: 'system', content, ...extra });
}

export function statusEvent(content) {
  return createEvent('status', { role: 'system', content });
}

export function usageEvent({
  contextTokens,
  inputTokens,
  outputTokens,
  contextWindowTokens,
  contextSource,
} = {}) {
  return createEvent('usage', {
    role: 'system',
    ...(Number.isFinite(contextTokens) ? { contextTokens } : {}),
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    ...(Number.isFinite(contextWindowTokens) ? { contextWindowTokens } : {}),
    ...(typeof contextSource === 'string' && contextSource ? { contextSource } : {}),
  });
}
