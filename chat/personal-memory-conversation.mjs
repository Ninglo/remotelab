import { loadPersonalMemorySettings, personalMemoryPreference } from './personal-memory-settings.mjs';

export async function buildPersonalMemoryConversationContext({ personId, identityId, sourceContext } = {}) {
  if (['bot', 'app'].includes(sourceContext?.sender?.senderType)) return '';
  // Admission has already loaded the authenticated directory. Ordinary users
  // keep their pointer-only path and do not cause extra memory-policy reads.
  if (!personalMemoryPreference({ personId, identityId }).conversational) return '';
  try {
    const settings = await loadPersonalMemorySettings({ personId, identityId });
    if (!settings.available || !settings.conversational) return '';
    if (!settings.enabled) return `Personal memory is paused for current speaker ${personId}. Do not generate, retrieve or propose automated personal memories for this input. Existing history is not erased; do not inherit another speaker's enabled mode. Explicit current requests and separately maintained manual agreements still apply.`;
    return `Personal memory conversation trial is enabled for current speaker ${personId}. This choice follows the verified sender across Web and Feishu private, group and topic inputs, never the Session owner or another participant.
Answer the current task first. When actual collaboration reveals a useful personal pattern, distinguish it from a product/project requirement and compare relevant existing memories by meaning. Use 'remotelab memory inspect --json' only when there is a concrete signal to check, not on every message. Observations and inferred candidates are not confirmed defaults.
When the observation is well supported, relevant here and not already confirmed or pending, append at most one short, natural sentence to the ordinary answer, for example: “我观察到你在理解新概念时更容易从熟悉的例子入手，要不要把这点记下来？” This is an example, not evidence about this person. No separate private message, card, questionnaire, reminder or scheduled digest. Do not interrupt urgent work or manufacture a memory question for every reply. In a shared conversation, do not reveal private facts or quotes learned elsewhere; defer if the observation cannot be discussed safely in this conversation.
Before asking, record the existing candidate with 'memory apply' action 'propose', its key/kind, expectedVersion, the exact question, and current user evidence. Create a justified habit observation first if needed. A pending proposal suppresses repeat questions across this person's conversations; another concurrent writer may reject your stale version, in which case do not ask again. Recording a proposal is not delivery or acceptance. Keep the full candidate meaning and scope; the sentence must not broaden it.
When this person clearly asks to retain that specific meaning, use the existing explicit revision workflow to confirm it; a vague “好/可以” with multiple possible referents is insufficient. If they narrow or correct it, update the same entry with evidence; if they decline, withdraw it. Inspect the entry's proposal and scope before resolving it, and do not confirm a proposal that changed since it was asked. Silence leaves it pending; do not chase. Direct instructions such as “以后请这样称呼我” already authorize that personal preference and need no extra question. The native Harness remains responsible for whether and how to ask.`;
  } catch { return ''; }
}
