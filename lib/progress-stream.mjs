import { collectAssistantSurfaceMessages, assistantSurfaceMessageId } from './assistant-surface-messages.mjs';

// A display stream, never a task, acceptance list or inferred work completion.
export function projectProgressStreams(history = [], excludedSeqs = new Set()) {
  const surfaces = collectAssistantSurfaceMessages(history);
  const streams = new Map();
  const replies = new Map();
  const externalRuns = new Set();
  let turn = '';
  for (const event of history) {
    if (event.type === 'message' && event.role === 'user') turn = `turn_${event.seq}`;
    const key = event.runId || turn;
    if (event.type === 'message' && event.role === 'user' && event.sourceContext?.connector) externalRuns.add(key);
    const surface = surfaces.get(event);
    if (surface?.surfaceKind === 'final' && surface.content) {
      replies.set(key, { id: assistantSurfaceMessageId(surface), deliveries: new Map() });
    }
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
    if (!previous) continue;
    const reply = replies.get(key);
    const receipt = event.type === 'source_delivery' && ['content', 'attachment'].includes(event.kind)
      && reply && event.providerMessageId === reply.id;
    if (receipt) {
      externalRuns.add(key);
      reply.deliveries.set(event.deliveryId, event);
    }
    const parts = [...(reply?.deliveries.values() || [])];
    const expectedParts = Math.max(1, ...parts.map(part => part.providerPartCount || 1));
    const states = parts.map(part => part.state);
    const replyDeliveryState = externalRuns.has(key) ? (
      states.find(state => ['delivery_failed', 'unknown', 'cancelled'].includes(state))
      || (parts.length >= expectedParts && parts.every(part => part.state === 'delivered' && part.externalId)
        ? 'delivered' : states.some(state => ['pending', 'sending'].includes(state)) ? 'sending' : 'unconfirmed')
    ) : undefined;
    const state = event.type === 'status' ? (event.content === 'completed' ? 'ended'
      : event.content === 'cancelled' ? 'cancelled' : String(event.content).startsWith('error:') ? 'failed' : '') : '';
    if (state || receipt || (surface?.surfaceKind === 'final' && previous.executionState !== 'running')) {
      const update = { seq: event.seq, progress: previous.progress,
        executionState: state || previous.executionState, replyDeliveryState };
      const updates = [...previous.updates];
      const last = updates.at(-1);
      // Receipt transitions are current transport state, not acceptance
      // checkpoints. Cold refresh should patch each card to its latest receipt
      // once, rather than replaying ended/sending/delivered through Feishu.
      if (last && last.seq !== last.progress?.seq && last.progress?.seq === update.progress?.seq
          && last.executionState === update.executionState) updates.pop();
      streams.set(key, { ...previous, executionState: update.executionState, replyDeliveryState,
        latestSeq: event.seq, updates: [...updates, update] });
    }
  }
  return [...streams.values()];
}

export function progressExecutionLabel(state, replyDeliveryState) {
  const execution = { running: '运行中', ended: '执行已结束', cancelled: '本轮已取消', failed: '本轮执行失败' }[state];
  if (!execution) return '运行状态待核对';
  if (state === 'running' || !replyDeliveryState) return execution;
  const delivery = { delivered: '最终答复已送达', sending: '最终答复正在发送',
    cancelled: '最终答复发送已取消', delivery_failed: '最终答复发送失败' }[replyDeliveryState];
  return `${execution}；${delivery || '最终答复尚未确认送达'}`;
}
