import { isFeishuTopicChat } from './index.mjs';

const AMBIENT_SESSION_PROMPT = [
  'This Feishu group sends its main-timeline messages to your continuing Session, including messages without an @ mention.',
  'Read the recent group discussion and decide whether your participation helps. If the newest human message explicitly @ mentions you, give a text reply unless it explicitly asks you to stay silent. Otherwise, if no reply is warranted, return an empty final answer. Do not acknowledge every message in text.',
  'When replying, use the normal final answer for a message on the group main timeline.',
  'If a substantial, distinct discussion should open as a Feishu Thread, begin your final answer with exactly <private>feishu-reply:thread</private>. RemoteLab will post the visible answer in a Thread rooted at the current inbound message. Do not use that marker for silence.',
  'A message that only mentions you asks you to reconsider recent unanswered group messages together and reply. A mute signal is feedback that your previous participation may have been unwelcome. Treat feedback as context for your next judgment.',
].join('\n');

const TOPIC_SESSION_PROMPT = [
  'A Feishu topic is an intentional conversation with you.',
  'Reply to each human message in the current topic, including messages without an @ mention, unless the user explicitly asks you to stay silent or this topic is muted.',
  'Keep replies in the same topic.',
].join('\n');

const QUICK_REACTION_SESSION_PROMPT = [
  'In this group the connector immediately adds THINKING to each incoming human message as its read receipt.',
  'It may also add one outcome reaction: OnIt when a text reply is expected, or another emoji when no text reply is expected. Do not add another reaction to the same incoming message when the connector has already added an outcome reaction.',
  'If the newest message explicitly asks for an emoji/reaction only, the connector adds only THINKING. Add exactly one suitable reaction yourself and do not send a text reply.',
].join('\n');

const GROUP_FEED_SESSION_PROMPT = [
  'This Session is the shared, read-only group timeline in RemoteLab. Humans participate through the Feishu group, not the RemoteLab Session composer.',
  'Keep this timeline for observing the discussion, choosing reactions, and giving brief answers. Do not use this Session as a workspace for research, coding, file edits, reports, or long-running tasks.',
  'When a group member clearly requests substantial work, start a separate work Session in an appropriate project workspace (never this group timeline folder), carry the source message link and bounded context into it, and report the work Session destination to the group. Keep the work process and its tool output out of this timeline.',
  'A short answer that needs no tool use can be given directly in the group. Do not treat human-to-human discussion as a task.',
].join('\n');

// Per-chat overrides select intake policy and the mainline participation pilot.
export function normalizeFeishuGroups(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('groups must be a chat-ID to settings object');
  return Object.fromEntries(Object.entries(value).map(([chatId, raw]) => {
    if (!chatId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Feishu group settings');
    for (const key of Object.keys(raw)) {
      if (!['responseMode', 'replyMode', 'systemPrompt', 'participationMode', 'quickReactions', 'contextReactions', 'reactionFeedback', 'groupFeed'].includes(key)) throw new Error(`Unsupported group setting: ${key}`);
    }
    if (raw.responseMode !== undefined && !['all', 'mention_only'].includes(raw.responseMode)) throw new Error('Invalid group responseMode');
    if (raw.replyMode !== undefined && !['inline', 'thread'].includes(raw.replyMode)) throw new Error('Invalid group replyMode');
    if (raw.participationMode !== undefined && raw.participationMode !== 'ambient') throw new Error('Invalid group participationMode');
    if (raw.quickReactions !== undefined && typeof raw.quickReactions !== 'boolean') throw new Error('Invalid group quickReactions');
    if (raw.contextReactions !== undefined && typeof raw.contextReactions !== 'boolean') throw new Error('Invalid group contextReactions');
    if (raw.reactionFeedback !== undefined && typeof raw.reactionFeedback !== 'boolean') throw new Error('Invalid group reactionFeedback');
    if (raw.groupFeed !== undefined && typeof raw.groupFeed !== 'boolean') throw new Error('Invalid group groupFeed');
    if (raw.groupFeed === true && raw.participationMode !== 'ambient') throw new Error('groupFeed requires ambient participationMode');
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
    ...(ambient && typeof group.groupFeed === 'boolean' ? { groupFeed: group.groupFeed } : {}),
    ...(group.quickReactions === true && !privateChat ? { quickReactions: true } : {}),
    systemPrompt: [config.systemPrompt, group.systemPrompt,
      group.quickReactions === true ? QUICK_REACTION_SESSION_PROMPT : '',
      ambient && group.groupFeed === true ? GROUP_FEED_SESSION_PROMPT : '',
      ambient ? AMBIENT_SESSION_PROMPT : isFeishuTopicChat(summary) ? TOPIC_SESSION_PROMPT : '']
      .filter(value => typeof value === 'string' && value.trim()).join('\n\n'),
  };
}
