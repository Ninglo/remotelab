import { isFeishuTopicChat } from './index.mjs';

const AMBIENT_SESSION_PROMPT = [
  'This Feishu group sends its main-timeline messages to your continuing Session, including messages without an @ mention.',
  'Read the recent group discussion and decide whether your participation helps. If no reply is warranted, return an empty final answer. Do not acknowledge every message.',
  'When replying, use the normal final answer for a message on the group main timeline.',
  'If a substantial, distinct discussion should open as a Feishu Thread, begin your final answer with exactly <private>feishu-reply:thread</private>. RemoteLab will post the visible answer in a Thread rooted at the current inbound message. Do not use that marker for silence.',
  'A message that only mentions you is feedback to reconsider the recent unanswered group messages together. A mute signal is feedback that your previous participation may have been unwelcome. Treat feedback as context for your next judgment.',
].join('\n');

// Per-chat overrides select intake policy and the mainline participation pilot.
export function normalizeFeishuGroups(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('groups must be a chat-ID to settings object');
  return Object.fromEntries(Object.entries(value).map(([chatId, raw]) => {
    if (!chatId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Feishu group settings');
    for (const key of Object.keys(raw)) {
      if (!['responseMode', 'replyMode', 'systemPrompt', 'participationMode'].includes(key)) throw new Error(`Unsupported group setting: ${key}`);
    }
    if (raw.responseMode !== undefined && !['all', 'mention_only'].includes(raw.responseMode)) throw new Error('Invalid group responseMode');
    if (raw.replyMode !== undefined && !['inline', 'thread'].includes(raw.replyMode)) throw new Error('Invalid group replyMode');
    if (raw.participationMode !== undefined && raw.participationMode !== 'ambient') throw new Error('Invalid group participationMode');
    if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== 'string') throw new Error('Group systemPrompt must be a string');
    return [chatId, { ...raw }];
  }));
}

export function resolveFeishuGroupSettings(config = {}, summary = {}) {
  const group = config.groups?.[summary.chatId] || {};
  const privateChat = ['p2p', 'private'].includes(String(summary.chatType || '').trim().toLowerCase());
  const ambient = group.participationMode === 'ambient' && !privateChat
    && !summary.threadId && !summary.topicId && summary.conversationKind !== 'thread'
    && !isFeishuTopicChat(summary);
  return {
    // A Feishu topic is already an intentional conversation surface. Admit its
    // human messages by default, while retaining mention-only ordinary groups
    // and allowing an exact chat override to narrow either behavior.
    responseMode: group.responseMode ?? (ambient ? 'all' : isFeishuTopicChat(summary)
      ? 'all'
      : config.responsePolicy?.group ?? 'mention_only'),
    replyMode: group.replyMode ?? config.replyPolicy?.chats?.[summary.chatId]
      ?? (ambient ? 'inline' : privateChat ? config.replyPolicy?.private : config.replyPolicy?.group) ?? (privateChat ? 'inline' : 'thread'),
    ...(ambient ? { participationMode: 'ambient' } : {}),
    systemPrompt: [config.systemPrompt, group.systemPrompt, ambient ? AMBIENT_SESSION_PROMPT : '']
      .filter(value => typeof value === 'string' && value.trim()).join('\n\n'),
  };
}
