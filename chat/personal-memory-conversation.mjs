import { getHistoryHeadSeq, loadHistory } from './history.mjs';
import { loadPersonalMemorySettings, personalMemoryPreference } from './personal-memory-settings.mjs';
import { loadLearningPolicy } from './memory-learning.mjs';
import { MEMORY_ABSTRACTION_GUIDANCE } from './memory-abstraction.mjs';

export async function buildPersonalMemoryConversationContext({ personId, identityId, sourceContext, sessionId } = {}) {
  if (['bot', 'app'].includes(sourceContext?.sender?.senderType)) return '';
  // Admission has already loaded the authenticated directory. Ordinary users
  // keep their pointer-only path and do not cause extra memory-policy reads.
  if (!personalMemoryPreference({ personId, identityId }).conversational) return '';
  try {
    const settings = await loadPersonalMemorySettings({ personId, identityId });
    if (!settings.available || !settings.conversational) return '';
    if (!settings.enabled) return `Personal memory is paused for current speaker ${personId}. Do not generate, retrieve or propose automated personal memories for this input. Existing history is not erased; do not inherit another speaker's enabled mode. Explicit current requests and separately maintained manual agreements still apply.`;
    const cards = sourceContext?.connector === 'feishu' && (await loadLearningPolicy()).reviewCardPersonIds?.includes(personId);
    const feedback = cards ? '' : await recentMemoryFeedback(sessionId, personId);
    return `Personal memory conversation trial is enabled for verified current speaker ${personId}, across Web and Feishu; never inherit the Session owner's preferences.
While doing the task, notice feedback about HOW to collaborate (explanations, initiative, interruptions, handoffs). One concrete signal is enough to consider a candidate now; repeated corrections deserve attention in this turn, not only after completion. Personal difficulty following your explanations can support an activity-scoped candidate even inside a project. Changes to an artifact’s layout, contents, location or product behavior stay with the project; repetition or labeling them observed does not make them personal. Reported repetition is not fabricated independent evidence.
${MEMORY_ABSTRACTION_GUIDANCE}
On a signal, use 'remotelab memory inspect --json' and compare meaning AND scope. Apply an identical confirmed preference without asking or writing it again. Preserve explicit accepted limits; propose supported additional scope separately. Do not mistake source context for an accepted limit. Memory never expands business authorization.
If an instruction could refer only to the current task, propose its future use; reported repetition alone does not confirm broader or long-term scope. Explicit long-term personal instructions: save as confirmed via 'memory apply' with original evidence, then briefly acknowledge the exact saved preference in the ordinary reply ONLY after success. Do not require proof of a long-term trait before asking whether a concrete personal signal should carry forward. Unclear future scope: record an observed habit and 'propose' with current version, exact question and evidence, ${cards ? 'the independent memory card will offer keep/edit/discard; do not ask the same question in the task reply or wait for a card answer.' : 'then append one natural observation-plus-question to the next useful answer this turn.'} Do not wait for the whole task to finish. Candidate, pending and confirmed are different states.
Read $REMOTELAB_PROJECT_ROOT/docs/memory-learning.md for write schemas. Resolve a pending proposal only after inspecting its unchanged meaning/scope and a clear owner decision; ambiguous “好/可以” or silence is not consent. Correct/narrow the same entry, withdraw a declined one. Pending suppresses duplicate questions; after version conflict inspect before retrying.
${cards ? 'Independent memory review cards are enabled here. New personal entries and proposals use the existing outbox automatically; never send a duplicate card yourself. Card responses update that memory only, without resuming, interrupting or steering the original task. No answer is not consent and never blocks the task. Keep task replies focused on the task.' : 'At most one short memory sentence per useful reply; no separate private message, card, reminder or scheduled digest.'} Do not manufacture signals, repeatedly announce unchanged memories, or expose private facts from elsewhere. ${cards ? 'If urgency/privacy prevents showing a card here, set deferReview:true on that memory update; keep the observation without a card. Later explicitly propose when appropriate.' : 'If urgency/privacy prevents asking, defer the proposal; keep only the observation.'} Failed writes are not saved memories. The Harness chooses appropriate timing and words.${feedback ? `\n${feedback}` : ''}`;
  } catch { return ''; }
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
