import { buildLocalBridgePromptBlock } from './local-bridge-prompt.mjs';
import { buildSessionAgreementsPromptBlock } from './session-agreements.mjs';
import { buildSourceContextPrompt } from './source-context-prompt.mjs';

export async function buildTurnContextHook(session = {}, { sourceContext, requestId } = {}) {
  return [
    buildLocalBridgePromptBlock(session),
    buildSessionAgreementsPromptBlock(session?.activeAgreements || []),
    buildSourceContextPrompt(sourceContext, requestId),
    // Classifier summaries are derived UI state, not fresh execution evidence.
    // Keep them queryable on the session; do not replay stale blockers every turn.
  ].map((section) => String(section || '').trim()).filter(Boolean).join('\n\n');
}
