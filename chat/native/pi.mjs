import { randomUUID } from 'node:crypto';
import { buildPiArgs } from '../adapters/pi.mjs';
import { resolvePiModelRoute } from '../pi-models.mjs';

// Pi's RPC response acknowledges acceptance. agent_end is deliberately not a
// terminal signal: retries, compaction and native queued input can still follow.
// Protocol: https://pi.dev/docs/latest/rpc (verified with Pi 0.85).
export function createPiDriver({ send, onEvent = () => {}, onSettled = () => {}, onError = () => {}, options = {} }) {
  const route = resolvePiModelRoute(options.model);
  const args = buildPiArgs('', {
    sessionId: options.piSessionId,
    provider: route.provider,
    model: route.model,
    thinking: options.effort,
  }).slice(0, -1);
  args[1] = 'rpc';
  const pending = new Map();
  const inputs = new Map();
  let sequence = 0;
  let revision = 0;
  let closed = null;
  let dirty = false;
  let needsSettled = false;
  let lastAssistantFailure = '';

  function command(type, fields = {}, extra = {}) {
    if (closed) return Promise.reject(closed);
    const id = `remotelab-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { type, resolve, reject, ...extra });
      try { send({ id, type, ...fields }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  function probe() {
    if (closed || !dirty) return;
    const observedRevision = revision;
    command('get_state', {}, { observedRevision }).catch((error) => {
      if (!closed) onError(error);
    });
  }

  function settleIfIdle(state, observedRevision) {
    if (closed || !dirty || needsSettled || revision !== observedRevision) return;
    if ([...pending.values()].some((entry) => entry.type === 'prompt')) return;
    if (state?.isStreaming !== false || state?.isCompacting !== false || state?.pendingMessageCount !== 0) return;
    dirty = false;
    onEvent({ type: 'agent_settled' });
    onSettled({ status: lastAssistantFailure ? 'failed' : 'completed',
      ...(lastAssistantFailure ? { error: lastAssistantFailure } : {}),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}) });
  }

  function submit({ id = randomUUID(), text = '' }) {
    if (closed) return Promise.reject(closed);
    const content = String(text).replaceAll('\0', '');
    const previous = inputs.get(id);
    if (previous) {
      return previous.text === content ? previous.promise : Promise.reject(new Error(`Input ${id} has different content`));
    }
    revision += 1;
    const promise = command('prompt', { message: content, streamingBehavior: 'steer' }, { inputId: id });
    inputs.set(id, { text: content, promise });
    return promise;
  }

  return {
    args,
    start: (prompt) => submit({ id: randomUUID(), text: prompt }),
    submit,
    async interrupt() {
      // Pi explicitly preserves queued input on abort unless clear_queue runs
      // first. A RemoteLab Stop must not immediately launch the next message.
      await command('clear_queue');
      return command('abort');
    },
    handle(message) {
      if (closed || !message || typeof message !== 'object') return;
      if (message.type === 'response') {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.success !== true) {
          const error = new Error(message.error || `Pi ${request.type} rejected`);
          error.code = 'NATIVE_REJECTED';
          request.reject(error);
          if (request.type === 'prompt') probe();
          return;
        }
        if (request.type === 'prompt') {
          dirty = true;
          request.resolve({ id: request.inputId, accepted: true, protocol: 'pi-rpc' });
          probe();
        } else {
          request.resolve(message.data || {});
          if (request.type === 'get_state') settleIfIdle(message.data, request.observedRevision);
        }
        return;
      }
      if (message.type === 'agent_start' || message.type === 'compaction_start') {
        needsSettled = true;
        revision += 1;
      }
      if (message.type === 'queue_update') revision += 1;
      if (message.type === 'message_end' && message.message?.role === 'assistant') {
        const assistant = message.message;
        lastAssistantFailure = ['error', 'aborted'].includes(assistant.stopReason)
          ? (assistant.errorMessage || assistant.stopReason) : '';
      }
      if (message.type === 'agent_settled') {
        needsSettled = false;
        revision += 1;
        probe();
        return;
      }
      onEvent(message);
    },
    close(error = new Error('Pi native transport closed')) {
      if (closed) return;
      closed = error;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    },
  };
}
