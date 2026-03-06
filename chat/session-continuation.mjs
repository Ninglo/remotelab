const MAX_EVENT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 24000;
const TRUNCATED_MARKER = '\n[... truncated by RemoteLab ...]\n';

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function clipText(value, maxChars = MAX_EVENT_CHARS) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}${TRUNCATED_MARKER}${text.slice(-tailChars).trimStart()}`;
}

function truncateMiddle(text, maxChars = MAX_CONTEXT_CHARS) {
  if (!text || text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.35));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}${TRUNCATED_MARKER}${text.slice(-tailChars).trimStart()}`;
}

function formatImages(images) {
  const refs = (images || [])
    .map((img) => img?.filename || '')
    .filter(Boolean);
  if (refs.length === 0) return '';
  return `[Attached images: ${refs.join(', ')}]`;
}

function formatMessage(evt) {
  const label = evt.role === 'user' ? 'User' : 'Assistant';
  const parts = [];
  const imageLine = formatImages(evt.images);
  if (imageLine) parts.push(imageLine);
  const content = clipText(evt.content);
  if (content) parts.push(content);
  if (parts.length === 0) return '';
  return `[${label}]\n${parts.join('\n')}`;
}

function formatToolUse(evt) {
  const input = clipText(evt.toolInput, 2500);
  if (!input) return '';
  return `[Assistant tool call: ${evt.toolName || 'unknown'}]\n${input}`;
}

function formatToolResult(evt) {
  const output = clipText(evt.output);
  if (!output) return '';
  const exitCode = evt.exitCode === undefined ? '' : `, exit ${evt.exitCode}`;
  return `[Tool result: ${evt.toolName || 'unknown'}${exitCode}]\n${output}`;
}

function formatFileChange(evt) {
  const filePath = normalizeText(evt.filePath);
  if (!filePath) return '';
  const changeType = normalizeText(evt.changeType) || 'updated';
  return `[File change: ${changeType}] ${filePath}`;
}

function formatStatus(evt) {
  const content = clipText(evt.content, 1000);
  if (!content) return '';
  if (!/^error:/i.test(content) && !/interrupted/i.test(content)) return '';
  return `[System status]\n${content}`;
}

function formatContinuationEvent(evt) {
  if (!evt || !evt.type) return '';
  switch (evt.type) {
    case 'message':
      return formatMessage(evt);
    case 'tool_use':
      return formatToolUse(evt);
    case 'tool_result':
      return formatToolResult(evt);
    case 'file_change':
      return formatFileChange(evt);
    case 'status':
      return formatStatus(evt);
    default:
      return '';
  }
}

export function buildSessionContinuationContext(events, options = {}) {
  const fromTool = options.fromTool || '';
  const toTool = options.toTool || '';
  const segments = (events || [])
    .map(formatContinuationEvent)
    .filter(Boolean);

  if (segments.length === 0) return '';

  const switchedTools = fromTool && toTool && fromTool !== toTool;
  const intro = switchedTools
    ? `RemoteLab session handoff: the user switched tools from ${fromTool} to ${toTool}.`
    : 'RemoteLab session handoff for this existing conversation.';

  const body = truncateMiddle(segments.join('\n\n'));
  return [
    intro,
    'Below is the prior session state reconstructed from RemoteLab\'s normalized history.',
    'Treat it as the authoritative context for continuing this same session.',
    '',
    body,
  ].join('\n');
}
