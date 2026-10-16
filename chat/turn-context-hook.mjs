import { deliveryReviewPrompt } from './delivery-review.mjs';
import { buildGroupRoutingContext } from './group-routing.mjs';
import { buildLocalBridgePromptBlock } from './local-bridge-prompt.mjs';
import { buildSessionAgreementsPromptBlock } from './session-agreements.mjs';
import { buildSourceContextPrompt } from './source-context-prompt.mjs';
import { buildProjectMemoryPromptBlock } from './project-memory-runtime.mjs';
import { buildProjectWorkDirectoryPrompt } from './project-work-directory.mjs';
import { buildPersonMemoryPromptBlock } from './person-memory-context.mjs';
import { buildPersonalMemoryConversationParts } from './personal-memory-conversation.mjs';
import { experimentBackground } from './feature-experiment-context.mjs';
import { buildWebTopicDiscoveryPrompt } from './project-topic-context.mjs';

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

export async function buildTurnContextHook(session = {}, { sourceContext, requestId, personId, identityId, query = '', experimentInput = {}, pilotInputReplyContract = false, messageRoutingPolicy, separateProjectContext = false } = {}) {
  // Ordinary turns carry accepted source/state and small identity/project
  // pointers. The Harness chooses explicit work/memory reads for its task;
  // only an explicitly enrolled experiment may restore automatic background.
  const sections = await Promise.allSettled([
    buildProjectMemoryPromptBlock(session, sourceContext),
    buildGroupRoutingContext(session, sourceContext, { inputReplyContract: pilotInputReplyContract, messageRoutingPolicy }),
    buildProjectWorkDirectoryPrompt(session, sourceContext),
  ]);
  const [project, groupRouting, directory] = sections.map((result, index) => result.status === 'fulfilled'
    ? result.value : 'Context source unavailable: ' + JSON.stringify({ kind: ['project', 'group-routing', 'project-directory'][index], reason: result.reason.message }));
  const personalMemory = !experimentInput.automated
    ? await buildPersonalMemoryConversationParts({ personId, identityId, sourceContext, sessionId: session.id })
    : { rules: '', feedback: '' };
  const sectionsBeforeProject = [
    buildLocalBridgePromptBlock(session),
    buildSessionAgreementsPromptBlock(session?.activeAgreements || []),
    buildFeishuLogPromptBlock(sourceContext),
    buildSourceContextPrompt(sourceContext, requestId),
    buildPersonMemoryPromptBlock({ personId, identityId }),
    ...(!separateProjectContext ? [personalMemory.rules] : []),
    personalMemory.feedback,
  ];
  const sectionsAfterProject = [
    await buildWebTopicDiscoveryPrompt(session, { sourceContext: experimentInput.baselineSourceContext || sourceContext,
      automated: experimentInput.automated }),
    await experimentBackground(session, { ...experimentInput, sourceContext, requestId, personId, identityId, query }),
    groupRouting,
    await deliveryReviewPrompt(session, sourceContext),
    // Classifier summaries are derived UI state, not fresh execution evidence.
    // Keep them queryable on the session; do not replay stale blockers every turn.
  ];
  const render = parts => parts.map(section => String(section || '').trim()).filter(Boolean).join('\n\n');
  // Keep the public text-only reader compatible. The input assembler can put
  // the complete project block in the existing acknowledged/recoverable slots.
  return separateProjectContext
    ? { project, directory, personalMemory: personalMemory.rules, text: render([...sectionsBeforeProject, ...sectionsAfterProject]) }
    : render([...sectionsBeforeProject, project, directory, ...sectionsAfterProject]);
}
