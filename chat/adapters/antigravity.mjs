import {
  messageEvent,
  reasoningEvent,
  statusEvent,
  toolResultEvent,
  toolUseEvent,
  usageEvent,
} from '../normalizer.mjs';
import { sanitizeSpawnArgs } from '../spawn-arg-sanitizer.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function serializeValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stepKey(step = {}) {
  return `${trimString(step.conversation_id) || 'conversation'}:${Number.isInteger(step.step_index) ? step.step_index : 'unknown'}`;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    observed: false,
  };
}

function addStepUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return;
  total.inputTokens += Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  total.outputTokens += Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
  total.cachedInputTokens += Number.isFinite(usage.cache_read_tokens) ? usage.cache_read_tokens : 0;
  total.reasoningTokens += Number.isFinite(usage.thinking_tokens) ? usage.thinking_tokens : 0;
  total.observed = true;
}

/**
 * Project Antigravity CLI's documented stream-json protocol into RemoteLab's
 * provider-neutral event model.
 */
export function createAntigravityAdapter() {
  let assistantSteps = new Map();
  let emittedToolStarts = new Set();
  let countedUsageSteps = new Set();
  let turnUsage = emptyUsage();
  let turnHadAssistantMessage = false;

  function resetTurn() {
    assistantSteps = new Map();
    emittedToolStarts = new Set();
    countedUsageSteps = new Set();
    turnUsage = emptyUsage();
    turnHadAssistantMessage = false;
  }

  function parseStep(step) {
    if (!step || typeof step !== 'object') return [];
    const events = [];
    const key = stepKey(step);

    if (step.state === 'DONE' && step.usage && !countedUsageSteps.has(key)) {
      countedUsageSteps.add(key);
      addStepUsage(turnUsage, step.usage);
    }

    if (step.step_type === 'user_input') {
      if (step.state === 'DONE') events.push(statusEvent('thinking'));
      return events;
    }

    if (step.step_type === 'agent_response') {
      const prior = assistantSteps.get(key) || '';
      const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
      const combined = `${prior}${delta}`;
      assistantSteps.set(key, combined);
      if (step.state === 'DONE') {
        assistantSteps.delete(key);
        if (combined) {
          events.push(messageEvent('assistant', combined));
          turnHadAssistantMessage = true;
        }
      }
      return events;
    }

    if (step.step_type === 'tool') {
      const info = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info : {};
      const toolName = trimString(step.tool_name) || trimString(info.name) || 'tool';
      const toolCallId = key;
      if (!emittedToolStarts.has(key)) {
        emittedToolStarts.add(key);
        events.push(toolUseEvent(toolName, serializeValue(info.parameters), { toolCallId }));
      }
      if (step.state === 'DONE') {
        const toolError = info.error && typeof info.error === 'object'
          ? trimString(info.error.message) || serializeValue(info.error)
          : trimString(info.error);
        const output = toolError
          ? `Error: ${toolError}`
          : serializeValue(info.output);
        events.push(toolResultEvent(toolName, output, toolError ? 1 : 0, { toolCallId }));
      }
      return events;
    }

    if (step.subagent_info && typeof step.subagent_info === 'object') {
      events.push(reasoningEvent(`Antigravity subagent update: ${serializeValue(step.subagent_info)}`));
    }
    return events;
  }

  return {
    parseLine(line) {
      const trimmed = String(line || '').trim();
      if (!trimmed) return [];

      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return [];
      }

      if (message.type === 'remotelab.activity') {
        return message.presentation === 'reasoning' && trimString(message.content)
          ? [reasoningEvent(trimString(message.content))]
          : [];
      }

      if (message.event === 'init') {
        const conversationId = trimString(message.conversation_id)
          || trimString(message.init?.conversation_id);
        return [statusEvent(conversationId
          ? `Conversation started (${conversationId})`
          : 'Conversation started')];
      }

      if (message.event === 'step_update') {
        return parseStep(message.step_update);
      }

      if (message.event !== 'result') return [];

      const result = message.result && typeof message.result === 'object' ? message.result : {};
      const events = [];
      if (!turnHadAssistantMessage && typeof result.response === 'string' && result.response) {
        events.push(messageEvent('assistant', result.response));
      }
      if (turnUsage.observed) {
        events.push(usageEvent({
          inputTokens: turnUsage.inputTokens,
          outputTokens: turnUsage.outputTokens,
          cachedInputTokens: turnUsage.cachedInputTokens,
          reasoningTokens: turnUsage.reasoningTokens,
          contextSource: 'antigravity_step_usage',
        }));
      }

      const status = trimString(result.status).toUpperCase();
      if (status === 'SUCCESS') {
        events.push(statusEvent('completed'));
      } else if (status === 'CANCELED' || status === 'INTERRUPTED') {
        events.push(statusEvent(status.toLowerCase()));
      } else {
        events.push(statusEvent(`error: ${trimString(result.error) || `Antigravity ended with status ${status || 'ERROR'}`}`));
      }
      resetTurn();
      return events;
    },

    restoreProjectionState(state = {}) {
      assistantSteps = new Map(
        (Array.isArray(state.assistantSteps) ? state.assistantSteps : [])
          .filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'),
      );
      emittedToolStarts = new Set(
        (Array.isArray(state.emittedToolStarts) ? state.emittedToolStarts : [])
          .filter((entry) => typeof entry === 'string'),
      );
      countedUsageSteps = new Set(
        (Array.isArray(state.countedUsageSteps) ? state.countedUsageSteps : [])
          .filter((entry) => typeof entry === 'string'),
      );
      turnUsage = {
        ...emptyUsage(),
        ...(state.turnUsage && typeof state.turnUsage === 'object' ? state.turnUsage : {}),
      };
      turnHadAssistantMessage = state.turnHadAssistantMessage === true;
    },

    getProjectionState() {
      return {
        version: 1,
        assistantSteps: [...assistantSteps],
        emittedToolStarts: [...emittedToolStarts],
        countedUsageSteps: [...countedUsageSteps],
        turnUsage,
        turnHadAssistantMessage,
      };
    },

    flush() {
      return [];
    },
  };
}

export function buildAntigravityArgs(prompt, options = {}) {
  const streamInput = options.streamInput === true;
  const args = streamInput
    ? ['--input-format', 'stream-json', '--output-format', 'stream-json']
    : ['-p', String(prompt || '').replaceAll('\0', ''), '--output-format', 'stream-json'];

  if (options.conversationId) {
    args.push('--conversation', String(options.conversationId));
  }
  if (options.model) {
    args.push('--model', String(options.model));
  }
  const effort = trimString(options.effort);
  if (effort) {
    args.push('--effort', effort);
  }
  if (options.sandbox) {
    args.push('--sandbox');
  }
  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  return sanitizeSpawnArgs(args);
}
