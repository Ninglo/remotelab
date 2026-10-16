import { getHistoryHeadSeq, loadHistory } from './history.mjs';
import { loadPersonalMemorySettings, personalMemoryPreference } from './personal-memory-settings.mjs';
import { loadLearningPolicy } from './memory-learning.mjs';

export async function buildPersonalMemoryConversationParts({ personId, identityId, sourceContext, sessionId } = {}) {
  if (['bot', 'app'].includes(sourceContext?.sender?.senderType)) return { rules: '', feedback: '' };
  // Admission has already loaded the authenticated directory. Ordinary users
  // keep their pointer-only path and do not cause extra memory-policy reads.
  if (!personalMemoryPreference({ personId, identityId }).conversational) return { rules: '', feedback: '' };
  try {
    const settings = await loadPersonalMemorySettings({ personId, identityId });
    if (!settings.available || !settings.conversational) return { rules: '', feedback: '' };
    if (!settings.enabled) return { rules: `Personal memory is paused for current speaker ${personId}. Do not generate, retrieve or propose automated personal memories. Existing history remains; do not inherit another speaker's mode. Explicit requests and manual agreements still apply.`, feedback: '' };
    const cards = sourceContext?.connector === 'feishu' && (await loadLearningPolicy()).reviewCardPersonIds?.includes(personId);
    const feedback = cards ? '' : await recentMemoryFeedback(sessionId, personId);
    const rules = [
      `Personal memory conversation trial is enabled only for verified current speaker ${personId}; never inherit another person's preferences.`,
      'Notice concrete feedback about how to collaborate during the task; one signal can justify a candidate now. Product requirements and project decisions stay with their project. Memory never grants business authorization.',
      'Before extracting, proposing or changing memory, read the relevant guidance and write schema in $REMOTELAB_PROJECT_ROOT/docs/memory-learning.md, then use remotelab memory inspect --json. Compare meaning AND scope; preserve original evidence, accepted limits and the strength of the person’s words.',
      'Explicit personal long-term instructions may be confirmed; unclear future scope stays observed and may be proposed now. Silence or ambiguous replies are not consent. Pending proposals suppress duplicate questions. Only report a save after success.',
      cards ? 'Independent memory review cards are enabled: use the existing memory outbox, do not duplicate its question in chat or wait for a decision to continue the task. Defer review when urgency or privacy requires it.'
        : 'No independent review cards: after recording propose, ask at most one natural memory question in the next useful reply. Keep the task moving; defer when urgency or privacy requires it.',
    ].join('\n');
    return { rules, feedback };
  } catch { return { rules: '', feedback: '' }; }
}

// Compatibility reader; the manager delivers stable rules separately from new feedback.
export async function buildPersonalMemoryConversationContext(options = {}) {
  const { rules, feedback } = await buildPersonalMemoryConversationParts(options);
  return [rules, feedback].filter(Boolean).join('\n');
}

// Bounded, same-topic pointers only. A foreground context boundary prevents
// replaying this opportunity every turn; it is NOT a user-delivery receipt.
export function selectRecentMemoryFeedback(events, personId) {
  const selected = new Map();
  for (const event of [...events].reverse()) {
    if (event.type === 'manager_context') break;
    if (event.type !== 'context_operation' || event.operation !== 'write_memory'
        || event.trigger !== 'automatic' || event.phase !== 'applied'
        || event.learningOwnerPersonId !== personId) continue;
    for (const result of event.learningResults || []) {
      if (!result.changed || !result.path?.endsWith(`/reference/people/${personId}.md`)
          || !/^mem_[a-f0-9]{16}$/.test(result.id || '') || !Number.isSafeInteger(result.version)
          || !['confirmed', 'withdrawn'].includes(result.status)) continue;
      if (!selected.has(result.id)) selected.set(result.id, { id: result.id, version: result.version,
        status: result.status, sourceEventSeq: event.learningSourceEventSeq });
      if (selected.size === 3) return [...selected.values()];
    }
  }
  return [...selected.values()];
}

async function recentMemoryFeedback(sessionId, personId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId || '')) return '';
  try {
    const head = await getHistoryHeadSeq(sessionId);
    const events = await loadHistory(sessionId, { fromSeq: Math.max(1, head - 63), toSeq: head, includeBodies: false });
    const pointers = selectRecentMemoryFeedback(events, personId);
    if (!pointers.length) return '';
    return 'Background memory writes from this speaker in this topic, after the last foreground context (pointers, not delivery or acceptance): '
      + JSON.stringify(pointers)
      + '. Inspect current entries before use. If still applicable and not already explained here, add one short natural sentence: acknowledge the still-confirmed save or withdrawal. Do not announce candidates as confirmed, repeat a pending question, expose unrelated profile content, or send a separate message. This opportunity may be deferred; no delivery is claimed.';
  } catch { return ''; }
}
