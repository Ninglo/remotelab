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

function parseAssistantMessage(message, {
  includeFailureStatus = true,
  skipContentKeys = null,
} = {}) {
  if (message?.role !== 'assistant') return [];
  const events = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (let index = 0; index < content.length; index += 1) {
    const item = content[index];
    const contentKey = `${item?.type || 'unknown'}:${index}`;
    if (skipContentKeys?.has(contentKey)) continue;
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
  let emittedContentKeys = new Set();

  function resetStreamingMessage() {
    emittedContentKeys = new Set();
  }

  function getStreamingContentKey(type, contentIndex) {
    const index = Number.isInteger(contentIndex) && contentIndex >= 0 ? contentIndex : 0;
    return `${type}:${index}`;
  }

  function finishStreamingContent(type, update) {
    const key = getStreamingContentKey(type, update?.contentIndex);
    const content = typeof update?.content === 'string'
      ? update.content
      : type === 'text' && typeof update?.text === 'string'
        ? update.text
        : type === 'thinking' && typeof update?.thinking === 'string'
          ? update.thinking
          : '';
    if (!content) return [];
    emittedContentKeys.add(key);
    return type === 'text'
      ? [messageEvent('assistant', content)]
      : [reasoningEvent(content)];
  }

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
        case 'message_start':
          if (event.message?.role === 'assistant') {
            resetStreamingMessage();
          }
          return [];
        case 'message_update': {
          const update = event.assistantMessageEvent;
          switch (update?.type) {
            case 'text_start':
            case 'text_delta':
              return [];
            case 'text_end':
              return finishStreamingContent('text', update);
            case 'thinking_start':
            case 'thinking_delta':
              return [];
            case 'thinking_end':
              return finishStreamingContent('thinking', update);
            default:
              return [];
          }
        }
        case 'message_end': {
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
          const parsedEvents = parseAssistantMessage(event.message, {
            // Pi emits message_end for every failed provider attempt before its
            // automatic retry loop settles. Publishing an error here makes
            // RemoteLab finalize the run while Pi is still retrying.
            includeFailureStatus: false,
            // text_end/thinking_end are available before the authoritative
            // message_end line. Keep their earlier live events and only use
            // message_end for blocks that were not streamed by the provider.
            skipContentKeys: emittedContentKeys,
          });
          resetStreamingMessage();
          return parsedEvents;
        }
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
      emittedContentKeys = new Set(
        Array.isArray(state.emittedContentKeys)
          ? state.emittedContentKeys.filter((value) => typeof value === 'string')
          : [],
      );
    },

    getProjectionState() {
      return {
        version: 2,
        lastAssistantStopReason,
        lastAssistantFailureReason,
        emittedContentKeys: [...emittedContentKeys],
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
