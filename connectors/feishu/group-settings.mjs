import { buildFeishuTopicId, isFeishuTopicChat } from './index.mjs';
import { normalizeDailyReportMemory } from './daily-report-memory.mjs';

const AMBIENT_SESSION_PROMPT = [
  'This Feishu group sends its main-timeline messages to your continuing Session, including messages without an @ mention.',
  'Read the recent group discussion and decide whether your participation helps. If the newest human message explicitly @ mentions another person and not you, treat it as their conversation: observe it without using tools or doing their task, unless they explicitly invite you too. Do not acknowledge every message in text.',
  'If the newest human message explicitly @ mentions you, give a text reply unless it explicitly asks you to stay silent. For other messages, join only when you have a clear, useful contribution. If you use tools or start work, finish with a visible result or an honest handoff; never end that turn with only a reaction or an empty final answer.',
  'A concrete unanswered question or request directed to the assistant needs a reply even without an @ mention. Do not mistake a useful question for ordinary chatter.',
  'For a brief answer, use your normal final answer; RemoteLab quotes the current source message on the group main timeline. Do not send a separate opening or progress for a short answer.',
  'If a substantial, distinct discussion should open as a Feishu Thread, put exactly <private>feishu-reply:thread</private> after any reaction directive and before the first visible reply. RemoteLab keeps all later replies, attachments and questions for this turn in that same location. A later marker cannot move an already started reply. Do not use that marker for silence.',
  'A message that only mentions you asks you to reconsider recent unanswered group messages together and reply. A mute signal is feedback that your previous participation may have been unwelcome. Treat feedback as context for your next judgment.',
].join('\n');

const TOPIC_SESSION_PROMPT = [
  'A Feishu topic is an intentional conversation with you.',
  'By default, the human is speaking to you in this topic; no @ mention or earlier Bot invitation is required.',
  'Reply to each human message in the current topic, including messages without an @ mention, unless the user explicitly asks you to stay silent or this topic is muted.',
  'Keep replies in the same topic.',
].join('\n');

const GROUP_SESSION_PROMPT = [
  'Every admitted human message on this Feishu group mainline reaches your Session, including messages without an @ mention.',
  'Use the discussion context to decide whether a reply or task is useful. A concrete unanswered question or request needs a reply; human-to-human conversation or an update needing no contribution may be left without visible text.',
].join('\n');

const QUICK_REACTION_SESSION_PROMPT = [
  'In this group the connector immediately adds THINKING to each incoming human message as a temporary receipt. It removes that reaction after your final outcome reaction succeeds.',
  'A message @ mentioning another person but not you is normally for that person. Do not start their work or use research/coding tools unless the message clearly invites you too.',
  'Choose one outcome reaction in your final answer by starting it with exactly `<private><feishu-reaction emoji="EMOJI"/></private>`. The connector applies it as this Bot to the current source message before posting any visible text. Do not call a CLI, provide a message ID, or use personal OAuth for this reaction.',
  'Available emoji types: OnIt (working on a requested reply or task), EatingFood (quietly leave human-to-human discussion), OK, THUMBSUP, THANKS, GLANCE (saw an update), SMILE, APPLAUSE, WOW, WHAT, DULL, TOASTED (衰), TEARS, HUG, COMFORT. Choose a fitting tone; a reaction must not imply that work is finished when it is not.',
  'For a useful short answer, put the OnIt reaction directive first, then your ordinary final answer. For reaction-only participation, finish with only the directive and no visible text. For human-to-human discussion needing no participation, finish with only an EatingFood directive. Never end with an empty final answer. If your directive is absent or invalid, the connector uses EatingFood. The connector removes the directive before any text is posted.',
  'If you used research, coding, or other work tools, provide a visible result or honest handoff in the final answer even when you include a reaction. Never hide unfinished work with a reaction-only directive.',
].join('\n');

const JEV_REACTION_SESSION_PROMPT = [
  'The Feishu connector records each group message and forwards it to the Session model. Decide whether a useful text reply or task is needed from the full Session context; stay silent when no text contribution is needed, including when an existing reaction fully answers the request.',
  'Jev selects reactions and may suggest work placement, but its silence or reaction-only judgment never prevents you from receiving the message. The connector handles reactions; do not emit a feishu-reaction directive or choose another reaction. If you start work, give a visible result or an honest handoff.',
].join('\n');

const GROUP_TIMELINE_SESSION_PROMPT = [
  'This Session is the shared group timeline in RemoteLab. Humans participate through the Feishu group, not the RemoteLab Session composer.',
  'Keep this timeline for observing the discussion and giving brief answers. Do not use this Session as a workspace for research, coding, file edits, reports, or long-running tasks.',
  'When a group member clearly requests substantial work, start a separate work Session in an appropriate project workspace (never this group timeline folder), carry the source message link and bounded context into it, and report the work Session destination to the group. Keep the work process and its tool output out of this timeline.',
  'A short answer that needs no tool use can be given directly in the group. Do not treat human-to-human discussion as a task.',
].join('\n');

// Per-chat overrides select intake policy and the mainline participation pilot.
export function normalizeFeishuGroups(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('groups must be a chat-ID to settings object');
  return Object.fromEntries(Object.entries(value).map(([chatId, raw]) => {
    if (!chatId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Feishu group settings');
    for (const key of Object.keys(raw)) {
      if (!['responseMode', 'replyMode', 'systemPrompt', 'participationMode', 'quickReactions', 'jevReactions', 'contextReactions', 'reactionFeedback', 'groupFeed', 'dailyReportMemory', 'participationControls', 'participationStatusMessageId'].includes(key)) throw new Error(`Unsupported group setting: ${key}`);
    }
    if (raw.participationControls !== undefined && typeof raw.participationControls !== 'boolean') throw new Error('Invalid participationControls');
    if (raw.participationControls && raw.participationMode !== 'ambient') throw new Error('participationControls requires ambient mode');
    if (raw.participationStatusMessageId !== undefined && !/^om_[A-Za-z0-9_]+$/.test(raw.participationStatusMessageId)) throw new Error('Invalid participationStatusMessageId');
    if (raw.responseMode !== undefined && !['all', 'mention_only'].includes(raw.responseMode)) throw new Error('Invalid group responseMode');
    if (raw.replyMode !== undefined && !['inline', 'thread'].includes(raw.replyMode)) throw new Error('Invalid group replyMode');
    if (raw.participationMode !== undefined && raw.participationMode !== 'ambient') throw new Error('Invalid group participationMode');
    if (raw.quickReactions !== undefined && typeof raw.quickReactions !== 'boolean') throw new Error('Invalid group quickReactions');
    if (raw.jevReactions !== undefined && typeof raw.jevReactions !== 'boolean') throw new Error('Invalid group jevReactions');
    if (raw.jevReactions === true && (raw.quickReactions !== true || raw.participationMode !== 'ambient' || raw.groupFeed !== true)) {
      throw new Error('jevReactions requires quickReactions, ambient participation and groupFeed');
    }
    if (raw.contextReactions !== undefined && typeof raw.contextReactions !== 'boolean') throw new Error('Invalid group contextReactions');
    if (raw.reactionFeedback !== undefined && typeof raw.reactionFeedback !== 'boolean') throw new Error('Invalid group reactionFeedback');
    if (raw.groupFeed !== undefined && typeof raw.groupFeed !== 'boolean') throw new Error('Invalid group groupFeed');
    if (raw.groupFeed === true && raw.participationMode !== 'ambient') throw new Error('groupFeed requires ambient participationMode');
    if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== 'string') throw new Error('Group systemPrompt must be a string');
    const dailyReportMemory = normalizeDailyReportMemory(raw.dailyReportMemory);
    if (dailyReportMemory && raw.jevReactions !== true) throw new Error('dailyReportMemory requires jevReactions');
    return [chatId, { ...raw, ...(dailyReportMemory ? { dailyReportMemory } : {}) }];
  }));
}

export function resolveFeishuGroupSettings(config = {}, summary = {}) {
  const group = config.groups?.[summary.chatId] || {};
  const privateChat = ['p2p', 'private'].includes(String(summary.chatType || '').trim().toLowerCase());
  const topic = !privateChat && (isFeishuTopicChat(summary)
    || Boolean(buildFeishuTopicId(summary))
    || (['topic', 'thread'].includes(summary.conversationKind)
      && (summary.startThread !== true || group.jevReactions === true)));
  const groupMainline = !privateChat && !topic
    && [summary.chatType, summary.chatMode].some(value => String(value || '').toLowerCase() === 'group');
  const legacyMentionGate = (group.responseMode ?? config.responsePolicy?.group ?? 'mention_only') === 'mention_only';
  const ambient = !privateChat && !topic
    && (group.participationMode === 'ambient' || (groupMainline && legacyMentionGate));
  const quickReactions = group.quickReactions === true && !privateChat && !topic;
  return {
    // Legacy mention-only settings now select Session participation judgment,
    // rather than dropping unmentioned human messages before the Session.
    responseMode: topic || groupMainline ? 'all' : group.responseMode
      ?? (ambient ? 'all' : config.responsePolicy?.group ?? 'mention_only'),
    replyMode: group.replyMode ?? config.replyPolicy?.chats?.[summary.chatId]
      ?? (ambient ? 'inline' : privateChat ? config.replyPolicy?.private : config.replyPolicy?.group) ?? (privateChat ? 'inline' : 'thread'),
    ...(ambient ? { participationMode: 'ambient' } : {}),
    ...(ambient && typeof group.groupFeed === 'boolean' ? { groupFeed: group.groupFeed } : {}),
    ...(quickReactions ? { quickReactions: true } : {}),
    ...(group.jevReactions === true && ambient ? { jevReactions: true } : {}),
    ...(group.jevReactions === true && ambient && group.dailyReportMemory
      ? { dailyReportMemory: group.dailyReportMemory } : {}),
    systemPrompt: [config.systemPrompt, group.systemPrompt,
      group.jevReactions === true && ambient ? JEV_REACTION_SESSION_PROMPT
        : quickReactions ? QUICK_REACTION_SESSION_PROMPT : '',
      ambient && (group.participationMode === 'ambient' || group.groupFeed === true)
        ? GROUP_TIMELINE_SESSION_PROMPT : '',
      ambient ? AMBIENT_SESSION_PROMPT : topic ? TOPIC_SESSION_PROMPT
        : groupMainline ? GROUP_SESSION_PROMPT : '']
      .filter(value => typeof value === 'string' && value.trim()).join('\n\n'),
  };
}
