// Group overrides change ordinary intake, never classify message content.
export function normalizeFeishuGroups(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('groups must be a chat-ID to settings object');
  return Object.fromEntries(Object.entries(value).map(([chatId, raw]) => {
    if (!chatId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Feishu group settings');
    for (const key of Object.keys(raw)) {
      if (!['responseMode', 'sessionMode', 'systemPrompt'].includes(key)) throw new Error(`Unsupported group setting: ${key}`);
    }
    if (raw.responseMode !== undefined && !['all', 'mention_only'].includes(raw.responseMode)) throw new Error('Invalid group responseMode');
    if (raw.sessionMode !== undefined && !['fork', 'continue'].includes(raw.sessionMode)) throw new Error('Invalid group sessionMode');
    if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== 'string') throw new Error('Group systemPrompt must be a string');
    return [chatId, { ...raw }];
  }));
}

export function resolveFeishuGroupSettings(config = {}, summary = {}) {
  const group = config.groups?.[summary.chatId] || {};
  return {
    responseMode: group.responseMode ?? config.responsePolicy?.group ?? 'mention_only',
    sessionMode: group.sessionMode ?? config.sessionPolicy?.groups?.[summary.chatId] ?? config.sessionPolicy?.defaultMode ?? 'fork',
    systemPrompt: [config.systemPrompt, group.systemPrompt].filter(value => typeof value === 'string' && value.trim()).join('\n\n'),
  };
}
