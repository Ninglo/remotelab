import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONFIG_DIR } from '../../lib/config.mjs';
import { resolveFeishuGroupSettings } from './group-settings.mjs';
import { isFeishuBotSender, mentionsFeishuBot } from './response-policy.mjs';

const MAX_MESSAGES = 20;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CONTEXT_CHARACTERS = 5_000;
const JEV_TIMEOUT_MS = 1_600;
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-1.13.0';

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
  return resolveFeishuGroupSettings(runtime.config, summary).quickReactions === true;
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

export async function classifyFeishuQuickParticipation(context, { fetchImpl = fetch, key, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  const token = key || await feishuJevApiKey();
  if (!token) return { decision: 'unknown', reason: 'missing_key', latencyMs: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(process.env.TYPESAFE_BASE_URL || JEV_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: { discussion: context },
        questions: {
          participation: {
            type: 'choice',
            instructions: 'Decide whether the Feishu group assistant should send a useful reply to the newest message now. Read the whole recent discussion. Choose reply for a direct request to the assistant, an actionable correction or update to its current work, or a concrete contribution the assistant can make now. Choose silent for human-to-human conversation, acknowledgements, status reports without a request, repeated information, or a question already answered. A bare mention asks you to reconsider the preceding unanswered discussion. Do not treat every group message as a request. Judge the newest message in context, including Chinese text.',
            criteria: {
              reply: 'The assistant should respond or act now; silence would miss a clear request or useful contribution.',
              silent: 'The assistant should stay silent now while retaining this message as context for later messages.',
            },
          },
          projectHandoff: {
            type: 'choice',
            instructions: 'Decide whether the newest human message, in its recent discussion, clearly says a concrete direction has been settled and asks or strongly implies that the project work group should now start execution. Offer only for a specific actionable piece of work with an affirmative start signal. A question, tentative idea, ordinary status, human acknowledgement, or work already underway is not enough. This only nominates a proposal for a second check; it does not authorize execution.',
            criteria: {
              offer: 'A concrete direction is settled and the group now wants work to begin or be handed off.',
              none: 'There is no clear new work handoff decision in the newest message.',
            },
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { decision: 'unknown', reason: `http_${response.status}`, latencyMs: Math.round(performance.now() - started) };
    const result = await response.json();
    const answer = result?.answers?.participation;
    const decision = answer?.choice;
    if (!['reply', 'silent'].includes(decision)) throw new Error('invalid_choice');
    const replyProbability = Number(answer?.probabilities?.reply);
    const silentProbability = Number(answer?.probabilities?.silent);
    if (!Number.isFinite(replyProbability) || !Number.isFinite(silentProbability)
      || Math.abs(replyProbability + silentProbability - 1) > 0.03) throw new Error('invalid_probabilities');
    const uncertain = decision === 'reply' ? replyProbability < 0.7 : silentProbability < 0.85;
    const handoff = result?.answers?.projectHandoff;
    const offerProbability = Number(handoff?.probabilities?.offer);
    const handoffDecision = handoff?.choice === 'offer' && Number.isFinite(offerProbability)
      && offerProbability >= 0.9 ? 'offer' : 'none';
    return {
      decision: uncertain ? 'unknown' : decision,
      handoffDecision,
      handoffProbability: Number.isFinite(offerProbability) ? offerProbability : null,
      ...(uncertain ? { reason: 'low_support' } : {}),
      confidence: Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : null,
      probabilities: answer.probabilities || null,
      model: result.model || '',
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return { decision: 'unknown', reason: error?.name === 'AbortError' ? 'timeout' : 'request_error', latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

export function createFeishuQuickParticipationPilot(runtime, {
  classify = classifyFeishuQuickParticipation,
  react,
  onHandoffCandidate = null,
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

  async function restore(eventsPath) {
    const content = await readFile(eventsPath, 'utf8').catch(() => '');
    const now = Date.now();
    const active = new Map();
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.allowed && now - messageTime(event.summary) <= MAX_AGE_MS
          && remember(event.summary)) active.set(conversationKey(event.summary), event.summary);
      } catch { /* A partial final log line is ignored. */ }
    }
    return [...active.values()];
  }

  function contextFor(summary, recent) {
    const lines = recent.map(item => `${new Date(item.at).toISOString()} ${item.sender}: ${item.text}`);
    const selected = [];
    let length = 0;
    for (const line of lines.reverse()) {
      if (selected.length && length + line.length > MAX_CONTEXT_CHARACTERS) break;
      selected.push(line);
      length += line.length;
    }
    return [
      `You are the assistant in this ongoing Feishu conversation. The newest message is the last line. Assistant mentioned in newest message: ${mentionsFeishuBot(runtime, summary)}.`,
      ...selected.reverse(),
    ].join('\n');
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
    const decision = classify(contextFor(summary, recent));
    return (async () => {
      const verdict = await decision.catch(() => ({ decision: 'unknown', reason: 'request_error' }));
      // A direct @ is an explicit request for a text turn. Keep the early
      // reaction consistent with that routing even if the fast classifier errs.
      const participationDecision = mentionsFeishuBot(runtime, summary) ? 'reply' : verdict.decision;
      if (verdict.handoffDecision === 'offer' && typeof onHandoffCandidate === 'function') {
        void Promise.resolve().then(() => onHandoffCandidate(summary)).catch(error => {
          console.warn(`[feishu-quick-participation] handoff candidate ${summary.messageId}: ${error?.message || error}`);
        });
      }
      const readReceipt = await readReaction;
      const record = {
        at: new Date().toISOString(), chatId: summary.chatId, messageId: summary.messageId,
        reactionMode,
        decision: participationDecision, reason: verdict.reason || '', confidence: verdict.confidence ?? null,
        handoffDecision: verdict.handoffDecision || 'none',
        handoffProbability: verdict.handoffProbability ?? null,
        probabilities: verdict.probabilities || null, model: verdict.model || '',
        jevLatencyMs: verdict.latencyMs ?? null, totalLatencyMs: Math.round(performance.now() - started),
        readReaction: readReceipt.result, readLatencyMs: readReceipt.latencyMs,
      };
      await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8').catch(error => {
        console.warn(`[feishu-quick-participation] failed to record ${summary.messageId}: ${error.message}`);
      });
      console.log(`[feishu-quick-participation] ${summary.messageId} ${record.decision} jev=${record.jevLatencyMs}ms total=${record.totalLatencyMs}ms`);
    })().catch(error => console.warn(`[feishu-quick-participation] ${summary.messageId}: ${error.message}`));
  }

  return {
    handle, rememberBotReply, restore, seedConversation,
    waitForReadReceipt: messageId => readReceipts.get(messageId) || Promise.resolve(null),
  };
}
