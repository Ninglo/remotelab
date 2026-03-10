import {
  messageEvent, toolUseEvent, toolResultEvent,
  reasoningEvent, statusEvent, usageEvent,
} from '../normalizer.mjs';

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
        case 'system':
          events.push(statusEvent(obj.subtype === 'init'
            ? `Session started (${obj.session_id || 'unknown'})`
            : `System: ${obj.subtype || 'unknown'}`));
          break;

        case 'assistant': {
          // Complete assistant message — the authoritative source for text & tool_use
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                events.push(messageEvent('assistant', block.text));
              } else if (block.type === 'thinking') {
                events.push(reasoningEvent(block.thinking));
              } else if (block.type === 'tool_use') {
                events.push(toolUseEvent(
                  block.name,
                  typeof block.input === 'string'
                    ? block.input
                    : JSON.stringify(block.input, null, 2),
                ));
              } else if (block.type === 'tool_result') {
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(block.tool_use_id || '', output));
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
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(
                  block.tool_use_id || '',
                  output,
                  block.is_error ? 1 : 0,
                ));
              }
            }
          }
          break;
        }

        case 'result':
          // Skip obj.result text — it duplicates the last assistant message.
          // Only emit usage + completed status.
          if (obj.cost_usd !== undefined || obj.usage) {
            const u = obj.usage || {};
            // Use per-turn input tokens tracked from the last assistant message,
            // which includes cached tokens. Fall back to summing the result event's fields.
            const totalIn = lastTurnInputTokens || (
              (u.input_tokens || 0) +
              (u.cache_creation_input_tokens || 0) +
              (u.cache_read_input_tokens || 0)
            );
            events.push(usageEvent({
              contextTokens: totalIn,
              inputTokens: u.input_tokens || 0,
              outputTokens: u.output_tokens || 0,
              contextSource: 'provider_turn_usage',
            }));
          }
          events.push(statusEvent('completed'));
          break;

        case 'stream_event': {
          // Only extract thinking deltas from streaming events.
          // Text and tool_use are handled via complete "assistant" messages above.
          const evt = obj.event;
          if (!evt) break;
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
            events.push(reasoningEvent(evt.delta.thinking || ''));
          }
          break;
        }

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

/**
 * Build the command-line arguments for spawning Claude Code.
 */
export function buildClaudeArgs(prompt, options = {}) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

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

  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.thinking) {
    args.push('--effort', 'high');
  }

  return args;
}
