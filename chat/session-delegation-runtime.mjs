import { resolveSessionRuntimeSelection } from './session-runtime-selection.mjs';

export async function resolveDelegationRuntime(source, payload, getRun) {
  const requestedRunId = typeof payload.sourceRunId === 'string' ? payload.sourceRunId.trim() : '';
  const runId = requestedRunId || source.activity?.run?.runId || source.activeRunId;
  const run = runId ? await getRun(runId) : null;
  if (requestedRunId && (!run || run.sessionId !== source.id)) {
    throw new Error('sourceRunId must identify a run in the source session');
  }
  // An invoking run owns its accepted configuration even when the UI changes
  // the source session's next-turn preferences while that run is working.
  const saved = run?.sessionId === source.id ? run : source.feishuRuntimeSelection || source;
  const tool = typeof payload.tool === 'string' ? payload.tool.trim() : '';
  return resolveSessionRuntimeSelection(saved, tool ? { tool } : {});
}
