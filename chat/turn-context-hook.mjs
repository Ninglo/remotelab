import { buildLocalBridgePromptBlock } from './local-bridge-prompt.mjs';
import { buildSessionAgreementsPromptBlock } from './session-agreements.mjs';
import { buildSourceContextPrompt } from './source-context-prompt.mjs';
import { buildProjectMemoryPromptBlock } from './project-memory-runtime.mjs';
import { buildPersonMemoryPromptBlock } from './person-memory-context.mjs';
import { buildLearningContext } from './memory-learning.mjs';

function buildFeishuLogPromptBlock(sourceContext) {
  const target = sourceContext?.connector === 'feishu' ? sourceContext.feishuLog : null;
  if (!target || !/^[a-zA-Z0-9_-]{1,128}$/.test(target.sessionId || '')) return '';
  const sessionId = target.sessionId;
  const runId = /^run_[a-zA-Z0-9_-]+$/.test(target.runId || '') ? target.runId : '';
  const path = `/api/sessions/${sessionId}/langsmith?format=json${runId ? `&runId=${runId}` : ''}`;
  return [
    'This turn is a Feishu /log diagnostic in the existing Session. The connector fixed the target before this turn was submitted.',
    `Target Session: ${sessionId}. Prior Run: ${runId || 'none recorded'}. The current /log Run is not the target.`,
    `Follow the user's question verbatim. Verify any LangSmith link and upload status with the read-only GET ${path} endpoint before presenting it.`,
    runId ? `For local Run state, use the read-only GET /api/runs/${runId} endpoint if needed.` : 'If there is no prior Run, say so clearly.',
    'If the LangSmith response does not map the target Run, label any available link as a Session trace rather than that Run. Explain the relevant viewing or debugging steps. Do not upload traces or change configuration as part of /log.',
  ].join('\n');
}

export async function buildTurnContextHook(session = {}, { sourceContext, requestId, personId, identityId, query = '' } = {}) {
  return [
    buildLocalBridgePromptBlock(session),
    buildSessionAgreementsPromptBlock(session?.activeAgreements || []),
    buildFeishuLogPromptBlock(sourceContext),
    buildSourceContextPrompt(sourceContext, requestId),
    buildPersonMemoryPromptBlock({ personId, identityId }),
    await buildLearningContext({ personId, identityId, query: `${query}\n${sourceContext?.connector || ''}`,
      session, sourceContext }),
    await buildProjectMemoryPromptBlock(session, sourceContext),
    // Classifier summaries are derived UI state, not fresh execution evidence.
    // Keep them queryable on the session; do not replay stale blockers every turn.
  ].map((section) => String(section || '').trim()).filter(Boolean).join('\n\n');
}
