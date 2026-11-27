import {
  messageEvent, toolUseEvent, toolResultEvent,
  reasoningEvent, statusEvent, usageEvent, fileChangeEvent, progressEvent,
} from '../normalizer.mjs';
import { buildClaudeToolBridgeConfig } from '../codex-tool-bridge-config.mjs';
import { claudeRuleRecoverySettings } from '../claude-rule-recovery.mjs';
import { sanitizeSpawnArgs } from '../spawn-arg-sanitizer.mjs';
import { nativeQuestionEvent } from '../native-user-questions.mjs';

/**
 * Claude Code adapter.
 *
 * When run with `claude -p --output-format stream-json --verbose`, stdout
 * emits JSONL with BOTH complete messages AND streaming events.
 *
 * To avoid duplicate rendering we use ONLY the complete messages
 * (type: "assistant", "user", "result") for text and tool_use blocks.
 * From stream_event we only extract thinking deltas (which aren't
 * duplicated in complete messages).
 */
export function createClaudeAdapter() {
  // Track per-turn input tokens from assistant messages for accurate context display.
  // Claude Code usage splits cache accounting across separate fields, so the
  // canonical context-window size is:
  // input_tokens + cache_creation_input_tokens + cache_read_input_tokens
  let lastTurnInputTokens = 0;
  let thinkingMessageId = '';
  let streamedThinking = new Map();
  let progressToolCallIds = new Set();

  function parseInput(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }

  function progressTool(name) {
    return name === 'mcp__remotelab__remotelab_progress' || name === 'remotelab/remotelab_progress';
  }

  function progressText(input) {
    const parsed = parseInput(input);
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  }

  function todoText(input) {
    const parsed = parseInput(input);
    const todos = Array.isArray(parsed.todos) ? parsed.todos : Array.isArray(parsed.items) ? parsed.items : [];
    return todos.map(todo => {
      const completed = todo?.status === 'completed' || todo?.completed === true || todo?.done === true;
      const label = typeof todo?.content === 'string' ? todo.content : typeof todo?.text === 'string' ? todo.text : todo?.subject;
      return label ? `${completed ? '[x]' : '[ ]'} ${label}` : '';
    }).filter(Boolean).join('\n');
  }

  function filePaths(name, input) {
    const parsed = parseInput(input);
    const path = parsed.file_path || parsed.filePath || parsed.notebook_path || parsed.notebookPath || parsed.path;
    const paths = [];
    if (typeof path === 'string' && path.trim()) paths.push(path.trim());
    if (name === 'MultiEdit' && Array.isArray(parsed.edits)) {
      for (const edit of parsed.edits) {
        const editPath = edit?.file_path || edit?.filePath || edit?.path;
        if (typeof editPath === 'string' && editPath.trim()) paths.push(editPath.trim());
      }
    }
    return [...new Set(paths)];
  }

  function parseToolUse(block) {
    const name = typeof block?.name === 'string' ? block.name : '';
    if (progressTool(name)) {
      if (block.id) progressToolCallIds.add(block.id);
      return progressEvent(progressText(block.input), { toolCallId: block.id, providerToolName: name });
    }
    if (name === 'TodoWrite') {
      const text = todoText(block.input);
      return text ? messageEvent('assistant', text, undefined, {
        messageKind: 'todo_list', toolCallId: block.id, providerToolName: name,
      }) : null;
    }
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
      const changeType = name === 'Write' ? 'write' : 'edit';
      return filePaths(name, block.input).map(filePath => fileChangeEvent(filePath, changeType, {
        toolCallId: block.id, providerToolName: name, changeState: 'completed', diffSource: 'runtime',
      }));
    }
    return toolUseEvent(name, typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2), {
      toolCallId: block.id,
    });
  }

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

      // Claude includes sub-agent traffic in the same stream-json output. It
      // must never enter RemoteLab's main timeline or surface projections.
      if (typeof obj.parent_tool_use_id === 'string' && obj.parent_tool_use_id.trim()) return [];

      const questionEvent = nativeQuestionEvent(obj);
      if (questionEvent) return [questionEvent];

      const events = [];

      switch (obj.type) {
        case 'remotelab.activity':
          if (obj.presentation === 'reasoning' && typeof obj.content === 'string' && obj.content.trim()) {
            events.push(reasoningEvent(obj.content.trim()));
          }
          break;

        case 'system':
          events.push(statusEvent(obj.subtype === 'init'
            ? `Session started (${obj.session_id || 'unknown'})`
            : `System: ${obj.subtype || 'unknown'}`));
          break;

        case 'assistant': {
          // Complete assistant message — the authoritative source for text & tool_use
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const [index, block] of content.entries()) {
              if (block.type === 'text') {
                events.push(messageEvent('assistant', block.text));
              } else if (block.type === 'thinking') {
                const streamed = (!thinkingMessageId || thinkingMessageId === obj.message?.id)
                  ? (streamedThinking.get(index) || '') : '';
                const thinking = typeof block.thinking === 'string' ? block.thinking : '';
                const unseen = streamed && thinking.startsWith(streamed) ? thinking.slice(streamed.length) : thinking;
                if (unseen) events.push(reasoningEvent(unseen));
                streamedThinking.delete(index);
              } else if (block.type === 'tool_use') {
                const parsed = parseToolUse(block);
                if (Array.isArray(parsed)) events.push(...parsed.filter(Boolean));
                else if (parsed) events.push(parsed);
              } else if (block.type === 'tool_result') {
                if (progressToolCallIds.has(block.tool_use_id)) {
                  progressToolCallIds.delete(block.tool_use_id);
                  continue;
                }
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(block.tool_use_id || '', output, block.is_error ? 1 : 0, { toolCallId: block.tool_use_id }));
              }
            }
          }
          // Track per-turn input tokens (including cached) for context display
          const msgUsage = obj.message?.usage;
          if (msgUsage) {
            lastTurnInputTokens =
              (msgUsage.input_tokens || 0) +
              (msgUsage.cache_creation_input_tokens || 0) +
              (msgUsage.cache_read_input_tokens || 0);
          }
          break;
        }

        case 'user': {
          // Tool results returned to the model
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                if (progressToolCallIds.has(block.tool_use_id)) {
                  progressToolCallIds.delete(block.tool_use_id);
                  continue;
                }
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(
                  block.tool_use_id || '',
                  output,
                  block.is_error ? 1 : 0,
                  { toolCallId: block.tool_use_id },
                ));
              }
            }
          }
          break;
        }

        case 'result':
          // Skip obj.result text — it duplicates the last assistant message.
          // Only emit usage + completed status.
          if (obj.cost_usd !== undefined || obj.estimated_cost_usd !== undefined || obj.usage) {
            const u = obj.usage || {};
            // Use per-turn input tokens tracked from the last assistant message,
            // which includes cached tokens. Fall back to summing the result event's fields.
            const totalIn = Number.isFinite(u.context_tokens)
              ? u.context_tokens
              : lastTurnInputTokens || (
              (u.input_tokens || 0) +
              (u.cache_creation_input_tokens || 0) +
              (u.cache_read_input_tokens || 0)
              );
            events.push(usageEvent({
              contextTokens: totalIn,
              inputTokens: u.input_tokens || 0,
              outputTokens: u.output_tokens || 0,
              ...(Number.isFinite(u.cached_input_tokens) ? { cachedInputTokens: u.cached_input_tokens } : {}),
              ...(Number.isFinite(u.reasoning_output_tokens) ? { reasoningTokens: u.reasoning_output_tokens } : {}),
              ...(Number.isFinite(obj.cost_usd) ? { costUsd: obj.cost_usd } : {}),
              ...(Number.isFinite(obj.estimated_cost_usd) ? { estimatedCostUsd: obj.estimated_cost_usd } : {}),
              ...(typeof obj.estimated_cost_model === 'string' && obj.estimated_cost_model
                ? { estimatedCostModel: obj.estimated_cost_model }
                : {}),
              contextSource: 'provider_turn_usage',
              ...(obj.cost_usd !== undefined
                ? { costSource: 'provider_reported' }
                : (typeof obj.cost_source === 'string' && obj.cost_source
                    ? { costSource: obj.cost_source }
                    : {})),
            }));
          }
          if (!obj.remotelabNativePending) events.push(statusEvent('completed'));
          break;

        case 'stream_event': {
          // Only extract thinking deltas from streaming events.
          // Text and tool_use are handled via complete "assistant" messages above.
          const evt = obj.event;
          if (!evt) break;
          if (evt.type === 'message_start') {
            thinkingMessageId = evt.message?.id || '';
            streamedThinking = new Map();
          }
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
            const content = evt.delta.thinking || '';
            const index = Number.isInteger(evt.index) ? evt.index : 0;
            streamedThinking.set(index, (streamedThinking.get(index) || '') + content);
            if (content) events.push(reasoningEvent(content));
          }
          break;
        }

        default:
          break;
      }

      return events;
    },

    restoreProjectionState(state = {}) {
      lastTurnInputTokens = Number.isFinite(state.lastTurnInputTokens)
        ? state.lastTurnInputTokens
        : 0;
      thinkingMessageId = typeof state.thinkingMessageId === 'string' ? state.thinkingMessageId : '';
      streamedThinking = new Map(Array.isArray(state.streamedThinking)
        ? state.streamedThinking.filter((entry) => Array.isArray(entry) && Number.isInteger(entry[0]) && typeof entry[1] === 'string') : []);
      progressToolCallIds = new Set(Array.isArray(state.progressToolCallIds)
        ? state.progressToolCallIds.filter((entry) => typeof entry === 'string' && entry) : []);
    },

    getProjectionState() {
      return {
        version: 2,
        lastTurnInputTokens,
        thinkingMessageId,
        streamedThinking: [...streamedThinking],
        progressToolCallIds: [...progressToolCallIds],
      };
    },

    flush() {
      return [];
    },
  };
}

/**
 * Build the command-line arguments for spawning Claude Code.
 */
export function buildClaudeArgs(prompt, options = {}) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-prompts', options.nativeQuestions ? 'host' : 'none',
  ];
  if (!options.nativeQuestions) args.push('--disallowedTools', 'AskUserQuestion');

  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns));
  }
  if (options.resume) {
    args.push('--resume', options.resume);
  }
  if (options.continue) {
    args.push('--continue');
  }
  if (options.allowedTools) {
    args.push('--allowedTools', ...options.allowedTools);
  }
  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  args.push('--mcp-config', buildClaudeToolBridgeConfig());
  const developerInstructions = typeof options.developerInstructions === 'string'
    ? options.developerInstructions.trim() : '';
  if (developerInstructions) args.push('--append-system-prompt', `RemoteLab developer instructions:\n${developerInstructions}`);
  if (options.ruleRecoverySessionId) args.push('--settings', claudeRuleRecoverySettings(options.ruleRecoverySessionId));

  if (options.model) {
    args.push('--model', options.model);
  }
  const effort = typeof options.effort === 'string' ? options.effort.trim() : '';
  if (effort && effort !== 'none') {
    args.push('--effort', effort);
  } else if (!effort && options.thinking) {
    args.push('--effort', 'high');
  }
  // Legacy effort === 'none' leaves the model's native effort default in place.

  return sanitizeSpawnArgs(args);
}
