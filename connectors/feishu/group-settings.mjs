import { buildFeishuResponseDecisionPrompt } from '../../lib/feishu-response-decision.mjs';
import { buildFeishuTopicId, isFeishuTopicGroup } from './index.mjs';
import { normalizeDailyReportMemory } from './daily-report-memory.mjs';
import { FEISHU_REACTION_CATALOG, normalizeFeishuReactionCandidates } from '../../lib/feishu-reaction-catalog.mjs';

// Participation, batching and placement have one policy below. These strings
// describe only the current surface and optional feedback capability.
const AMBIENT_SESSION_PROMPT = 'This Session follows the shared Feishu group timeline, including messages without an @ mention. A mention-only message invites you to reconsider recent unanswered messages together.';
const TOPIC_SESSION_PROMPT = 'Continue the task and conversation in this same topic.';
const GROUP_SESSION_PROMPT = 'Every admitted human message on this Feishu group mainline reaches your continuing Session.';
const QUICK_REACTION_SESSION_PROMPT = 'Social reactions are optional; no temporary receipt or fallback emoji is added automatically.';
const JEV_REACTION_SESSION_PROMPT = 'Jev supplies optional asynchronous social feedback. Use its receipt if available; never wait for Jev.';

const WORK_KICKOFF_SESSION_PROMPT = [
  'Only in active participation, when discussion has produced a concrete goal and executable plan, you may offer a discussion-to-work confirmation card. Judge the timing yourself from the discussion; do not use elapsed silence or an emoji as approval. Listening and paused modes do not offer this card.',
  'Use node "$REMOTELAB_PROJECT_ROOT/cli.js" work kickoff --file <absolute JSON path> --json with {action:"propose",sourceRequestId:"the actual accepted human input ID",goal,plan,sources,unresolved,acceptance}. Include agreed scope, original sources, remaining decisions (or none), and concrete acceptance. The registered project relationship determines the target work group.',
  'If the result has a question, pass its complete title and options unchanged to the native user-input tool. The choices are transfer to the work group and start, continue discussion, or defer. Only the server-verified human answer creates a real work topic and starts execution after delivery. Do not substitute work plan start or route new for this confirmation. A missing question means there is no new card to send. Do not repeat an unchanged proposal already awaiting a reply.',
  'Keep discussion and follow-ups here until the actual work topic is created. Reuse that work topic for subsequent supplements and results. This cross-group work transfer is separate from choosing a thread for the current reply.',
].join('\n');

export function defaultFeishuGroupParticipation(config = {}) {
  return config.defaultGroupParticipation || (config.responsePolicy?.group === 'mention_only' ? 'mention_only' : 'active');
}

// Explicit per-chat policies survive the default for newly added groups.
export function effectiveFeishuGroup(config = {}, chatId = '') {
  const group = config.groups?.[chatId] || {};
  if (group.participationControls === false || (group.responseMode === 'mention_only' && !group.participationMode)) return group;
  const explicit = ['active', 'listening', 'paused'].includes(group.participationMode);
  if (explicit) return { participationControls: true, groupFeed: true, quickReactions: true, jevReactions: true, ...group,
    participationMode: 'ambient', initialParticipationMode: group.participationMode };
  if (!['active', 'listening', 'paused'].includes(config.defaultGroupParticipation)) return group;
  return { participationControls: true, groupFeed: true, quickReactions: true, jevReactions: true, ...group,
    participationMode: 'ambient', initialParticipationMode: group.participationMode === 'ambient' ? 'active'
      : group.responseMode === 'mention_only' ? 'listening' : config.defaultGroupParticipation };
}

// Per-chat overrides select intake policy and the mainline participation pilot.
export function normalizeFeishuGroups(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('groups must be a chat-ID to settings object');
  return Object.fromEntries(Object.entries(value).map(([chatId, raw]) => {
    if (!chatId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Feishu group settings');
    for (const key of Object.keys(raw)) {
      if (!['reactionCandidates', 'responseMode', 'replyMode', 'systemPrompt', 'participationMode', 'quickReactions', 'jevReactions', 'contextReactions', 'reactionFeedback', 'groupFeed', 'dailyReportMemory', 'participationControls', 'participationStatusMessageId', 'participationStatusCard'].includes(key)) throw new Error(`Unsupported group setting: ${key}`);
    }
    if (raw.participationControls !== undefined && typeof raw.participationControls !== 'boolean') throw new Error('Invalid participationControls');
    if (raw.participationControls && !['ambient', 'active', 'listening', 'paused'].includes(raw.participationMode)) throw new Error('participationControls requires ambient mode');
    if (raw.participationStatusCard !== undefined && typeof raw.participationStatusCard !== 'boolean') throw new Error('Invalid participationStatusCard');
    if (raw.participationStatusMessageId !== undefined && !/^om_[A-Za-z0-9_]+$/.test(raw.participationStatusMessageId)) throw new Error('Invalid participationStatusMessageId');
    if (raw.responseMode !== undefined && !['all', 'mention_only'].includes(raw.responseMode)) throw new Error('Invalid group responseMode');
    if (raw.replyMode !== undefined && !['inline', 'thread'].includes(raw.replyMode)) throw new Error('Invalid group replyMode');
    if (raw.participationMode !== undefined && !['ambient', 'active', 'listening', 'paused'].includes(raw.participationMode)) throw new Error('Invalid group participationMode');
    if (raw.quickReactions !== undefined && typeof raw.quickReactions !== 'boolean') throw new Error('Invalid group quickReactions');
    if (raw.jevReactions !== undefined && typeof raw.jevReactions !== 'boolean') throw new Error('Invalid group jevReactions');
    if (raw.jevReactions === true && !['active', 'listening', 'paused'].includes(raw.participationMode) && (raw.quickReactions !== true || !['ambient', 'active', 'listening', 'paused'].includes(raw.participationMode) || raw.groupFeed !== true)) {
      throw new Error('jevReactions requires quickReactions, ambient participation and groupFeed');
    }
    if (raw.contextReactions !== undefined && typeof raw.contextReactions !== 'boolean') throw new Error('Invalid group contextReactions');
    if (raw.reactionFeedback !== undefined && typeof raw.reactionFeedback !== 'boolean') throw new Error('Invalid group reactionFeedback');
    if (raw.groupFeed !== undefined && typeof raw.groupFeed !== 'boolean') throw new Error('Invalid group groupFeed');
    if (raw.groupFeed === true && !['ambient', 'active', 'listening', 'paused'].includes(raw.participationMode)) throw new Error('groupFeed requires ambient participationMode');
    if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== 'string') throw new Error('Group systemPrompt must be a string');
    if (raw.reactionCandidates !== undefined) normalizeFeishuReactionCandidates(raw.reactionCandidates);
    const dailyReportMemory = normalizeDailyReportMemory(raw.dailyReportMemory);
    if (dailyReportMemory && raw.jevReactions !== true) throw new Error('dailyReportMemory requires jevReactions');
    return [chatId, { ...raw, ...(dailyReportMemory ? { dailyReportMemory } : {}) }];
  }));
}

export function resolveFeishuGroupSettings(config = {}, summary = {}) {
  const group = effectiveFeishuGroup(config, summary.chatId);
  const privateChat = ['p2p', 'private'].includes(String(summary.chatType || '').trim().toLowerCase());
  const topicGroup = !privateChat && isFeishuTopicGroup(summary);
  const topic = !privateChat && (topicGroup
    || Boolean(buildFeishuTopicId(summary))
    || (['topic', 'thread'].includes(summary.conversationKind)
      && (summary.startThread !== true || group.jevReactions === true)));
  const groupMainline = !privateChat && !topic
    && [summary.chatType, summary.chatMode].some(value => String(value || '').toLowerCase() === 'group');
  const ambient = groupMainline && group.participationMode === 'ambient';
  const unified = !topicGroup && (groupMainline || topic) && Boolean(group.initialParticipationMode) && group.participationControls !== false;
  const quickReactions = !topicGroup && (groupMainline || topic) && group.quickReactions === true && !privateChat && (!topic || unified);
  const jevReactions = group.jevReactions === true && !privateChat && (ambient || unified);
  const candidates = normalizeFeishuReactionCandidates(group.reactionCandidates ?? (privateChat ? undefined : config.groupReactionCandidates));
  return {
    reactionCandidates: candidates,
    // Native topic groups always receive humans; ordinary groups keep their policies.
    responseMode: topicGroup || group.participationMode === 'ambient' ? 'all' : group.responseMode
      ?? 'mention_only',
    replyMode: group.replyMode ?? config.replyPolicy?.chats?.[summary.chatId]
      ?? (ambient ? 'inline' : privateChat ? config.replyPolicy?.private : config.replyPolicy?.group) ?? (privateChat ? 'inline' : 'thread'),
    ...(ambient ? { participationMode: 'ambient' } : {}),
    ...(ambient && typeof group.groupFeed === 'boolean' ? { groupFeed: group.groupFeed } : {}),
    ...(quickReactions ? { quickReactions: true } : {}),
    ...(jevReactions ? { jevReactions: true } : {}),
    ...(jevReactions && group.dailyReportMemory
      ? { dailyReportMemory: group.dailyReportMemory } : {}),
    systemPrompt: [config.systemPrompt, group.systemPrompt,
      !privateChat && (ambient || topic || quickReactions) ? `Optional reaction candidates: ${candidates.map(id => `${id} (${FEISHU_REACTION_CATALOG[id]})`).join(', ') || 'none'}.` : '',
      jevReactions ? JEV_REACTION_SESSION_PROMPT
        : quickReactions ? QUICK_REACTION_SESSION_PROMPT : '',
      !topicGroup && (ambient || topic) && config.projectLinks?.some(link => link.discussionChatId === summary.chatId) ? WORK_KICKOFF_SESSION_PROMPT : '',
      (groupMainline || topic) ? buildFeishuResponseDecisionPrompt({ topicGroup }) : '',
      ambient ? AMBIENT_SESSION_PROMPT : topic && !topicGroup ? TOPIC_SESSION_PROMPT
        : groupMainline && group.responseMode === 'all' ? GROUP_SESSION_PROMPT : '']
      .filter(value => typeof value === 'string' && value.trim()).join('\n\n'),
  };
}
