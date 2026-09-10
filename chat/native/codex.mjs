import { buildCodexArgs } from '../adapters/codex.mjs';

const nativeStatus = value => value === 'inProgress' ? 'in_progress' : value === 'declined' ? 'failed' : value;
const textInput = text => [{ type: 'text', text: String(text), text_elements: [] }];

function rpcError(value) {
  const error = new Error(value?.message || 'Codex App Server request failed');
  error.code = value?.code;
  error.data = value?.data;
  return error;
}

function execItem(item) {
  if (!item || !item.id) return null;
  const base = { id: item.id };
  switch (item.type) {
    case 'agentMessage': return { ...base, type: 'agent_message', text: item.text || '', ...(item.phase ? { phase: item.phase } : {}) };
    case 'reasoning': return { ...base, type: 'reasoning', text: (item.summary?.length ? item.summary : item.content || []).join('\n\n') };
    case 'plan': return { ...base, type: 'agent_message', text: item.text || '' };
    case 'commandExecution': return { ...base, type: 'command_execution', command: item.command || '', aggregated_output: item.aggregatedOutput || '', exit_code: item.exitCode, status: nativeStatus(item.status) };
    case 'fileChange': return { ...base, type: 'file_change', status: nativeStatus(item.status), changes: (item.changes || []).map(change => ({ path: change.path, kind: change.kind?.type || change.kind, diff: change.diff, ...(change.kind?.move_path ? { previousPath: change.path, path: change.kind.move_path } : {}) })) };
    case 'mcpToolCall': return { ...base, type: 'mcp_tool_call', server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error, status: nativeStatus(item.status) };
    case 'dynamicToolCall': return { ...base, type: 'mcp_tool_call', server: item.namespace || 'codex', tool: item.tool, arguments: item.arguments, result: item.contentItems, status: nativeStatus(item.status), ...(item.success === false ? { error: { message: 'Tool call failed' } } : {}) };
    case 'collabAgentToolCall': return { ...base, type: 'mcp_tool_call', server: 'collaboration', tool: item.tool, arguments: { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds }, result: item.agentsStates, status: nativeStatus(item.status) };
    case 'webSearch': return { ...base, type: 'web_search', query: item.query || item.action?.query || '' };
    default: return null;
  }
}

/**
 * Codex's documented App Server protocol. The caller owns the child process and
 * durable transport; this driver serializes only RPC acknowledgements, never
 * model execution. The native turn owns steering and tool scheduling.
 */
export function createCodexDriver({ send, onEvent = () => {}, onSettled = () => {}, onError = () => {}, options = {}, cwd } = {}) {
  if (typeof send !== 'function') throw new TypeError('Codex driver requires send');
  const configuredOptions = { ...options, threadId: options.threadId || options.codexThreadId,
    reasoningEffort: options.reasoningEffort || options.effort };
  const legacyArgs = buildCodexArgs('', configuredOptions);
  const args = ['app-server', '--listen', 'stdio://'];
  let sandbox = 'danger-full-access';
  // Reuse the existing runtime boundary, including guest sandbox and explicit
  // developer/app overrides. App Server does not accept exec-only CLI flags.
  for (let index = 1; index < legacyArgs.length - 1; index += 1) {
    const arg = legacyArgs[index];
    if (['-c', '--config', '--disable', '--enable'].includes(arg)) args.push(arg, legacyArgs[++index]);
    else if (arg === '-s') {
      sandbox = legacyArgs[++index];
      args.push('-c', `sandbox_mode=${JSON.stringify(sandbox)}`);
    }
    else if (arg === '--dangerously-bypass-approvals-and-sandbox') args.push('-c', 'sandbox_mode="danger-full-access"');
    else if (arg === '-m') args.push('-c', `model=${JSON.stringify(legacyArgs[++index])}`);
  }
  args.push('-c', 'approval_policy="never"');

  let sequence = 0, closed = null, initialization = null, threadId = '', activeTurnId = '';
  let operationTail = Promise.resolve(), inputsInFlight = 0, lastTerminal = null, settledTerminalId = '';
  const pending = new Map(), completedTurns = new Set(), startedTurns = new Set(), items = new Map();
  const reasoningParts = new Map();
  const announcedThreads = new Set();

  function request(method, params) {
    if (closed) return Promise.reject(closed);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { send({ id, method, params }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  function announceThread(id) {
    if (!id || announcedThreads.has(id)) return;
    announcedThreads.add(id);
    onEvent({ type: 'thread.started', thread_id: id });
  }
  function activateTurn(id) {
    if (!id || completedTurns.has(id)) return;
    activeTurnId = id;
    lastTerminal = null;
    if (!startedTurns.has(id)) {
      startedTurns.add(id);
      onEvent({ type: 'turn.started', turn_id: id });
    }
  }
  function maybeSettle() {
    if (closed || inputsInFlight || activeTurnId || !lastTerminal || lastTerminal.turnId === settledTerminalId) return;
    settledTerminalId = lastTerminal.turnId;
    onSettled(lastTerminal);
  }
  function inputOperation(fn) {
    inputsInFlight += 1;
    const operation = operationTail.then(() => {
      if (closed) throw closed;
      return fn();
    }).finally(() => { inputsInFlight -= 1; maybeSettle(); });
    operationTail = operation.catch(() => {});
    return operation;
  }
  async function startTurn({ id, text }) {
    const result = await request('turn/start', {
      threadId, input: textInput(text),
      ...(id ? { clientUserMessageId: id } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort || options.effort ? { effort: options.reasoningEffort || options.effort } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
    });
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error('Codex turn/start did not return a turn id');
    activateTurn(turnId);
    return { accepted: true, id: id || null, threadId, turnId, mode: 'start' };
  }
  async function submitInput(input) {
    if (!activeTurnId) return startTurn(input);
    const expectedTurnId = activeTurnId;
    try {
      const result = await request('turn/steer', {
        threadId, expectedTurnId, input: textInput(input.text),
        ...(input.id ? { clientUserMessageId: input.id } : {}),
      });
      if (!result?.turnId) throw new Error('Codex turn/steer did not return a turn id');
      return { accepted: true, id: input.id || null, threadId, turnId: result.turnId, mode: 'steer' };
    } catch (error) {
      // Only an explicit server rejection proves the input was not consumed.
      // Never retry a timeout, disconnect, or generic internal error.
      if (error.code === -32600 && /no active turn/i.test(error.message)) {
        if (activeTurnId === expectedTurnId) activeTurnId = '';
        return startTurn(input);
      }
      throw error;
    }
  }
  function respondToServer(message) {
    const { id, method } = message;
    let result;
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': result = { decision: 'decline' }; break;
      case 'execCommandApproval':
      case 'applyPatchApproval': result = { decision: 'abort' }; break;
      case 'item/permissions/requestApproval': result = { permissions: {}, scope: 'turn' }; break;
      case 'item/tool/requestUserInput': result = { answers: {} }; break;
      case 'mcpServer/elicitation/request': result = { action: 'cancel' }; break;
      case 'item/tool/call': result = { success: false, contentItems: [{ type: 'inputText', text: 'RemoteLab does not provide client-side dynamic tools.' }] }; break;
      default:
        send({ id, error: { code: -32601, message: `Unsupported client request: ${method}` } });
        onEvent({ type: 'error', message: `Codex requested unsupported client method ${method}` });
        return;
    }
    // Current unattended execution has no interactive approval surface. Decline
    // rather than silently invent approval, credentials, or a user's answer.
    send({ id, result });
    onEvent({ type: 'error', message: `Codex client request ${method} could not obtain interactive input.` });
  }
  function deltaItem(method, params) {
    const id = params.itemId;
    if (!id) return;
    let item = items.get(id);
    if (method === 'item/agentMessage/delta') {
      item ||= { id, type: 'agent_message', text: '' };
      item.text += params.delta || '';
    } else if (method === 'item/reasoning/summaryTextDelta') {
      item ||= { id, type: 'reasoning', text: '' };
      const parts = reasoningParts.get(id) || [];
      const index = Number.isInteger(params.summaryIndex) && params.summaryIndex >= 0 ? params.summaryIndex : 0;
      parts[index] = (parts[index] || '') + (params.delta || '');
      reasoningParts.set(id, parts);
      item.text = parts.join('\n\n');
    } else if (method === 'item/commandExecution/outputDelta') {
      item ||= { id, type: 'command_execution', command: '', status: 'in_progress', aggregated_output: '' };
      item.aggregated_output += params.delta || '';
    } else return;
    items.set(id, item);
    onEvent({ type: 'item.updated', native_stream: true, item: { ...item } });
  }
  function handle(message) {
    if (closed || !message || typeof message !== 'object') return;
    try {
      if (message.method && Object.hasOwn(message, 'id')) { respondToServer(message); return; }
      if (Object.hasOwn(message, 'id')) {
        const callback = pending.get(message.id);
        if (!callback) return;
        pending.delete(message.id);
        if (message.error) callback.reject(rpcError(message.error)); else callback.resolve(message.result);
        return;
      }
      const params = message.params || {};
      if (params.threadId && threadId && params.threadId !== threadId) return;
      switch (message.method) {
        case 'thread/started':
          // A child thread's start is not this session's resume identity.
          if (params.thread?.id === threadId) announceThread(threadId);
          break;
        case 'turn/started': activateTurn(params.turn?.id); break;
        case 'turn/completed': {
          const turn = params.turn;
          if (!turn?.id || completedTurns.has(turn.id)) break;
          completedTurns.add(turn.id);
          if (activeTurnId === turn.id) activeTurnId = '';
          const terminal = { status: turn.status, turnId: turn.id, ...(turn.error ? { error: turn.error.message || 'Codex turn failed' } : {}) };
          if (!activeTurnId) lastTerminal = terminal;
          onEvent(turn.status === 'failed'
            ? { type: 'turn.failed', turn_id: turn.id, error: { message: terminal.error || 'Codex turn failed' } }
            : { type: 'turn.completed', turn_id: turn.id, status: turn.status });
          maybeSettle();
          break;
        }
        case 'item/started':
        case 'item/completed': {
          const item = execItem(params.item);
          if (!item) break;
          items.set(item.id, item);
          onEvent({ type: message.method === 'item/started' ? 'item.started' : 'item.completed', item });
          if (message.method === 'item/completed') {
            items.delete(item.id);
            reasoningParts.delete(item.id);
          }
          break;
        }
        case 'thread/tokenUsage/updated': {
          const usage = params.tokenUsage?.last;
          if (!usage) break;
          onEvent({ type: 'remotelab.context_metrics', contextTokens: usage.totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens, reasoningTokens: usage.reasoningOutputTokens, contextWindowTokens: params.tokenUsage.modelContextWindow, contextSource: 'codex_app_server' });
          break;
        }
        case 'turn/plan/updated':
          onEvent({ type: 'item.completed', item: { id: `plan-${params.turnId}`, type: 'todo_list', items: (params.plan || []).map(step => ({ text: step.step, completed: step.status === 'completed' })) } });
          break;
        case 'error': onEvent({ type: 'error', message: params.error?.message || params.message || 'Codex provider error' }); break;
        default: deltaItem(message.method, params); break;
      }
    } catch (error) { onError(error); }
  }
  function start(prompt) {
    if (initialization) return Promise.reject(new Error('Codex driver already started'));
    initialization = inputOperation(async () => {
      await request('initialize', { clientInfo: { name: 'remotelab', version: '0.3.2' } });
      send({ method: 'initialized' });
      const resumeId = configuredOptions.threadId;
      const result = await request(resumeId ? 'thread/resume' : 'thread/start', {
        approvalPolicy: 'never', sandbox,
        ...(resumeId ? { threadId: resumeId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
      threadId = result?.thread?.id;
      if (!threadId) throw new Error('Codex thread initialization did not return a thread id');
      announceThread(threadId);
      const effectivePrompt = buildCodexArgs(prompt, configuredOptions).at(-1);
      return startTurn({ id: options.requestId || options.inputId, text: effectivePrompt });
    });
    return initialization;
  }
  return {
    args, start, handle,
    submit(input) {
      if (!initialization) return Promise.reject(new Error('Codex driver has not started'));
      return inputOperation(async () => {
        await initialization;
        try { return await submitInput(input); }
        catch (error) {
          if ([-32600, -32602].includes(error.code)) {
            error.rpcCode = error.code;
            error.code = 'NATIVE_REJECTED';
          }
          throw error;
        }
      });
    },
    async interrupt() {
      if (initialization) await initialization;
      if (!activeTurnId) return { interrupted: false };
      return request('turn/interrupt', { threadId, turnId: activeTurnId });
    },
    close(error = new Error('Codex driver closed')) {
      if (closed) return;
      closed = error;
      for (const callback of pending.values()) callback.reject(error);
      pending.clear();
    },
  };
}
