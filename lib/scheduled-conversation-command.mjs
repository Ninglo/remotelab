import { readFile } from 'node:fs/promises';
import { normalizeConversation } from './conversation-target.mjs';

// Both CLI entry points produce the same optional Session creation binding.
export async function scheduledConversationOptions(options) {
  const choices = [options.conversation !== undefined, !!options.conversationFile, options.sourceDelivery === true];
  if (choices.filter(Boolean).length > 1 || (choices.some(Boolean) && options.sourceDelivery === false)) {
    throw new Error('Choose one of --conversation, --conversation-file, --source-request or --no-source-delivery');
  }
  if (options.conversation === 'source' || options.sourceDelivery === true) {
    return { deliverTo: 'session_source', ...(options.sourceRequestId ? { sourceRequestId: options.sourceRequestId } : {}) };
  }
  const raw = options.conversationFile ? await readFile(options.conversationFile, 'utf8') : options.conversation;
  if (raw === undefined) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Invalid conversation JSON'); }
  const conversation = normalizeConversation(parsed);
  if (!conversation) throw new Error('Invalid conversation connector or target');
  return { conversation };
}
