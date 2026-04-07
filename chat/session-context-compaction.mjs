export function clipCompactionSection(value, maxChars = 12000) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[... truncated by RemoteLab ...]\n${text.slice(-tailChars).trimStart()}`;
}

export function buildDelegationHandoff({
  source,
  task,
}) {
  const normalizedTask = clipCompactionSection(task, 4000);
  const sourceId = typeof source?.id === 'string' ? source.id.trim() : '';
  const lines = [
    'Delegation handoff:',
    '- You are already in the delegated target session for this task.',
    '- You have exactly one focused task below. Complete it directly in this session.',
    '- Do NOT use session-spawn or delegate further child sessions. This task is already scoped — just do the work.',
    '',
    normalizedTask || '(no delegated task provided)',
  ];
  if (sourceId) {
    lines.push('', `Parent session id: ${sourceId}`);
  }
  return lines.join('\n');
}
