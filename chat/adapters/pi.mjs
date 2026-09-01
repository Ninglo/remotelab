import {
  messageEvent,
  reasoningEvent,
  statusEvent,
  toolResultEvent,
  toolUseEvent,
  usageEvent,
} from '../normalizer.mjs';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function serializeToolValue(value) {
  const text = textFromContent(value?.content ?? value);
  if (text) return text;
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return String(value ?? '');
  }
}

function parseAssistantMessage(message, { includeFailureStatus = true } = {}) {
  if (message?.role !== 'assistant') return [];
  const events = [];
  for (const item of Array.isArray(message.content) ? message.content : []) {
    if (item?.type === 'thinking' && item.thinking) {
      events.push(reasoningEvent(item.thinking));
    } else if (item?.type === 'text' && item.text) {
      events.push(messageEvent('assistant', item.text));
    }
  }

  const usage = message.usage;
  if (usage && typeof usage === 'object') {
    events.push(usageEvent({
      contextTokens: usage.totalTokens,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedInputTokens: usage.cacheRead,
      reasoningTokens: usage.reasoning,
      costUsd: usage.cost?.total,
      contextSource: 'pi',
      costSource: 'pi',
    }));
  }
  if (
    includeFailureStatus
    && (message.stopReason === 'error' || message.stopReason === 'aborted')
  ) {
    events.push(statusEvent(`error: ${message.errorMessage || message.stopReason}`));
  }
  return events;
}

export function createPiAdapter() {
  let lastAssistantStopReason = '';
  let lastAssistantFailureReason = '';
  return {
    parseLine(line) {
      const trimmed = String(line || '').trim();
      if (!trimmed) return [];

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return [];
      }

      switch (event.type) {
        case 'agent_start':
        case 'turn_start':
          return [statusEvent('thinking')];
        case 'message_end':
          if (event.message?.role === 'assistant') {
            lastAssistantStopReason = typeof event.message.stopReason === 'string'
              ? event.message.stopReason
              : '';
            lastAssistantFailureReason = (
              lastAssistantStopReason === 'error'
              || lastAssistantStopReason === 'aborted'
            )
              ? (event.message.errorMessage || lastAssistantStopReason)
              : '';
          }
          return parseAssistantMessage(event.message, {
            // Pi emits message_end for every failed provider attempt before its
            // automatic retry loop settles. Publishing an error here makes
            // RemoteLab finalize the run while Pi is still retrying.
            includeFailureStatus: false,
          });
        case 'tool_execution_start':
          return [toolUseEvent(event.toolName || 'tool', serializeToolValue(event.args))];
        case 'tool_execution_end':
          return [toolResultEvent(
            event.toolName || 'tool',
            serializeToolValue(event.result),
            event.isError ? 1 : 0,
          )];
        case 'agent_settled':
          if (lastAssistantStopReason === 'error') {
            return [statusEvent(`error: ${lastAssistantFailureReason || 'provider request failed'}`)];
          }
          if (lastAssistantStopReason === 'aborted') {
            // The detached runner owns cancellation terminalization.
            return [];
          }
          return [statusEvent('completed')];
        default:
          return [];
      }
    },

    restoreProjectionState(state = {}) {
      lastAssistantStopReason = typeof state.lastAssistantStopReason === 'string'
        ? state.lastAssistantStopReason
        : '';
      lastAssistantFailureReason = typeof state.lastAssistantFailureReason === 'string'
        ? state.lastAssistantFailureReason
        : '';
    },

    getProjectionState() {
      return {
        version: 1,
        lastAssistantStopReason,
        lastAssistantFailureReason,
      };
    },

    flush() {
      return [];
    },
  };
}

export function buildPiArgs(prompt, options = {}) {
  const provider = String(options.provider || 'openai-codex').trim() || 'openai-codex';
  const args = ['--mode', 'json', '--provider', provider, '--approve'];
  if (options.sessionId) {
    args.push('--session-id', String(options.sessionId));
  } else {
    args.push('--no-session');
  }
  if (options.model) args.push('--model', String(options.model));
  if (options.thinking) args.push('--thinking', String(options.thinking));
  args.push(String(prompt || '').replaceAll('\0', ''));
  return args;
}
