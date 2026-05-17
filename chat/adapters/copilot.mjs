import {
  messageEvent, toolUseEvent, toolResultEvent,
  fileChangeEvent, reasoningEvent, statusEvent, usageEvent,
} from '../normalizer.mjs';
import { DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS } from '../runtime-policy.mjs';

export { DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS } from '../runtime-policy.mjs';

export function createCopilotAdapter() {
  return {
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return [];
      }

      const events = [];

      switch (obj.type) {
        case 'thread.started':
          events.push(statusEvent(`Thread started (${obj.thread_id || 'unknown'})`));
          break;

        case 'turn.started':
          events.push(statusEvent('thinking'));
          break;

        case 'turn.completed':
          events.push(statusEvent('completed'));
          break;

        case 'remotelab.context_metrics':
          events.push(usageEvent({
            contextTokens: obj.contextTokens,
            inputTokens: obj.inputTokens,
            outputTokens: obj.outputTokens,
            cachedInputTokens: obj.cachedInputTokens,
            reasoningTokens: obj.reasoningTokens,
            estimatedCostUsd: obj.estimatedCostUsd,
            estimatedCostModel: obj.estimatedCostModel,
            contextWindowTokens: obj.contextWindowTokens,
            contextSource: obj.contextSource,
            costSource: obj.costSource,
          }));
          break;

        case 'turn.failed':
          events.push(statusEvent(`error: ${obj.error?.message || 'unknown error'}`));
          break;

        case 'item.started':
        case 'item.updated':
          if (obj.item) {
            const item = obj.item;
            if (obj.type === 'item.updated' && (item.type === 'agent_message' || item.type === 'reasoning')) {
              events.push(...parseItem(item, { phase: 'updated' }));
            }
            if (item.type === 'command_execution' && item.status === 'in_progress') {
              events.push(toolUseEvent('bash', item.command || ''));
            }
          }
          break;

        case 'item.completed':
          if (obj.item) {
            events.push(...parseItem(obj.item, { phase: 'completed' }));
          }
          break;

        case 'error':
          events.push(statusEvent(`error: ${obj.message || 'unknown error'}`));
          break;

        default:
          break;
      }

      return events;
    },

    flush() {
      return [];
    },
  };
}

function parseItem(item, options = {}) {
  const phase = typeof options.phase === 'string' ? options.phase : 'completed';
  const events = [];

  switch (item.type) {
    case 'agent_message':
      if (typeof item.text === 'string' && item.text.trim()) {
        const streamItemId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : '';
        events.push(messageEvent('assistant', item.text || '', undefined, {
          ...(phase === 'updated' ? { messageKind: 'stream_progress' } : {}),
          ...(phase === 'completed' ? { messageKind: 'stream_final' } : {}),
          ...(streamItemId ? { streamItemId } : {}),
        }));
      }
      break;

    case 'reasoning':
      if (typeof item.text === 'string' && item.text.trim()) {
        events.push(reasoningEvent(item.text || ''));
      }
      break;

    case 'command_execution':
      events.push(toolUseEvent('bash', item.command || ''));
      if (item.status === 'completed' || item.status === 'failed') {
        events.push(toolResultEvent(
          'bash',
          item.aggregated_output || '',
          item.exit_code ?? (item.status === 'failed' ? 1 : 0),
        ));
      }
      break;

    case 'file_change':
      if (Array.isArray(item.changes)) {
        for (const change of item.changes) {
          events.push(fileChangeEvent(change.path, change.kind));
        }
      }
      break;

    case 'mcp_tool_call': {
      const toolName = `${item.server}/${item.tool}`;
      events.push(toolUseEvent(toolName, JSON.stringify(item.arguments || {})));
      if (item.status === 'completed' || item.status === 'failed') {
        const output = item.error
          ? `Error: ${item.error.message}`
          : item.result
            ? JSON.stringify(item.result)
            : '';
        events.push(toolResultEvent(toolName, output, item.error ? 1 : 0));
      }
      break;
    }

    case 'web_search':
      events.push(toolUseEvent('web_search', item.query || ''));
      break;

    case 'todo_list':
      if (Array.isArray(item.items)) {
        const text = item.items
          .map(i => `${i.completed ? '[x]' : '[ ]'} ${i.text}`)
          .join('\n');
        events.push(messageEvent('assistant', text, undefined, {
          messageKind: 'todo_list',
        }));
      }
      break;

    case 'error':
      events.push(statusEvent(`error: ${item.message || 'unknown'}`));
      break;

    default:
      break;
  }

  return events;
}

const COPILOT_SYSTEM_PREFIX = process.env.REMOTELAB_COPILOT_SYSTEM_PREFIX || '';
const COPILOT_DEVELOPER_INSTRUCTIONS = process.env.REMOTELAB_COPILOT_DEVELOPER_INSTRUCTIONS || '';
const HAS_COPILOT_DEVELOPER_INSTRUCTIONS_ENV = Object.prototype.hasOwnProperty.call(
  process.env,
  'REMOTELAB_COPILOT_DEVELOPER_INSTRUCTIONS',
);

function resolveCopilotDeveloperInstructions(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'developerInstructions')) {
    return typeof options.developerInstructions === 'string'
      ? options.developerInstructions.trim()
      : '';
  }
  if (HAS_COPILOT_DEVELOPER_INSTRUCTIONS_ENV) {
    return COPILOT_DEVELOPER_INSTRUCTIONS.trim();
  }
  return DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS;
}

export function buildCopilotArgs(prompt, options = {}) {
  const args = ['exec'];
  const developerInstructions = resolveCopilotDeveloperInstructions(options);

  args.push('--json');
  args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push('--skip-git-repo-check');

  if (developerInstructions) {
    args.push('-c', `developer_instructions=${JSON.stringify(String(developerInstructions || ''))}`);
  }

  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${options.reasoningEffort}`);
  }

  const effectivePrompt = (options.systemPrefix ?? COPILOT_SYSTEM_PREFIX) + prompt;

  if (options.threadId) {
    args.push('resume', options.threadId, effectivePrompt);
  } else {
    args.push(effectivePrompt);
  }

  return args;
}
