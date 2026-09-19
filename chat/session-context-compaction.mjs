export function clipCompactionSection(value, maxChars = 12000) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[... truncated by RemoteLab ...]\n${text.slice(-tailChars).trimStart()}`;
}

function looksChinese(value) {
  const text = typeof value === 'string' ? value : '';
  const hanCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  if (hanCount < 4) return false;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  return hanCount * 6 >= latinCount;
}

export function resolveDelegationHandoffLanguage({
  languageHint,
  sourceText,
  task,
} = {}) {
  const hint = typeof languageHint === 'string' ? languageHint.trim() : '';
  if (/^zh(?:[-_](?:cn|hans))?$/i.test(hint)) return 'zh-CN';
  if (/^en(?:[-_].*)?$/i.test(hint)) return 'en';
  if (looksChinese(sourceText)) return 'zh-CN';
  if (looksChinese(task)) return 'zh-CN';
  return 'en';
}

export function buildDelegationHandoff({
  source,
  sourceText,
  task,
  context,
  languageHint,
}) {
  const normalizedTask = clipCompactionSection(task, 4000);
  const normalizedContext = clipCompactionSection(context, 6000);
  const sourceId = typeof source?.id === 'string' ? source.id.trim() : '';
  const language = resolveDelegationHandoffLanguage({ languageHint, sourceText, task: normalizedTask });
  const lines = language === 'zh-CN'
    ? [
      '任务交接：',
      '- 你已经位于本任务的独立目标会话中。',
      '- 下方只有一个聚焦任务，请直接在本会话完成。',
      '- 不要使用 session-spawn，也不要继续创建子会话；任务范围已经确定，请直接执行。',
      '',
      normalizedTask || '（未提供交接任务）',
      normalizedContext ? '必要上下文（由父会话显式提供）：' : '',
      normalizedContext,
    ]
    : [
      'Delegation handoff:',
      '- You are already in the delegated target session for this task.',
      '- You have exactly one focused task below. Complete it directly in this session.',
      '- Do NOT use session-spawn or delegate further child sessions. This task is already scoped — just do the work.',
      '',
      normalizedTask || '(no delegated task provided)',
      normalizedContext ? 'Essential context explicitly provided by the parent session:' : '',
      normalizedContext,
    ];
  if (sourceId) {
    lines.push('', language === 'zh-CN' ? `父会话 ID：${sourceId}` : `Parent session id: ${sourceId}`);
  }
  return lines.join('\n');
}

export function buildDelegationNotice({
  task,
  childName,
  targetUrl,
  sourceText,
  languageHint,
} = {}) {
  const normalizedTask = clipCompactionSection(task, 240)
    .replace(/\s+/g, ' ')
    .trim();
  const normalizedName = typeof childName === 'string' && childName.trim()
    ? childName.trim()
    : '';
  const normalizedUrl = typeof targetUrl === 'string' ? targetUrl.trim() : '';
  const language = resolveDelegationHandoffLanguage({ languageHint, sourceText, task: normalizedTask });
  const fallbackName = language === 'zh-CN' ? '新会话' : 'new session';
  const link = normalizedUrl
    ? `[${normalizedName || fallbackName}](${normalizedUrl})`
    : (normalizedName || fallbackName);
  if (language === 'zh-CN') {
    return [
      '已为这项工作创建独立会话。',
      '',
      normalizedTask ? `- 任务：${normalizedTask}` : '',
      `- 会话：${link}`,
      normalizedUrl ? `- 打开：${normalizedUrl}` : '',
      '',
      '这个新会话彼此独立，可以自行继续执行。',
    ].filter(Boolean).join('\n');
  }
  return [
    'Spawned a parallel session for this work.',
    '',
    normalizedTask ? `- Task: ${normalizedTask}` : '',
    `- Session: ${link}`,
    normalizedUrl ? `- Open: ${normalizedUrl}` : '',
    '',
    'This new session is independent and can continue on its own.',
  ].filter(Boolean).join('\n');
}
