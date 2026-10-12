import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONFIG_DIR } from '../../lib/config.mjs';
import { resolveFeishuGroupSettings } from './group-settings.mjs';
import { isFeishuBotSender } from './response-policy.mjs';
import { FEISHU_SOCIAL_REACTION_CRITERIA } from '../../lib/feishu-reaction-catalog.mjs';

const MAX_MESSAGES = 20;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CONTEXT_CHARACTERS = 5_000;
const REACTION_TIMEOUT_MS = 1_600;
const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
const REACTION_MODEL = 'gpt-6-luna';
export function buildFeishuSessionReactionContext(recent, { mentioned = false } = {}) {
  const lines = (Array.isArray(recent) ? recent : []).map(entry =>
    `${new Date(entry.time || Date.now()).toISOString()} ${entry.sender || '群成员'}: ${String(entry.text || '').slice(0, 1200)}`);
  const selected = [];
  let characters = 0;
  for (const line of lines.reverse()) {
    if (selected.length && characters + line.length > MAX_CONTEXT_CHARACTERS) break;
    selected.push(line);
    characters += line.length;
  }
  const ordered = selected.reverse();
  if (ordered.length) ordered[ordered.length - 1] = `NEWEST MESSAGE TO CLASSIFY: ${ordered[ordered.length - 1]}`;
  return [`You are the assistant in this ongoing Feishu group. Classify only the NEWEST MESSAGE below; older lines are context, not pending requests to answer. Assistant mentioned in newest message: ${mentioned}.`,
    ...ordered].join('\n');
}

function messageTime(summary) {
  const value = Number(summary?.createTime);
  return Number.isFinite(value) && value > 0
    ? (value < 10_000_000_000 ? value * 1000 : value)
    : Date.now();
}

function conversationKey(summary) {
  return `${summary.chatId}:${summary.threadId || summary.topicId || (summary.conversationKind === 'thread' ? summary.rootId || '' : '') || 'main'}`;
}

function isPilotHumanMessage(runtime, summary) {
  if (summary?.sourceKind || summary?.chatType !== 'group' || !summary?.chatId || !summary?.messageId) return false;
  if (isFeishuBotSender(summary)) return false;
  if (runtime.botIdentity?.openId && summary.sender?.openId === runtime.botIdentity.openId) return false;
  const settings = resolveFeishuGroupSettings(runtime.config, summary);
  return settings.quickReactions === true && settings.jevReactions !== true;
}

function textOf(summary) {
  const text = String(summary?.messageText || summary?.textPreview || summary?.contentSummary || '').trim();
  return text.slice(0, 1_200) || `[${summary?.messageType || '消息'}]`;
}

function parseKeyFile(content) {
  const line = String(content).split(/\r?\n/).find(value => /^\s*TYPESAFE_API_KEY\s*=/.test(value));
  return line?.replace(/^\s*TYPESAFE_API_KEY\s*=\s*/, '').replace(/^['"]|['"]$/g, '').trim() || '';
}

export async function feishuJevApiKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  const file = process.env.TYPESAFE_KEY_FILE?.trim() || join(CONFIG_DIR, 'typesafe.env');
  return parseKeyFile(await readFile(file, 'utf8').catch(() => ''));
}

export async function feishuReactionApiKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  const file = process.env.OPENAI_KEY_FILE?.trim() || join(CONFIG_DIR, 'openai.env');
  const content = await readFile(file, 'utf8').catch(() => '');
  const line = content.split(/\r?\n/).find(value => /^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(value));
  return line?.replace(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*/, '').trim().replace(/^['"]|['"]$/g, '').trim() || '';
}

// Compatibility export name and group opt-in stay unchanged; only the social
// reaction provider changes. The legacy handoff verifier retains its own key.
// https://developers.openai.com/api/docs/guides/decisions
export async function classifyFeishuQuickParticipation(context, {
  fetchImpl = fetch, key, timeoutMs = REACTION_TIMEOUT_MS,
} = {}) {
  const token = key || await feishuReactionApiKey();
  if (!token) return { emojiType: null, reason: 'missing_key', latencyMs: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(DECISIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: REACTION_MODEL, input: context, questions: [{
          type: 'choice', name: 'reaction',
          instructions: 'Choose one fitting social reaction to the NEWEST message, or none. Older messages only clarify its recipient and tone. Do not answer factual questions, decide whether to reply, choose a work Session, infer permission, or change participation mode. Get only acknowledges receipt; it does not accept a task or prove handoff or completion. Praise, thanks, humor, criticism and empathy can use different reactions. Never laugh at bad news or misfortune. Neutral human-to-human updates and ambiguous tone need none.',
          choices: Object.entries({ ...FEISHU_SOCIAL_REACTION_CRITERIA, Get: 'Received the message; no task acceptance or completion claim.',
            none: 'No fitting social reaction is needed or sufficiently supported.' })
            .map(([value, description]) => ({ value, description })),
      }] }),
      signal: controller.signal,
    });
    if (!response.ok) return { emojiType: null, reason: `http_${response.status}`, latencyMs: Math.round(performance.now() - started) };
    const result = await response.json();
    const answer = Array.isArray(result?.answers)
      ? result.answers.find(item => item?.name === 'reaction' && item.type === 'choice') : null;
    const choice = answer?.choice;
    const probability = Array.isArray(answer?.probabilities)
      ? answer.probabilities.find(item => item?.value === choice)?.probability : undefined;
    const valid = choice === 'none' || Object.hasOwn(FEISHU_SOCIAL_REACTION_CRITERIA, choice || '');
    const supported = valid && Number.isFinite(probability) && probability >= 0.8 && probability <= 1;
    return { emojiType: supported && choice !== 'none' ? choice : null,
      ...(!supported ? { reason: 'low_support' } : {}),
      model: result.model || '', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { emojiType: null, reason: error?.name === 'AbortError' ? 'timeout' : 'request_error',
      latencyMs: Math.round(performance.now() - started) };
  } finally { clearTimeout(timer); }
}

export function createFeishuQuickParticipationPilot(runtime, {
  react,
  logPath = join(runtime.config.storageDir, 'quick-participation.jsonl'),
} = {}) {
  const history = new Map();
  const seen = new Set();
  const readReceipts = new Map();

  function remember(summary) {
    if (!isPilotHumanMessage(runtime, summary)) return null;
    const at = messageTime(summary);
    const item = {
      id: summary.messageId,
      at,
      sender: String(summary.sender?.openId || summary.sender?.userId || 'person').slice(-12),
      text: textOf(summary),
    };
    const key = conversationKey(summary);
    const previous = history.get(key) || [];
    const next = [...previous.filter(entry => entry.id !== item.id && at - entry.at <= MAX_AGE_MS), item]
      .slice(-MAX_MESSAGES);
    history.set(key, next);
    return next;
  }

  function rememberBotReply(target, messageId, text, threadId = '') {
    if (!messageId || !text) return;
    if (runtime.config.groups?.[target.chatId]?.quickReactions !== true) return;
    const key = conversationKey({ ...target, ...(threadId ? { threadId } : {}) });
    const previous = history.get(key) || [];
    history.set(key, [...previous.filter(entry => entry.id !== messageId), {
      id: messageId, at: Date.now(), sender: 'assistant', text: String(text).slice(0, 1_200),
    }].slice(-MAX_MESSAGES));
  }

  function seedConversation(summary, messages) {
    if (!Array.isArray(messages)) return;
    const key = conversationKey(summary);
    history.set(key, messages.map((message, index) => ({
      id: message.messageId || `history-${index}`,
      at: message.timestamp || Date.now(),
      sender: message.senderType === 'app'
        ? (message.senderId === runtime.config.appId ? 'assistant' : `bot:${message.sender || 'other'}`)
        : message.sender || 'person',
      text: String(message.text || '').slice(0, 1_200),
    })).filter(message => message.text).slice(-MAX_MESSAGES));
  }

  async function restore(eventsPath, { shouldRemember = async () => true } = {}) {
    const content = await readFile(eventsPath, 'utf8').catch(() => '');
    const now = Date.now();
    const active = new Map();
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.allowed && now - messageTime(event.summary) <= MAX_AGE_MS
          && await shouldRemember(event.summary)
          && remember(event.summary)) active.set(conversationKey(event.summary), event.summary);
      } catch { /* A partial final log line is ignored. */ }
    }
    return [...active.values()];
  }

  function handle(summary, { receivedAt = performance.now(), reactionMode = 'normal' } = {}) {
    const recent = remember(summary);
    if (!recent || seen.has(summary.messageId)) return;
    seen.add(summary.messageId);
    if (seen.size > 5_000) seen.delete(seen.values().next().value);
    const started = receivedAt;
    // Start the read receipt before any classification or Session work.
    const readReaction = reactionMode === 'none'
      ? Promise.resolve({ result: 'skipped', latencyMs: null, reactionId: '' })
      : (async () => {
        const receipt = await react(summary, 'THINKING');
        if (!receipt?.reactionId) throw new Error('Feishu did not return a reaction ID');
        return { result: 'ok', latencyMs: Math.round(performance.now() - started),
          reactionId: receipt.reactionId };
      })().catch(() => ({ result: 'failed', latencyMs: Math.round(performance.now() - started), reactionId: '' }));
    readReceipts.set(summary.messageId, readReaction);
    if (readReceipts.size > 5_000) readReceipts.delete(readReceipts.keys().next().value);
    return (async () => {
      const readReceipt = await readReaction;
      const record = {
        at: new Date().toISOString(), chatId: summary.chatId, messageId: summary.messageId,
        reactionMode,
        totalLatencyMs: Math.round(performance.now() - started),
        readReaction: readReceipt.result, readLatencyMs: readReceipt.latencyMs,
      };
      await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8').catch(error => {
        console.warn(`[feishu-quick-participation] failed to record ${summary.messageId}: ${error.message}`);
      });
      console.log(`[feishu-quick-participation] ${summary.messageId} receipt total=${record.totalLatencyMs}ms`);
    })().catch(error => console.warn(`[feishu-quick-participation] ${summary.messageId}: ${error.message}`));
  }

  return {
    handle, rememberBotReply, restore, seedConversation,
    waitForReadReceipt: messageId => readReceipts.get(messageId) || Promise.resolve(null),
  };
}
