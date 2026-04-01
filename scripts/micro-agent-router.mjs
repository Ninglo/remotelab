#!/usr/bin/env node

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const DEFAULT_CODEX_MODEL = 'gpt-5.4';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_MODEL_PREFIXES = ['claude-'];
const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
const ALLOWED_CLAUDE_EFFORTS = new Set(['low', 'medium', 'high']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printUsage(exitCode = 0, errorMessage = '') {
  const output = exitCode === 0 ? console.log : console.error;
  if (errorMessage) {
    console.error(errorMessage);
    console.error('');
  }
  output(`Usage:
  node scripts/micro-agent-router.mjs -p <prompt> [options]

Options:
  -p <prompt>              Prompt text to run
  --model <id>             Model id for this run
  --output-format <type>   stream-json | text (default: stream-json)
  --resume <id>            Accepted for CLI parity
  --continue               Accepted for CLI parity
  --verbose                Accepted for CLI parity
  --effort <level>         Optional effort hint
  --dangerously-skip-permissions
                           Accepted for CLI parity
  -h, --help               Show this help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const result = {
    prompt: '',
    model: '',
    outputFormat: 'stream-json',
    effort: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '-p':
      case '--prompt':
      case '--text':
        result.prompt = argv[index + 1] || '';
        index += 1;
        break;
      case '--model':
        result.model = argv[index + 1] || '';
        index += 1;
        break;
      case '--output-format':
        result.outputFormat = trimString(argv[index + 1]) || 'stream-json';
        index += 1;
        break;
      case '--effort':
        result.effort = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--resume':
      case '--continue':
      case '--verbose':
      case '--dangerously-skip-permissions':
      case '--print':
        if (arg === '--resume') index += 1;
        break;
      case '-h':
      case '--help':
        printUsage(0);
        break;
      default:
        if (!arg.startsWith('-') && !result.prompt) {
          result.prompt = arg;
        }
        break;
    }
  }

  if (!trimString(result.prompt)) {
    printUsage(1, 'Prompt is required.');
  }
  return result;
}

function isClaudeModel(model) {
  const normalized = trimString(model).toLowerCase();
  if (!normalized) return false;
  if (CLAUDE_MODEL_ALIASES.has(normalized)) return true;
  return CLAUDE_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function spawnChild(command, args, { onStdoutLine, onStderrLine, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        onStdoutLine?.(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        onStderrLine?.(line);
      }
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (stdoutBuffer) onStdoutLine?.(stdoutBuffer);
      if (stderrBuffer) onStderrLine?.(stderrBuffer);
      resolve({ code: code ?? 1, signal: signal || null });
    });

    if (typeof stdin === 'string') {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function emitJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function buildClaudeLikeUsage(usage = {}) {
  return {
    input_tokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
    output_tokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
  };
}

async function runClaudeRoute({ prompt, model, effort }) {
  const resolvedModel = trimString(model) || DEFAULT_CLAUDE_MODEL;
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--model', resolvedModel, '--tools', ''];
  const normalizedEffort = trimString(effort).toLowerCase();
  if (ALLOWED_CLAUDE_EFFORTS.has(normalizedEffort)) {
    args.push('--effort', normalizedEffort);
  }
  const result = await spawnChild('claude', args, {
    stdin: `${prompt}\n`,
    onStdoutLine: (line) => {
      if (line) process.stdout.write(`${line}\n`);
    },
    onStderrLine: (line) => {
      if (line) process.stderr.write(`${line}\n`);
    },
  });
  process.exitCode = result.code;
}

async function runCodexRoute({ prompt, model, effort }) {
  const resolvedModel = trimString(model) || DEFAULT_CODEX_MODEL;
  const sessionId = randomUUID();
  let sawSystem = false;
  let sawResult = false;
  let lastAssistantText = '';

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    process.cwd(),
    '-m',
    resolvedModel,
  ];
  const normalizedEffort = trimString(effort);
  if (normalizedEffort) {
    args.push('-c', `model_reasoning_effort="${normalizedEffort}"`);
  }
  args.push(prompt);

  const result = await spawnChild('codex', args, {
    onStdoutLine: (line) => {
      const trimmed = trimString(line);
      if (!trimmed) return;
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (parsed.type === 'thread.started' && !sawSystem) {
        sawSystem = true;
        emitJsonLine({
          type: 'system',
          subtype: 'init',
          cwd: process.cwd(),
          session_id: parsed.thread_id || sessionId,
          tools: [],
          mcp_servers: [],
          model: resolvedModel,
          permissionMode: 'bypassPermissions',
        });
        return;
      }

      if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message') {
        const text = trimString(parsed.item?.text);
        if (!text) return;
        lastAssistantText = text;
        emitJsonLine({
          type: 'assistant',
          message: {
            model: resolvedModel,
            id: parsed.item?.id || randomUUID(),
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            stop_reason: null,
            stop_sequence: null,
            stop_details: null,
            usage: null,
            context_management: null,
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          uuid: randomUUID(),
        });
        return;
      }

      if (parsed.type === 'turn.completed') {
        sawResult = true;
        emitJsonLine({
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          result: lastAssistantText,
          stop_reason: null,
          session_id: sessionId,
          total_cost_usd: 0,
          usage: buildClaudeLikeUsage(parsed.usage),
          modelUsage: {
            [resolvedModel]: {
              inputTokens: Number.isFinite(parsed.usage?.input_tokens) ? parsed.usage.input_tokens : 0,
              outputTokens: Number.isFinite(parsed.usage?.output_tokens) ? parsed.usage.output_tokens : 0,
            },
          },
          permission_denials: [],
          uuid: randomUUID(),
        });
      }
    },
    onStderrLine: (line) => {
      if (line) process.stderr.write(`${line}\n`);
    },
  });

  if (!sawSystem) {
    emitJsonLine({
      type: 'system',
      subtype: 'init',
      cwd: process.cwd(),
      session_id: sessionId,
      tools: [],
      mcp_servers: [],
      model: resolvedModel,
      permissionMode: 'bypassPermissions',
    });
  }

  if (!sawResult) {
    emitJsonLine({
      type: 'result',
      subtype: result.code === 0 ? 'success' : 'error',
      is_error: result.code !== 0,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      result: lastAssistantText,
      stop_reason: result.code === 0 ? null : 'error',
      session_id: sessionId,
      total_cost_usd: 0,
      usage: buildClaudeLikeUsage(),
      modelUsage: {
        [resolvedModel]: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      permission_denials: [],
      uuid: randomUUID(),
    });
  }

  process.exitCode = result.code;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (trimString(args.outputFormat).toLowerCase() === 'text') {
    if (isClaudeModel(args.model)) {
      await spawnChild('claude', ['-p', '--model', trimString(args.model) || DEFAULT_CLAUDE_MODEL, '--tools', ''], {
        stdin: `${args.prompt}\n`,
        onStdoutLine: (line) => { if (line) process.stdout.write(`${line}\n`); },
        onStderrLine: (line) => { if (line) process.stderr.write(`${line}\n`); },
      });
      return;
    }
    await spawnChild('codex', ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', process.cwd(), '-m', trimString(args.model) || DEFAULT_CODEX_MODEL, args.prompt], {
      onStdoutLine: (line) => { if (line) process.stdout.write(`${line}\n`); },
      onStderrLine: (line) => { if (line) process.stderr.write(`${line}\n`); },
    });
    return;
  }

  if (isClaudeModel(args.model)) {
    await runClaudeRoute(args);
    return;
  }
  await runCodexRoute(args);
}

await main();
