import { randomUUID } from 'node:crypto';
import { buildClaudeArgs } from '../adapters/claude.mjs';

// Official streaming-input transport. Current CLIs acknowledge immediately via
// command_lifecycle; --replay-user-messages is the older consumption receipt.
// Result UUIDs (not queued_turn_count alone) decide whether all inputs drained.
// https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
export function createClaudeDriver({ send, onEvent = () => {}, onSettled = () => {}, onError = () => {}, options = {} }) {
  const args = buildClaudeArgs('', {
    ...options,
    resume: options.claudeSessionId,
    dangerouslySkipPermissions: String(process.env.IS_SANDBOX || '').trim() === '1' && options.dangerouslySkipPermissions,
  });
  args.splice(1, 1);
  args.push('--input-format', 'stream-json', '--replay-user-messages', '--include-partial-messages');
  const inputs = new Map();
  const byUuid = new Map();
  const controls = new Map();
  let closed = null;
  let dirty = false;
  let sessionId = options.claudeSessionId || '';
  let totalCost = 0;

  function acknowledge(entry, evidence) {
    if (!entry || entry.accepted) return;
    entry.accepted = true;
    entry.resolve({ id: entry.id, accepted: true, protocol: 'claude-stream-json', messageId: entry.uuid, evidence,
      ...(sessionId ? { sessionId } : {}) });
  }

  function close(error = new Error('Claude native transport closed')) {
    if (closed) return;
    closed = error;
    for (const entry of inputs.values()) if (!entry.accepted) entry.reject(error);
    for (const control of controls.values()) control.reject(error);
    controls.clear();
  }

  function submit({ id = randomUUID(), text = '' }) {
    if (closed) return Promise.reject(closed);
    const content = String(text).replaceAll('\0', '');
    const previous = inputs.get(id);
    if (previous) return previous.text === content ? previous.promise : Promise.reject(new Error(`Input ${id} has different content`));
    const uuid = randomUUID();
    const entry = { id, uuid, text: content, accepted: false, consumed: false, completed: false };
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    inputs.set(id, entry);
    byUuid.set(uuid, entry);
    dirty = true;
    try {
      send({ type: 'user', uuid, session_id: sessionId, message: { role: 'user', content }, parent_tool_use_id: null });
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
      if (closed) return Promise.reject(closed);
      const request_id = randomUUID();
      return new Promise((resolve, reject) => {
        controls.set(request_id, { resolve, reject });
        try { send({ type: 'control_request', request_id, request: { subtype: 'interrupt', cancel_queued: true } }); }
        catch (error) { controls.delete(request_id); reject(error); }
      });
    },
    handle(message) {
      if (closed || !message || typeof message !== 'object') return;
      if (message.session_id) sessionId = message.session_id;
      if (message.type === 'control_response') {
        const response = message.response;
        const request = controls.get(response?.request_id);
        if (!request) return;
        controls.delete(response.request_id);
        if (response.subtype === 'success') request.resolve(response.response || {});
        else request.reject(Object.assign(new Error(response.error || 'Claude interrupt rejected'), { code: 'NATIVE_REJECTED' }));
        return;
      }
      if (message.type === 'control_request') {
        // Permissions and other interactive requests must never be silently
        // approved by the transport. Existing unattended permission flags still
        // apply; an unexpected interactive request is surfaced as unsupported.
        const error = new Error(`Claude requires interactive ${message.request?.subtype || 'control'} handling`);
        try { send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: error.message } }); }
        catch (writeError) { close(writeError); onError(writeError); return; }
        close(error);
        onError(error);
        return;
      }
      if (message.type === 'command_lifecycle') {
        const entry = byUuid.get(message.command_uuid);
        if (entry) {
          if (['queued', 'started', 'completed'].includes(message.state)) acknowledge(entry, 'command_lifecycle');
          if (message.state === 'started') entry.consumed = true;
          if (message.state === 'cancelled' || message.state === 'failed') {
            entry.completed = true;
            if (!entry.accepted) entry.reject(Object.assign(new Error(`Claude input ${message.state}`), { code: 'NATIVE_REJECTED', nativeCode: message.state }));
          }
        }
        onEvent(message);
        return;
      }
      if (message.type === 'user' && message.isReplay === true && !message.parent_tool_use_id) {
        const entry = byUuid.get(message.uuid);
        acknowledge(entry, 'user_replay');
        if (entry) entry.consumed = true;
      }
      const resultIds = new Set([
        ...(Array.isArray(message.user_message_uuids) ? message.user_message_uuids : []),
        ...(message.user_message_uuid ? [message.user_message_uuid] : []),
      ]);
      for (const uuid of resultIds) {
        const entry = byUuid.get(uuid);
        acknowledge(entry, 'reply_uuid');
        if (entry) entry.consumed = true;
      }
      if (message.type !== 'result') { onEvent(message); return; }
      if (!dirty) return;

      const completed = resultIds.size
        ? [...resultIds].map((uuid) => byUuid.get(uuid)).filter(Boolean)
        : [...inputs.values()].filter((entry) => entry.consumed && !entry.completed);
      const failed = message.is_error === true || (message.subtype && message.subtype !== 'success');
      if (failed && !completed.length) {
        const error = new Error(message.errors?.join('\n') || message.result || `Claude ${message.subtype || 'request'} failed`);
        error.code = 'NATIVE_FAILED';
        onEvent(message);
        close(error);
        onError(error);
        return;
      }
      for (const entry of completed) entry.completed = true;
      const stillPending = [...inputs.values()].some((entry) => !entry.completed) || Number(message.queued_turn_count) > 0;
      const normalized = { ...message, remotelabNativePending: stillPending };
      if (Number.isFinite(message.total_cost_usd)) {
        normalized.cost_usd = Math.max(0, message.total_cost_usd - totalCost);
        totalCost = message.total_cost_usd;
      }
      onEvent(normalized);
      if (stillPending) return;
      dirty = false;
      onSettled({ status: failed ? 'failed' : 'completed', sessionId,
        ...(failed ? { error: message.errors?.join('\n') || message.result || message.subtype } : {}) });
    },
    close,
  };
}
