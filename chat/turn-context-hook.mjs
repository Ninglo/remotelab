import { ensureDir } from './fs-utils.mjs';
import { renderPromptAsset } from './prompt-asset-loader.mjs';
import { buildLocalBridgePromptBlock } from './local-bridge-prompt.mjs';
import { buildPromptPathMap, MODEL_CONTEXT_DIR } from './prompt-paths.mjs';
import { buildSessionAgreementsPromptBlock } from './session-agreements.mjs';
import { buildTaskCardPromptBlock } from './session-task-card.mjs';

const TURN_CONTEXT_HOOK_ASSET = 'turn/context-hook.md';

export async function buildTurnContextHook(session = {}) {
  await ensureDir(MODEL_CONTEXT_DIR);
  return [
    await renderPromptAsset(TURN_CONTEXT_HOOK_ASSET, buildPromptPathMap()),
    buildLocalBridgePromptBlock(session),
    buildSessionAgreementsPromptBlock(session?.activeAgreements || []),
    buildTaskCardPromptBlock(session?.taskCard),
  ].map((section) => String(section || '').trim()).filter(Boolean).join('\n\n');
}
