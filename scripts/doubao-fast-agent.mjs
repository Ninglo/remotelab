#!/usr/bin/env node

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile, readdir, stat } from 'fs/promises';
import { homedir, platform } from 'os';
import { basename, dirname, join, resolve } from 'path';

const HOME = homedir();
const DEFAULT_CONFIG_PATH = join(HOME, '.config', 'remotelab', 'doubao-fast-agent.json');
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seed-2-0-pro-260215';
const DEFAULT_MAX_ITERATIONS = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_BASH_TIMEOUT_MS = 12000;
const DEFAULT_TOOL_OUTPUT_CHARS = 12000;
const DEFAULT_DIRECTORY_ENTRIES = 200;
const DEFAULT_TOOL_CALLS_PER_TURN = 4;
const MODEL_ALIAS_MAP = new Map([
  ['doubao-seed-2.0-pro', DEFAULT_MODEL],
  ['Doubao-Seed-2.0-pro', DEFAULT_MODEL],
  ['doubao-seed-2-0-pro', DEFAULT_MODEL],
]);

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
  node scripts/doubao-fast-agent.mjs -p <prompt> [options]

Options:
  -p <prompt>              Prompt text to run
  --model <id>             Override model id for this run
  --config <path>          Config path (default: ${DEFAULT_CONFIG_PATH})
  --output-format <type>   text | stream-json (default: stream-json)
  --resume <id>            Reuse a prior emitted session id
  --continue               Accepted for Claude-compatible CLI parity
  --verbose                Accepted for Claude-compatible CLI parity
  --effort <level>         Accepted for Claude-compatible CLI parity
  --dangerously-skip-permissions
                           Accepted for Claude-compatible CLI parity
  -h, --help               Show this help

Config shape:
  {
    "apiKey": "...",
    "baseUrl": "${DEFAULT_BASE_URL}",
    "model": "${DEFAULT_MODEL}",
    "maxIterations": 2,
    "requestTimeoutMs": 20000,
    "bashTimeoutMs": 12000,
    "maxToolOutputChars": 12000,
    "maxDirectoryEntries": 200,
    "maxToolCallsPerTurn": 4,
    "systemPrompt": "optional compact instruction",
    "tools": {
      "bash": true,
      "list_dir": true,
      "read_file": true,
      "clipboard_read": true,
      "clipboard_write": true,
      "open_app": true,
      "notify": true
    }
  }
`);
  process.exit(exitCode);
}

function parsePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

function resolveHomePath(value, fallback) {
  const raw = trimString(value);
  if (!raw) return fallback;
  if (raw === '~') return HOME;
  if (raw.startsWith('~/')) return join(HOME, raw.slice(2));
  return resolve(raw);
}

function clipText(value, maxChars = DEFAULT_TOOL_OUTPUT_CHARS) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 23))}\n...[truncated]`;
}

function normalizeRequestedModel(requestedModel, fallbackModel) {
  const trimmed = trimString(requestedModel);
  if (!trimmed) return fallbackModel;
  return MODEL_ALIAS_MAP.get(trimmed) || trimmed;
}

async function loadJsonFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeConfig(input, configPath) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const toolFlags = data.tools && typeof data.tools === 'object' && !Array.isArray(data.tools) ? data.tools : {};
  return {
    configPath,
    apiKey: trimString(data.apiKey || process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.OPENAI_API_KEY),
    baseUrl: trimString(data.baseUrl || process.env.DOUBAO_API_BASE || process.env.ARK_API_BASE || process.env.OPENAI_API_BASE) || DEFAULT_BASE_URL,
    model: normalizeRequestedModel(data.model || process.env.DOUBAO_MODEL || process.env.ARK_MODEL || process.env.OPENAI_MODEL, DEFAULT_MODEL),
    systemPrompt: trimString(data.systemPrompt),
    maxIterations: parsePositiveInteger(data.maxIterations, DEFAULT_MAX_ITERATIONS, { min: 1, max: 6 }),
    requestTimeoutMs: parsePositiveInteger(data.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, { min: 1000, max: 120000 }),
    bashTimeoutMs: parsePositiveInteger(data.bashTimeoutMs, DEFAULT_BASH_TIMEOUT_MS, { min: 500, max: 120000 }),
    maxToolOutputChars: parsePositiveInteger(data.maxToolOutputChars, DEFAULT_TOOL_OUTPUT_CHARS, { min: 256, max: 200000 }),
    maxDirectoryEntries: parsePositiveInteger(data.maxDirectoryEntries, DEFAULT_DIRECTORY_ENTRIES, { min: 10, max: 5000 }),
    maxToolCallsPerTurn: parsePositiveInteger(data.maxToolCallsPerTurn, DEFAULT_TOOL_CALLS_PER_TURN, { min: 1, max: 20 }),
    shell: trimString(data.shell || process.env.SHELL) || (platform() === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    tools: {
      bash: toolFlags.bash !== false,
      listDir: toolFlags.list_dir !== false,
      readFile: toolFlags.read_file !== false,
      clipboardRead: toolFlags.clipboard_read !== false,
      clipboardWrite: toolFlags.clipboard_write !== false,
      openApp: toolFlags.open_app !== false,
      notify: toolFlags.notify !== false,
    },
  };
}

async function loadConfig(configPath) {
  const resolvedPath = resolveHomePath(configPath || process.env.DOUBAO_FAST_AGENT_CONFIG || DEFAULT_CONFIG_PATH, DEFAULT_CONFIG_PATH);
  const parsed = await loadJsonFile(resolvedPath);
  const config = normalizeConfig(parsed, resolvedPath);
  if (!config.apiKey) {
    throw new Error(`Doubao fast agent config is missing apiKey: ${resolvedPath}`);
  }
  return config;
}

function parseArgs(argv) {
  const result = {
    prompt: '',
    outputFormat: 'stream-json',
    model: '',
    configPath: '',
    resumeId: '',
    verbose: false,
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
      case '--output-format':
        result.outputFormat = trimString(argv[index + 1]) || 'stream-json';
        index += 1;
        break;
      case '--model':
        result.model = argv[index + 1] || '';
        index += 1;
        break;
      case '--config':
        result.configPath = argv[index + 1] || '';
        index += 1;
        break;
      case '--resume':
        result.resumeId = argv[index + 1] || '';
        index += 1;
        break;
      case '--effort':
        result.effort = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--verbose':
        result.verbose = true;
        break;
      case '--continue':
      case '--dangerously-skip-permissions':
      case '--print':
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

function buildSystemPrompt(config) {
  if (config.systemPrompt) return config.systemPrompt;
  return [
    'You are Rowan Fast Agent running locally on the owner\'s machine through RemoteLab.',
    'Optimize for low end-to-end latency and direct execution.',
    'Prefer zero tool calls when a plain answer is enough; otherwise use the minimum tool calls needed, ideally one and at most two turns total.',
    'Use explicit tools for simple local actions before falling back to bash.',
    'Do not start long-running servers, install packages, delete data, reset git history, or make broad system changes unless the user explicitly asks.',
    'When a local action succeeds, give a short status-oriented reply.',
    'Match the user\'s language.',
    `Current working directory: ${process.cwd()}`,
    `Operating system: ${platform()}`,
  ].join('\n');
}

function buildTools(config) {
  const tools = [];
  if (config.tools.bash) {
    tools.push({
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a short shell command in the current working directory on the local machine. Good for quick inspection or simple local operations. Avoid destructive or long-running commands unless the user explicitly asked.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run.' },
            timeout_ms: { type: 'integer', minimum: 500, maximum: 120000, description: 'Optional timeout override.' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    });
  }
  if (config.tools.listDir) {
    tools.push({
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List files and directories for a path on the local machine.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path or path relative to the current working directory.' },
          },
          additionalProperties: false,
        },
      },
    });
  }
  if (config.tools.readFile) {
    tools.push({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a small text file from the local machine.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path or path relative to the current working directory.' },
            max_chars: { type: 'integer', minimum: 128, maximum: 200000, description: 'Optional character limit for the returned file content.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    });
  }
  if (config.tools.clipboardRead) {
    tools.push({
      type: 'function',
      function: {
        name: 'clipboard_read',
        description: 'Read the current clipboard contents from the local machine.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    });
  }
  if (config.tools.clipboardWrite) {
    tools.push({
      type: 'function',
      function: {
        name: 'clipboard_write',
        description: 'Write text to the local clipboard.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to write to the clipboard.' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    });
  }
  if (config.tools.openApp) {
    tools.push({
      type: 'function',
      function: {
        name: 'open_app',
        description: 'Open or activate a local application by name.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Application name, such as Safari or WeChat.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    });
  }
  if (config.tools.notify) {
    tools.push({
      type: 'function',
      function: {
        name: 'notify',
        description: 'Show a local desktop notification.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Notification title.' },
            body: { type: 'string', description: 'Notification body text.' },
          },
          required: ['body'],
          additionalProperties: false,
        },
      },
    });
  }
  return tools;
}

function ensureJsonEventOutput(outputFormat) {
  return outputFormat === 'stream-json';
}

function buildClaudeUsage(usage = {}) {
  return {
    input_tokens: Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : 0,
    output_tokens: Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function emitJsonLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitAssistantMessage({ sessionId, messageId, model, text, toolCalls, usage }) {
  const content = [];
  if (trimString(text)) {
    content.push({ type: 'text', text });
  }
  for (const call of toolCalls || []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }
  emitJsonLine({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      type: 'message',
      id: messageId,
      model,
      stop_reason: (toolCalls || []).length > 0 ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: buildClaudeUsage(usage),
      content,
    },
  });
}

function emitToolResults(sessionId, results) {
  emitJsonLine({
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      type: 'message',
      content: results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.id,
        content: result.content,
        is_error: result.isError === true,
      })),
    },
  });
}

function emitResult(sessionId, resultText, usage) {
  emitJsonLine({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    result: resultText,
    usage: buildClaudeUsage(usage),
  });
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && typeof entry.text === 'string') return entry.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeToolCalls(rawCalls) {
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls
    .map((call) => {
      const functionName = trimString(call?.function?.name);
      const argumentText = typeof call?.function?.arguments === 'string'
        ? call.function.arguments
        : JSON.stringify(call?.function?.arguments || {});
      if (!functionName) return null;
      let input = {};
      try {
        input = JSON.parse(argumentText || '{}');
      } catch {
        input = { parse_error: 'Invalid JSON arguments', raw: argumentText };
      }
      return {
        id: trimString(call?.id) || `tool_${randomUUID().replace(/-/g, '')}`,
        name: functionName,
        input,
        raw: call,
      };
    })
    .filter(Boolean);
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = parsePositiveInteger(options.timeoutMs, DEFAULT_BASH_TIMEOUT_MS, { min: 100, max: 120000 });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        signal: signal || null,
        stdout,
        stderr,
        timedOut,
      });
    });

    if (typeof options.stdin === 'string') {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

function resolveToolPath(path) {
  return resolveHomePath(path || '.', process.cwd());
}

async function executeBashTool(input, config) {
  const command = trimString(input?.command);
  if (!command) {
    return { isError: true, content: 'Missing command for bash tool.' };
  }
  const timeoutMs = parsePositiveInteger(input?.timeout_ms, config.bashTimeoutMs, { min: 100, max: 120000 });
  const result = await runProcess(config.shell, ['-lc', command], {
    cwd: process.cwd(),
    timeoutMs,
  });
  const stdout = clipText(result.stdout, config.maxToolOutputChars);
  const stderr = clipText(result.stderr, config.maxToolOutputChars);
  const lines = [
    `Command: ${command}`,
    `CWD: ${process.cwd()}`,
    `Exit code: ${result.exitCode}`,
  ];
  if (result.timedOut) lines.push(`Timed out after ${timeoutMs}ms`);
  if (trimString(stdout)) {
    lines.push('Stdout:');
    lines.push(stdout);
  }
  if (trimString(stderr)) {
    lines.push('Stderr:');
    lines.push(stderr);
  }
  return {
    isError: result.exitCode !== 0 || result.timedOut,
    content: lines.join('\n'),
  };
}

async function executeListDirTool(input, config) {
  const resolvedPath = resolveToolPath(input?.path || '.');
  const dirStat = await stat(resolvedPath);
  if (!dirStat.isDirectory()) {
    return { isError: true, content: `${resolvedPath} is not a directory.` };
  }
  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const lines = entries
    .slice(0, config.maxDirectoryEntries)
    .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
  if (entries.length > config.maxDirectoryEntries) {
    lines.push(`... truncated after ${config.maxDirectoryEntries} entries`);
  }
  return {
    isError: false,
    content: [`Directory: ${resolvedPath}`, ...lines].join('\n'),
  };
}

async function executeReadFileTool(input, config) {
  const resolvedPath = resolveToolPath(input?.path);
  const maxChars = parsePositiveInteger(input?.max_chars, config.maxToolOutputChars, { min: 128, max: 200000 });
  const data = await readFile(resolvedPath, 'utf8');
  return {
    isError: false,
    content: `File: ${resolvedPath}\n${clipText(data, maxChars)}`,
  };
}

async function executeClipboardReadTool(config) {
  if (platform() === 'darwin') {
    const result = await runProcess('pbpaste', [], { timeoutMs: config.bashTimeoutMs });
    return {
      isError: result.exitCode !== 0,
      content: result.exitCode === 0
        ? `Clipboard:\n${clipText(result.stdout, config.maxToolOutputChars)}`
        : clipText(result.stderr || 'Failed to read clipboard.', config.maxToolOutputChars),
    };
  }
  const result = await runProcess('sh', ['-lc', 'xclip -selection clipboard -o'], { timeoutMs: config.bashTimeoutMs });
  return {
    isError: result.exitCode !== 0,
    content: result.exitCode === 0
      ? `Clipboard:\n${clipText(result.stdout, config.maxToolOutputChars)}`
      : clipText(result.stderr || 'Failed to read clipboard.', config.maxToolOutputChars),
  };
}

async function executeClipboardWriteTool(input, config) {
  const text = typeof input?.text === 'string' ? input.text : '';
  if (platform() === 'darwin') {
    const result = await runProcess('pbcopy', [], {
      timeoutMs: config.bashTimeoutMs,
      stdin: text,
    });
    return {
      isError: result.exitCode !== 0,
      content: result.exitCode === 0
        ? `Copied ${text.length} characters to the clipboard.`
        : clipText(result.stderr || 'Failed to write clipboard.', config.maxToolOutputChars),
    };
  }
  const result = await runProcess('sh', ['-lc', 'xclip -selection clipboard'], {
    timeoutMs: config.bashTimeoutMs,
    stdin: text,
  });
  return {
    isError: result.exitCode !== 0,
    content: result.exitCode === 0
      ? `Copied ${text.length} characters to the clipboard.`
      : clipText(result.stderr || 'Failed to write clipboard.', config.maxToolOutputChars),
  };
}

async function executeOpenAppTool(input, config) {
  const name = trimString(input?.name);
  if (!name) {
    return { isError: true, content: 'Missing app name.' };
  }
  const result = platform() === 'darwin'
    ? await runProcess('open', ['-a', name], { timeoutMs: config.bashTimeoutMs })
    : await runProcess('xdg-open', [name], { timeoutMs: config.bashTimeoutMs });
  return {
    isError: result.exitCode !== 0,
    content: result.exitCode === 0
      ? `Opened application: ${name}`
      : clipText(result.stderr || `Failed to open application: ${name}`, config.maxToolOutputChars),
  };
}

function escapeAppleScript(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function executeNotifyTool(input, config) {
  const title = trimString(input?.title) || 'Rowan';
  const body = trimString(input?.body);
  if (!body) {
    return { isError: true, content: 'Missing notification body.' };
  }
  if (platform() === 'darwin') {
    const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`;
    const result = await runProcess('osascript', ['-e', script], { timeoutMs: config.bashTimeoutMs });
    return {
      isError: result.exitCode !== 0,
      content: result.exitCode === 0
        ? `Displayed notification: ${title}`
        : clipText(result.stderr || 'Failed to display notification.', config.maxToolOutputChars),
    };
  }
  const result = await runProcess('notify-send', [title, body], { timeoutMs: config.bashTimeoutMs });
  return {
    isError: result.exitCode !== 0,
    content: result.exitCode === 0
      ? `Displayed notification: ${title}`
      : clipText(result.stderr || 'Failed to display notification.', config.maxToolOutputChars),
  };
}

async function executeToolCall(toolCall, config) {
  try {
    switch (toolCall.name) {
      case 'bash':
        return await executeBashTool(toolCall.input, config);
      case 'list_dir':
        return await executeListDirTool(toolCall.input, config);
      case 'read_file':
        return await executeReadFileTool(toolCall.input, config);
      case 'clipboard_read':
        return await executeClipboardReadTool(config);
      case 'clipboard_write':
        return await executeClipboardWriteTool(toolCall.input, config);
      case 'open_app':
        return await executeOpenAppTool(toolCall.input, config);
      case 'notify':
        return await executeNotifyTool(toolCall.input, config);
      default:
        return { isError: true, content: `Unsupported tool: ${toolCall.name}` };
    }
  } catch (error) {
    return {
      isError: true,
      content: clipText(error?.stack || error?.message || String(error), config.maxToolOutputChars),
    };
  }
}

function makeTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function buildCompletionsUrl(baseUrl) {
  const normalized = trimString(baseUrl).replace(/\/$/, '');
  return `${normalized}/chat/completions`;
}

function isMissingModelError(payload, requestedModel, defaultModel) {
  const code = trimString(payload?.error?.code);
  const message = trimString(payload?.error?.message || payload?.message || '');
  if (!requestedModel || requestedModel === defaultModel) return false;
  if (code === 'InvalidEndpointOrModel.NotFound') return true;
  return /(does not exist|not have access|InvalidEndpointOrModel|Not Found)/i.test(message);
}

async function consumeStream(response) {
  let content = '';
  const toolCallAccumulators = new Map();
  let model = '';
  let usage = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;

      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      if (parsed.model) model = parsed.model;
      if (parsed.usage) usage = parsed.usage;

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string') {
        content += delta.content;
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallAccumulators.has(idx)) {
            toolCallAccumulators.set(idx, { id: '', name: '', arguments: '' });
          }
          const acc = toolCallAccumulators.get(idx);
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls = [];
  for (const [, acc] of [...toolCallAccumulators.entries()].sort((a, b) => a[0] - b[0])) {
    if (acc.name) {
      toolCalls.push({
        id: acc.id || `tool_${randomUUID().replace(/-/g, '')}`,
        type: 'function',
        function: { name: acc.name, arguments: acc.arguments },
      });
    }
  }

  return {
    choices: [{
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    model,
    usage: usage || {},
  };
}

async function fetchChatCompletion(config, requestedModel, messages, tools) {
  const requested = normalizeRequestedModel(requestedModel, config.model);
  const modelToUse = requested || config.model;
  const payload = {
    model: modelToUse,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  const attempt = async (model) => {
    const requestBody = { ...payload, model };
    const timeout = makeTimeoutSignal(config.requestTimeoutMs);
    try {
      const response = await fetch(buildCompletionsUrl(config.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: timeout.signal,
      });
      if (!response.ok) {
        const rawText = await response.text();
        let json = null;
        try {
          json = rawText ? JSON.parse(rawText) : null;
        } catch {
          json = null;
        }
        const error = new Error(clipText(json?.error?.message || rawText || `HTTP ${response.status}`, config.maxToolOutputChars));
        error.code = json?.error?.code;
        error.payload = json;
        error.httpStatus = response.status;
        throw error;
      }
      const json = await consumeStream(response);
      return { response: json, modelUsed: model };
    } finally {
      timeout.cancel();
    }
  };

  try {
    return await attempt(modelToUse);
  } catch (error) {
    if (isMissingModelError(error.payload, modelToUse, config.model)) {
      return attempt(config.model);
    }
    throw error;
  }
}

function aggregateUsage(accumulator, usage = {}) {
  accumulator.prompt_tokens += Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  accumulator.completion_tokens += Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : 0;
  return accumulator;
}

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function parseAttachmentPathsEnv() {
  const raw = trimString(process.env.REMOTELAB_ATTACHMENT_PATHS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.path === 'string') : [];
  } catch {
    return [];
  }
}

async function buildImageContentParts(attachments) {
  const parts = [];
  for (const attachment of attachments) {
    const mimeType = trimString(attachment.mimeType) || 'image/jpeg';
    if (!IMAGE_MIME_TYPES.has(mimeType)) continue;
    try {
      const data = await readFile(attachment.path);
      const base64 = data.toString('base64');
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${base64}` },
      });
    } catch {
      // skip unreadable files silently
    }
  }
  return parts;
}

async function buildUserMessage(prompt) {
  const attachments = parseAttachmentPathsEnv();
  const imageParts = await buildImageContentParts(attachments);
  if (imageParts.length === 0) {
    return { role: 'user', content: prompt };
  }
  return {
    role: 'user',
    content: [
      ...imageParts,
      { type: 'text', text: prompt },
    ],
  };
}

async function runAgent(config, args) {
  const sessionId = trimString(args.resumeId) || randomUUID().replace(/-/g, '');
  const tools = buildTools(config);
  const outputJson = ensureJsonEventOutput(args.outputFormat);
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0 };
  const messages = [
    { role: 'system', content: buildSystemPrompt(config) },
    await buildUserMessage(args.prompt),
  ];

  if (outputJson) {
    emitJsonLine({ type: 'system', subtype: 'init', session_id: sessionId });
  }

  for (let iteration = 0; iteration < config.maxIterations; iteration += 1) {
    const { response, modelUsed } = await fetchChatCompletion(config, args.model, messages, tools);
    const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
    const assistantMessage = choice?.message || {};
    const toolCalls = normalizeToolCalls(assistantMessage.tool_calls).slice(0, config.maxToolCallsPerTurn);
    const assistantText = extractTextContent(assistantMessage.content);
    aggregateUsage(usageTotals, response?.usage || {});

    if (outputJson) {
      emitAssistantMessage({
        sessionId,
        messageId: `msg_${randomUUID().replace(/-/g, '')}`,
        model: trimString(response?.model) || modelUsed,
        text: assistantText,
        toolCalls,
        usage: response?.usage,
      });
    }

    if (toolCalls.length === 0) {
      if (outputJson) {
        emitResult(sessionId, assistantText, usageTotals);
      } else {
        process.stdout.write(`${assistantText}\n`);
      }
      return 0;
    }

    messages.push({
      role: 'assistant',
      content: assistantText || '',
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input || {}),
        },
      })),
    });

    const toolResults = [];
    for (const toolCall of toolCalls) {
      const result = await executeToolCall(toolCall, config);
      toolResults.push({
        id: toolCall.id,
        isError: result.isError === true,
        content: result.content,
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result.content,
      });
    }

    if (outputJson) {
      emitToolResults(sessionId, toolResults);
    }
  }

  throw new Error(`Doubao fast agent hit the tool-loop limit (${config.maxIterations}) before producing a final reply.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.configPath);
  try {
    const exitCode = await runAgent(config, args);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}

await main();
