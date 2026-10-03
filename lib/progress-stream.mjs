import { collectAssistantSurfaceMessages } from './assistant-surface-messages.mjs';

// A display stream, never a task, acceptance list or inferred work completion.
export function projectProgressStreams(history = [], excludedSeqs = new Set()) {
  const surfaces = collectAssistantSurfaceMessages(history);
  const streams = new Map();
  let turn = '';
  for (const event of history) {
    if (event.type === 'message' && event.role === 'user') turn = `turn_${event.seq}`;
    const key = event.runId || turn;
    const surface = surfaces.get(event);
    if (surface?.surfaceKind === 'progress' && !excludedSeqs.has(event.seq)) {
      const previous = streams.get(key);
      const progress = { seq: event.seq, runId: event.runId, content: surface.content };
      const update = { seq: event.seq, progress, executionState: 'running' };
      streams.set(key, { taskId: `progress_${key}`, progressOnly: true,
        runId: event.runId, anchorSeq: previous?.anchorSeq || event.seq,
        latestSeq: event.seq, progress, content: '', executionState: 'running',
        progressHistory: [...(previous?.progressHistory || []), progress],
        updates: [...(previous?.updates || []), update] });
    }
    const previous = streams.get(key);
    if (!previous || event.type !== 'status') continue;
    const state = event.content === 'completed' ? 'ended' : event.content === 'cancelled' ? 'cancelled'
      : String(event.content).startsWith('error:') ? 'failed' : '';
    if (state) streams.set(key, { ...previous, executionState: state, latestSeq: event.seq,
      updates: [...previous.updates, { seq: event.seq, progress: previous.progress, executionState: state }] });
  }
  return [...streams.values()];
}

export function progressExecutionLabel(state) {
  return ({ running: '运行中', ended: '执行已结束，结果见最终答复',
    cancelled: '本轮已取消', failed: '本轮执行失败，详情见最终答复' })[state] || '运行状态待核对';
}
