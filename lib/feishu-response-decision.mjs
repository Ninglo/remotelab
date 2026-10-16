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
      || fields.requestIds.length > 8 || fields.requestIds.some(id => typeof id !== 'string' || !id.trim())
      || new Set(fields.requestIds).size !== fields.requestIds.length)) throw new Error('Select 1–8 distinct input IDs');
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
export const FEISHU_RESPONSE_DECISION_PROMPT = [
  "Choose participation, reply location and the inputs answered together before the opening. Keep an existing topic; mainline replies stay inline unless a new topic is authorized. Reply location does not authorize a worker.",
  "Prefix visible text with <private>feishu-response:{\"replyMode\":\"thread\"}</private>. replyMode: inline|thread. Optional reaction: an allowed ID, omitted to retain feedback, or null to withdraw it. When joining human discussion include participationReason (value, evidence, interruption cost).",
  "Final requestIds identify only accepted inputs actually answered together; omit for one root input. For a deliberate no-text decision, include noTextReason and no visible prose. Transferred inputs retain their owner. Answer related supplements together and independent questions as needed.",
  "The final commits text, reaction and receipts together; never also call work reply for the same answer. That tool is only for immediate separate answers. Your reaction takes precedence over a late quick reaction; Get means received, completion needs evidence. Reactions never replace answers or unfinished work.",
].join('\n\n');

// Response ownership is transport protocol, independent of personal routing
// experiments. Retain old accepted pilot records through the compatibility arm.
export function hasFeishuInputReplyContract(record) {
  return record?.options?.sourceContext?.feishuResponseProtocolVersion === 1
    || (record?.options?.routingPilotMainline === true && record.options.routingPilotMainlineProtocol === 2);
}
