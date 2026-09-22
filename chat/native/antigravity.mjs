import { randomUUID } from 'node:crypto';
import { buildAntigravityArgs } from '../adapters/antigravity.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Antigravity's documented bidirectional stream-json protocol. The protocol
 * preserves input order but does not echo caller-provided message IDs, so the
 * driver correlates user_input/result events with the FIFO submission order.
 */
export function createAntigravityDriver({
  send,
  onEvent = () => {},
  onSettled = () => {},
  onError = () => {},
  options = {},
} = {}) {
  if (typeof send !== 'function') throw new TypeError('Antigravity driver requires send');
  const args = buildAntigravityArgs('', {
    streamInput: true,
    conversationId: options.antigravityConversationId,
    model: options.model,
    effort: options.effort,
    sandbox: String(process.env.IS_SANDBOX || '').trim() === '1',
    dangerouslySkipPermissions: String(process.env.IS_SANDBOX || '').trim() === '1'
      && options.dangerouslySkipPermissions === true,
  });
  const inputs = new Map();
  const order = [];
  let closed = null;
  let conversationId = trimString(options.antigravityConversationId);

  function unfinishedEntries() {
    return order.map((id) => inputs.get(id)).filter((entry) => entry && !entry.completed);
  }

  function nextUnaccepted() {
    return unfinishedEntries().find((entry) => !entry.accepted) || null;
  }

  function nextAccepted() {
    return unfinishedEntries().find((entry) => entry.accepted) || null;
  }

  function acknowledge(entry) {
    if (!entry || entry.accepted) return;
    entry.accepted = true;
    entry.resolve({
      id: entry.id,
      accepted: true,
      protocol: 'antigravity-stream-json',
      ...(conversationId ? { conversationId } : {}),
    });
  }

  function failOutstanding(error) {
    for (const entry of unfinishedEntries()) {
      entry.completed = true;
      if (!entry.accepted) entry.reject(error);
    }
  }

  function submit({ id = randomUUID(), text = '' }) {
    if (closed) return Promise.reject(closed);
    const content = String(text).replaceAll('\0', '');
    const previous = inputs.get(id);
    if (previous) {
      return previous.text === content
        ? previous.promise
        : Promise.reject(new Error(`Input ${id} has different content`));
    }
    const entry = { id, text: content, accepted: false, completed: false };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    inputs.set(id, entry);
    order.push(id);
    try {
      send({ event: 'user', message: { content } });
    } catch (error) {
      entry.completed = true;
      entry.reject(error);
    }
    return entry.promise;
  }

  return {
    args,
    start: (prompt) => submit({ id: randomUUID(), text: prompt }),
    submit,
    interrupt() {
      // Antigravity stream-json currently has no in-band control message.
      // The native host follows this acknowledgement with a bounded SIGTERM
      // fallback, preserving RemoteLab's explicit Stop behavior.
      return Promise.resolve({ accepted: false, protocol: 'process-signal' });
    },
    handle(message) {
      if (closed || !message || typeof message !== 'object') return;
      if (message.event === 'init') {
        conversationId = trimString(message.conversation_id)
          || trimString(message.init?.conversation_id)
          || conversationId;
        onEvent(message);
        return;
      }
      if (message.event === 'step_update') {
        if (message.step_update?.step_type === 'user_input' && message.step_update?.state === 'DONE') {
          acknowledge(nextUnaccepted());
        }
        onEvent(message);
        return;
      }
      if (message.event !== 'result') {
        onEvent(message);
        return;
      }

      const result = message.result && typeof message.result === 'object' ? message.result : {};
      conversationId = trimString(result.conversation_id) || conversationId;
      const entry = nextAccepted() || nextUnaccepted();
      acknowledge(entry);
      if (entry) entry.completed = true;
      onEvent(message);

      const status = trimString(result.status).toUpperCase();
      if (status !== 'SUCCESS') {
        const error = new Error(trimString(result.error) || `Antigravity ended with status ${status || 'ERROR'}`);
        error.code = status || 'ANTIGRAVITY_FAILED';
        failOutstanding(error);
        onSettled({ status: 'failed', error: error.message, conversationId });
        return;
      }
      if (unfinishedEntries().length === 0) {
        onSettled({ status: 'completed', conversationId });
      }
    },
    close(error = new Error('Antigravity native transport closed')) {
      if (closed) return;
      closed = error;
      failOutstanding(error);
    },
  };
}
