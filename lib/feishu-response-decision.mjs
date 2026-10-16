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
    "The main Session makes one response decision from the full conversation:",
    topicGroup ? "1. In a native Feishu topic group, every human message is addressed to the Agent and needs a reply. Follow the Harness normal conversation and steer behavior for new input; combine pending inputs where useful. There is no participation-mode or preliminary participation decision here." : "1. Decide whether to reply. A concrete unanswered question or request directed to the assistant needs a reply unless asked to stay silent; contribute to human-to-human discussion when you add useful evidence or an answer, otherwise stay silent. If you undertake work, deliver its result. Optional quick feedback is only a preliminary social judgment; it never gates your decision or accepts work.",
    "2. Answer pending inputs together when useful. Incorporate new questions, links and corrections into one response, including several compatible matters. Do not split replies merely because inputs have separate IDs or subjects. Answer a time-sensitive independent question immediately when needed; do not repeat answers or work already delivered or handed off. Use inputs already received, without waiting for a batching timer.",
    "3. Use a thread for complex work or discussion that needs continued follow-up; a brief exchange can stay inline. Keep an existing topic and its ongoing work together. Choosing a thread reply is available directly and does not create a worker or transfer work to another Session or group.",
    "Before visible text, prefix <private>feishu-response:{\"replyMode\":\"thread\"}</private> (inline|thread). In the final, requestIds lists the accepted inputs actually answered together; omit it for one root input. A deliberate silent final uses noTextReason and no visible prose. When joining human discussion, briefly record participationReason (added value and interruption cost).",
    "Optional reaction is an allowed ID, omitted to retain feedback, or null to withdraw it; your reaction takes precedence over a late quick reaction. Get means received, completion needs evidence. The final commits content, reaction and input receipts together. Use work reply only for an immediate separate answer; never register the same final again.",
  ].join('\n\n');
}

export const FEISHU_RESPONSE_DECISION_PROMPT = buildFeishuResponseDecisionPrompt();

// Response ownership is transport protocol, independent of personal routing
// experiments. Retain old accepted pilot records through the compatibility arm.
export function hasFeishuInputReplyContract(record) {
  return record?.options?.sourceContext?.feishuResponseProtocolVersion === 1
    || (record?.options?.routingPilotMainline === true && record.options.routingPilotMainlineProtocol === 2);
}
