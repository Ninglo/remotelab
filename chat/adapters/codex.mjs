import {
  messageEvent, toolUseEvent, toolResultEvent,
  fileChangeEvent, reasoningEvent, statusEvent, usageEvent,
} from '../normalizer.mjs';
import { DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS } from '../runtime-policy.mjs';

export { DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS } from '../runtime-policy.mjs';

/**
 * Codex CLI adapter.
 *
 * When run with `codex exec <prompt> --json`, stdout emits JSONL.
 * Each line is a JSON object with a `type` field.
 *
 * Event types:
 *   thread.started  — { type, thread_id }
 *   turn.started    — { type }
 *   turn.completed  — { type, usage: { input_tokens, cached_input_tokens, output_tokens } }
 *   turn.failed     — { type, error: { message } }
 *   item.started    — { type, item: ThreadItem }
 *   item.updated    — { type, item: ThreadItem }
 *   item.completed  — { type, item: ThreadItem }
 *   error           — { type, message }
 *   remotelab.context_metrics — synthetic line injected by RemoteLab sidecar
 *                               after reading Codex's session JSONL token_count data
 *
 * ThreadItem types:
 *   agent_message      — { id, type, text }
 *   reasoning          — { id, type, text }
 *   command_execution  — { id, type, command, aggregated_output, exit_code, status }
 *   file_change        — { id, type, changes: [{ path, kind }], status }
 *   mcp_tool_call      — { id, type, server, tool, arguments, result, error, status }
 *   web_search         — { id, type, query }
 *   todo_list          — { id, type, items: [{ text, completed }] }
 *   error              — { id, type, message }
 */
export function createCodexAdapter() {
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
          // Codex stdout usage is cumulative across the agent loop, so
          // RemoteLab injects a later remotelab.context_metrics line instead.
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
          // For in-progress items, emit status updates
          if (obj.item) {
            const item = obj.item;
            if (item.type === 'command_execution' && item.status === 'in_progress') {
              events.push(toolUseEvent('bash', item.command || ''));
            }
          }
          break;

        case 'item.completed':
          if (obj.item) {
            events.push(...parseItem(obj.item));
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

function parseItem(item) {
  const events = [];

  switch (item.type) {
    case 'agent_message':
      events.push(messageEvent('assistant', item.text || ''));
      break;

    case 'reasoning':
      events.push(reasoningEvent(item.text || ''));
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

/**
 * Optional system instruction prepended to Codex prompts.
 *
 * RemoteLab now leaves this empty by default so local project memory and
 * session prompts remain the primary steering layer. Operators can still set
 * `REMOTELAB_CODEX_SYSTEM_PREFIX` if they want to force an extra prefix.
 */
const CODEX_SYSTEM_PREFIX = process.env.REMOTELAB_CODEX_SYSTEM_PREFIX || '';
/**
 * Optional developer instructions passed through Codex's own supported
 * `developer_instructions` config key. This is stronger than a prompt prefix
 * when the manager needs to shape the agent's default reply style.
 */
const CODEX_DEVELOPER_INSTRUCTIONS = process.env.REMOTELAB_CODEX_DEVELOPER_INSTRUCTIONS || '';
const HAS_CODEX_DEVELOPER_INSTRUCTIONS_ENV = Object.prototype.hasOwnProperty.call(
  process.env,
  'REMOTELAB_CODEX_DEVELOPER_INSTRUCTIONS',
);

function encodeTomlString(value) {
  return JSON.stringify(String(value || ''));
}

function resolveDeveloperInstructions(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'developerInstructions')) {
    return typeof options.developerInstructions === 'string'
      ? options.developerInstructions.trim()
      : '';
  }
  if (HAS_CODEX_DEVELOPER_INSTRUCTIONS_ENV) {
    return CODEX_DEVELOPER_INSTRUCTIONS.trim();
  }
  return DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS;
}

/**
 * Build args for spawning Codex exec.
 */
export function buildCodexArgs(prompt, options = {}) {
  const args = ['exec'];
  const developerInstructions = resolveDeveloperInstructions(options);

  args.push('--json');
  args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push('--skip-git-repo-check');

  if (developerInstructions) {
    args.push('-c', `developer_instructions=${encodeTomlString(developerInstructions)}`);
  }

  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${options.reasoningEffort}`);
  }

  const effectivePrompt = (options.systemPrefix ?? CODEX_SYSTEM_PREFIX) + prompt;

  if (options.threadId) {
    args.push('resume', options.threadId, effectivePrompt);
  } else {
    args.push(effectivePrompt);
  }

  return args;
}
