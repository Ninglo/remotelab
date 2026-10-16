import { FEISHU_OUTCOME_REACTIONS, parseFeishuReactionDirective } from './feishu-reaction-directive.mjs';
import { stripHiddenBlocks } from './reply-selection.mjs';

// One model-authored decision accompanies the answer. The transport validates
// structure; it never infers which questions the prose answers.
export function readFeishuResponseDecision(value) {
  let text = String(value || '').trim();
  const decision = { specified: false, text };
  const canonical = /^<private>\s*feishu-response:([\s\S]*?)<\/private>/.exec(text);
  if (canonical) {
    decision.specified = true;
    text = text.slice(canonical[0].length).trim();
    try {
      const fields = JSON.parse(canonical[1]);
      validateFeishuResponseFields(fields);
      Object.assign(decision, fields);
    } catch (error) { decision.error = error.message; }
  } else {
    // Read old accepted turns through an adapter, including either prefix order.
    for (let i = 0; i < 2; i++) {
      const placement = /^<private>\s*feishu-reply:(inline|thread)\s*<\/private>/.exec(text);
      if (placement) { decision.replyMode = placement[1]; text = text.slice(placement[0].length).trim(); continue; }
      const reaction = parseFeishuReactionDirective(text);
      if (!reaction) break;
      if (reaction.invalid) decision.invalidReaction = true;
      else decision.reaction = reaction.emojiType;
      text = reaction.text;
    }
  }
  return { ...decision, text: stripHiddenBlocks(text) };
}

export function validateFeishuResponseFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Response decision must be an object');
  for (const key of Object.keys(fields)) {
    if (!['replyMode', 'requestIds', 'reaction', 'noTextReason', 'participationReason'].includes(key)) throw new Error(`Unknown response decision field: ${key}`);
  }
  if (fields.replyMode !== undefined && !['inline', 'thread'].includes(fields.replyMode)) throw new Error('replyMode must be inline or thread');
  if (fields.requestIds !== undefined && (!Array.isArray(fields.requestIds) || !fields.requestIds.length
      || fields.requestIds.some(id => typeof id !== 'string' || !id.trim())
      || new Set(fields.requestIds).size !== fields.requestIds.length)) throw new Error('Select distinct non-empty input IDs');
  if (fields.reaction !== undefined && fields.reaction !== null && !FEISHU_OUTCOME_REACTIONS.includes(fields.reaction)) throw new Error('Invalid Feishu reaction');
  if (fields.participationReason !== undefined && (typeof fields.participationReason !== 'string'
      || !fields.participationReason.trim() || fields.participationReason.length > 600)) throw new Error('Provide a brief participationReason');
  if (fields.noTextReason !== undefined && (typeof fields.noTextReason !== 'string'
      || !fields.noTextReason.trim() || fields.noTextReason.length > 600)) throw new Error('Provide a reason no text is needed');
}

export function normalizeFeishuResponsePayload(payload = {}, rawText = payload.text) {
  const decision = readFeishuResponseDecision(rawText);
  if (decision.error) throw new Error(decision.error);
  const text = rawText === payload.text ? decision.text : stripHiddenBlocks(payload.text);
  if (decision.noTextReason && (text || payload.attachments?.length)) throw new Error('Select content or a no-text decision');
  return { ...payload, text,
    ...(decision.reaction !== undefined ? { reaction: decision.reaction, reactionStage: 2 } : {}),
    ...(decision.invalidReaction ? { invalidReactionDirective: true } : {}),
  };
}

// Used by the group prompt and the execution prompt, rather than maintaining
// separate instructions for native finals and the work-reply tool.
export function buildFeishuResponseDecisionPrompt({ topicGroup = false } = {}) {
  return [
    "The main Session makes one response decision:",
    topicGroup ? "1. In this topic group, every human message is addressed to the Agent and needs a reply. Use normal conversation/steer; no participation gate." : "1. Decide from the full conversation: answer directed questions/requests and deliver undertaken work; join human discussion when useful, otherwise stay silent. Quick feedback never gates or accepts work.",
    "2. Combine pending questions, additions and corrections when useful, even across subjects. Do not wait to batch, repeat delivered answers/work, or delay an urgent independent answer.",
    "3. Use a thread for complex work, including lookup, research or execution, even for a short question. Follow the current input's thread-creation contract before working or replying: when it provides work route mode:new, create the bound independent Session first. Simple answers use inline: quote-reply in the main Session with only the answer, no opening or phase heading. Stay in an existing topic and its Session without requiring another @ mention. A replyMode marker alone never creates a Session.",
    'Before visible text: <private>feishu-response:{"replyMode":"thread"}</private> (inline|thread). Final requestIds names only accepted inputs answered together; omit for one root. A deliberate silent final uses noTextReason and no prose. When joining human discussion, participationReason briefly explains value and interruption cost.',
    "Optional reaction: allowed ID, omit to retain, null to withdraw. Your choice takes precedence over a late quick reaction. Get means received; completion needs evidence. The final commits answer, reaction and input receipts; do not register it again with work reply.",
  ].join('\n\n');
}

export const FEISHU_RESPONSE_DECISION_PROMPT = buildFeishuResponseDecisionPrompt();

// Response ownership is transport protocol, independent of personal routing
// experiments. Retain old accepted pilot records through the compatibility arm.
export function hasFeishuInputReplyContract(record) {
  return record?.options?.sourceContext?.feishuResponseProtocolVersion === 1
    || (record?.options?.routingPilotMainline === true && record.options.routingPilotMainlineProtocol === 2);
}
