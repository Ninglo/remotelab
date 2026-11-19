import {
  messageEvent,
  reasoningEvent,
  statusEvent,
  toolResultEvent,
  toolUseEvent,
  usageEvent,
} from '../normalizer.mjs';
import { clampReasoningEffort } from '../../lib/reasoning-effort-policy.mjs';
import { normalizeCodexModelId } from '../../lib/legacy-micro-agent.mjs';

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

function readTextPhase(signature) {
  // Pi's OpenAI Responses providers retain the phase in their v1 text
  // signature; other providers may use an opaque signature or none.
  if (typeof signature !== 'string' || !signature.startsWith('{')) return undefined;
  try {
    const { v, id, phase } = JSON.parse(signature);
    if (v === 1 && typeof id === 'string' && (phase === 'commentary' || phase === 'final_answer')) return phase;
  } catch { /* leave unknown signatures phase-less */ }
  return undefined;
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
      const phase = readTextPhase(item.textSignature);
      events.push(messageEvent('assistant', item.text, undefined, phase ? { phase } : {}));
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

  function finishStreamingThinking(update) {
    const content = typeof update.content === 'string' ? update.content : update.thinking;
    if (typeof content !== 'string' || !content) return [];
    const index = Number.isInteger(update.contentIndex) && update.contentIndex >= 0 ? update.contentIndex : 0;
    emittedContentKeys.add(`thinking:${index}`);
    return [reasoningEvent(content)];
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
        case 'remotelab.activity':
          return event.presentation === 'reasoning' && typeof event.content === 'string' && event.content.trim()
            ? [reasoningEvent(event.content.trim())]
            : [];
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
          return update?.type === 'thinking_end' ? finishStreamingThinking(update) : [];
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
            // RPC text_end can omit the signature. Use authoritative text
            // and phase from message_end, before the next tool executes.
            // Skip streamed thinking and text already emitted by older code
            // if a Run crossed a control-plane restart.
            skipContentKeys: emittedContentKeys,
          });
          resetStreamingMessage();
          return parsedEvents;
        }
        case 'tool_execution_start':
          return [toolUseEvent(event.toolName || 'tool', serializeToolValue(event.args), { toolCallId: event.toolCallId })];
        case 'tool_execution_end':
          return [toolResultEvent(
            event.toolName || 'tool',
            serializeToolValue(event.result),
            event.isError ? 1 : 0,
            { toolCallId: event.toolCallId },
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
  const args = ['--mode', 'json', '--provider', provider,
    ...(options.pooledCodex ? ['--no-approve', '--no-extensions'] : ['--approve'])];
  if (options.sessionId) {
    args.push('--session-id', String(options.sessionId));
  } else {
    args.push('--no-session');
  }
  const model = provider === 'openai-codex'
    ? normalizeCodexModelId(options.model)
    : String(options.model || '').trim();
  if (model) args.push('--model', model);
  const thinking = clampReasoningEffort(options.thinking);
  if (thinking) args.push('--thinking', thinking);
  const instructions = typeof options.developerInstructions === 'string' ? options.developerInstructions.trim() : '';
  if (instructions) args.push('--append-system-prompt', `RemoteLab developer instructions:\n${instructions}`);
  args.push(String(prompt || '').replaceAll('\0', ''));
  return args;
}
