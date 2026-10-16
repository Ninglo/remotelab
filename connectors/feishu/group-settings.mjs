import { FEISHU_RESPONSE_DECISION_PROMPT } from '../../lib/feishu-response-decision.mjs';
import { buildFeishuTopicId, isFeishuTopicChat } from './index.mjs';
import { normalizeDailyReportMemory } from './daily-report-memory.mjs';
import { FEISHU_REACTION_CATALOG, normalizeFeishuReactionCandidates } from '../../lib/feishu-reaction-catalog.mjs';

const AMBIENT_SESSION_PROMPT = [
  'This Feishu group sends its main-timeline messages to your continuing Session, including messages without an @ mention.',
  'Read the recent group discussion and decide whether your participation helps. In active mode, a human-to-human question may receive a concise useful contribution when you have relevant evidence, can correct a material mistake, or can resolve an unanswered question. An @ mention of another person is context, not a blanket prohibition. Do not take over their assigned work without authorization. Before joining, assess the added value, evidence, duplication and interruption cost; retain a brief participationReason in your hidden response decision. Do not acknowledge every message in text.',
  'If the newest human message explicitly @ mentions you, give a text reply unless it explicitly asks you to stay silent. For other messages, join only when you have a clear, useful contribution. If you use tools or start work, finish with a visible result or an honest handoff; never end that turn with only a reaction or an empty final answer.',
  'A concrete unanswered question or request directed to the assistant needs a reply even without an @ mention. Do not mistake a useful question for ordinary chatter.',
  'Related links, forwarded records and corrections supplement the ongoing discussion. Read the referenced material and use it to answer the shared question. Per-input accountability does not mean one separate message per input: combine related answers using the accepted requestIds; answer independent questions separately. A final answer must incorporate relevant supplementary findings, even if a short interim reply was already sent. Do not start a new task or repeat tool work merely to satisfy another input receipt.',
  'A native sync confirmation updates the original question card; the transport returns the review result once. These are already visible receipts: do not add another acceptance-only final or copy the returned review. Keep required questions, new substantive answers and failures visible. Never present submitted, internal sync identifiers or routing packets as ordinary reply text.',
  'A message that only mentions you asks you to reconsider recent unanswered group messages together and reply. A mute signal is feedback that your previous participation may have been unwelcome. Treat feedback as context for your next judgment.',
].join('\n');

const TOPIC_SESSION_PROMPT = [
  'A Feishu topic is a continuing conversation. Preserve its existing task, participants and reply location.',
  'No repeated @ mention is required for a follow-up to your work. In active mode, distinguish a request to you from human-to-human discussion; contribute when you add relevant evidence or a useful answer.',
  'Reply to directed requests and substantive supplements; ordinary human-to-human chatter can remain silent. Assess added value, evidence, duplication and interruption cost and record participationReason when joining their discussion. Listening allows only a single explicit invitation; paused blocks ordinary input.',
  'Keep replies in the same topic.',
].join('\n');

const GROUP_SESSION_PROMPT = [
  'Every admitted human message on this Feishu group mainline reaches your Session, including messages without an @ mention.',
  'Use the discussion context to decide whether a reply or task is useful. A concrete unanswered question or request needs a reply; human-to-human conversation or an update needing no contribution may be left without visible text.',
].join('\n');

const QUICK_REACTION_SESSION_PROMPT = [
  'Reactions are optional. No temporary receipt or fallback emoji is added automatically.',
  'Select an optional reaction in the hidden feishu-response decision. Omit reaction to retain existing feedback; use reaction:null to explicitly withdraw this Bot’s reaction, including late quick feedback. A reaction never substitutes for a substantive answer or proves completion.',
].join('\n');

const JEV_REACTION_SESSION_PROMPT = [
  'The Feishu connector records each group message and forwards it to the Session model. Decide whether a useful text reply or task is needed from the full Session context; stay silent when no text contribution is needed, without treating a social reaction as a factual answer or task acceptance.',
  'Jev only selects an optional social reaction asynchronously. It never sends a substantive reply, accepts or starts work, opens a Thread, or chooses work placement. The main Session owns the complete handling of every admitted message, even when Jev succeeds: decide participation, reply location, whether to continue existing work, and the appropriate reaction. Its speed, failure or reaction choice cannot control your input or participation mode.',
  'Use the supplied reaction receipt snapshot when available; it is a point-in-time receipt, not proof of task acceptance or completion. Never wait or poll for Jev. If its existing reaction fits, retain that choice; if absent or unsuitable, make your own choice from the full context. For a directed request you answer or work you undertake, choose a reaction only when useful. For discussion needing no reaction, deliberately omit it; no forced emoji is added by code.',
  'Jev feedback and main-Session handling are one response workflow for the same source message. Do not send a second acknowledgement paragraph just because Jev reacted or failed. Check existing replies, handoffs and work before starting: a supplement joins that work, a delivered answer is not resent, and an accepted handoff is not executed again here. Follow the current input’s authorization for any work-Session transfer; selecting a Thread reply does not itself start a second worker.',
].join('\n');

const GROUP_TIMELINE_SESSION_PROMPT = [
  'This Session follows the shared Feishu group timeline. Reply location and execution placement are separate choices. Keep ongoing work and supplements in their established conversation.',
  'A substantial request does not itself authorize automatic new-topic routing. Continue authorized work here unless the human has selected another execution destination through the existing routing workflow. General automatic new-topic splitting is deferred.',
].join('\n');

const WORK_KICKOFF_SESSION_PROMPT = [
  'Only in active participation, when discussion has produced a concrete goal and executable plan, you may offer a discussion-to-work confirmation card. Judge the timing yourself from the discussion; do not use elapsed silence or an emoji as approval. Listening and paused modes do not offer this card.',
  'Use node "$REMOTELAB_PROJECT_ROOT/cli.js" work kickoff --file <absolute JSON path> --json with {action:"propose",sourceRequestId:"the actual accepted human input ID",goal,plan,sources,unresolved,acceptance}. Include agreed scope, original sources, remaining decisions (or none), and concrete acceptance. The registered project relationship determines the target work group.',
  'If the result has a question, pass its complete title and options unchanged to the native user-input tool. The choices are transfer to the work group and start, continue discussion, or defer. Only the server-verified human answer creates a real work topic and starts execution after delivery. Do not substitute work plan start or route new for this confirmation. A missing question means there is no new card to send. Do not repeat an unchanged proposal already awaiting a reply.',
  'Keep discussion and follow-ups here until the actual work topic is created. Reuse that work topic for subsequent supplements and results. This capability does not enable general automatic new-topic routing.',
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
  const topic = !privateChat && (isFeishuTopicChat(summary)
    || Boolean(buildFeishuTopicId(summary))
    || (['topic', 'thread'].includes(summary.conversationKind)
      && (summary.startThread !== true || group.jevReactions === true)));
  const groupMainline = !privateChat && !topic
    && [summary.chatType, summary.chatMode].some(value => String(value || '').toLowerCase() === 'group');
  const ambient = groupMainline && group.participationMode === 'ambient';
  const unified = (groupMainline || topic) && Boolean(group.initialParticipationMode) && group.participationControls !== false;
  const quickReactions = (groupMainline || topic) && group.quickReactions === true && !privateChat && (!topic || unified);
  const jevReactions = group.jevReactions === true && !privateChat && (ambient || unified);
  const candidates = normalizeFeishuReactionCandidates(group.reactionCandidates ?? (privateChat ? undefined : config.groupReactionCandidates));
  return {
    reactionCandidates: candidates,
    // Explicit mention-only and existing group policies take precedence.
    responseMode: group.participationMode === 'ambient' ? 'all' : group.responseMode
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
      !privateChat && (ambient || topic || quickReactions) ? `Optional reaction candidates: ${candidates.map(id => `${id} (${FEISHU_REACTION_CATALOG[id]})`).join(', ') || 'none'}. Omit reaction to retain it; reaction:null explicitly withdraws it.` : '',
      jevReactions ? JEV_REACTION_SESSION_PROMPT
        : quickReactions ? QUICK_REACTION_SESSION_PROMPT : '',
      ambient ? GROUP_TIMELINE_SESSION_PROMPT : '',
      (ambient || topic) && config.projectLinks?.some(link => link.discussionChatId === summary.chatId) ? WORK_KICKOFF_SESSION_PROMPT : '',
      (groupMainline || topic) ? FEISHU_RESPONSE_DECISION_PROMPT : '',
      ambient ? AMBIENT_SESSION_PROMPT : topic ? TOPIC_SESSION_PROMPT
        : groupMainline && group.responseMode === 'all' ? GROUP_SESSION_PROMPT : '']
      .filter(value => typeof value === 'string' && value.trim()).join('\n\n'),
  };
}
