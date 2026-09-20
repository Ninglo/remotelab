// Per-chat overrides change ordinary intake and reply placement, never infer
// Session identity from message content.
export function normalizeFeishuGroups(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('groups must be a chat-ID to settings object');
  return Object.fromEntries(Object.entries(value).map(([chatId, raw]) => {
    if (!chatId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Feishu group settings');
    for (const key of Object.keys(raw)) {
      if (!['responseMode', 'replyMode', 'systemPrompt'].includes(key)) throw new Error(`Unsupported group setting: ${key}`);
    }
    if (raw.responseMode !== undefined && !['all', 'mention_only'].includes(raw.responseMode)) throw new Error('Invalid group responseMode');
    if (raw.replyMode !== undefined && !['inline', 'thread'].includes(raw.replyMode)) throw new Error('Invalid group replyMode');
    if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== 'string') throw new Error('Group systemPrompt must be a string');
    return [chatId, { ...raw }];
  }));
}

export function resolveFeishuGroupSettings(config = {}, summary = {}) {
  const group = config.groups?.[summary.chatId] || {};
  const privateChat = ['p2p', 'private'].includes(String(summary.chatType || '').trim().toLowerCase());
  return {
    responseMode: group.responseMode ?? config.responsePolicy?.group ?? 'mention_only',
    replyMode: group.replyMode ?? config.replyPolicy?.chats?.[summary.chatId]
      ?? (privateChat ? config.replyPolicy?.private : config.replyPolicy?.group) ?? (privateChat ? 'inline' : 'thread'),
    systemPrompt: [config.systemPrompt, group.systemPrompt].filter(value => typeof value === 'string' && value.trim()).join('\n\n'),
  };
}
