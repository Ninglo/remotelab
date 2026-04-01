#!/usr/bin/env node

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile, readdir, stat } from 'fs/promises';
import { homedir, platform } from 'os';
import { join, resolve } from 'path';

const HOME = homedir();
const DEFAULT_CONFIG_PATH = join(HOME, '.config', 'remotelab', 'anthropic-fast-agent.json');
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_ITERATIONS = 2;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_BASH_TIMEOUT_MS = 12000;
const DEFAULT_TOOL_OUTPUT_CHARS = 12000;
const DEFAULT_DIRECTORY_ENTRIES = 200;
const DEFAULT_TOOL_CALLS_PER_TURN = 4;
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_ALIAS_MAP = new Map([
  ['opus', 'claude-opus-4-6'],
  ['sonnet', 'claude-sonnet-4-6'],
  ['haiku', 'claude-haiku-4-5'],
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
  node scripts/anthropic-fast-agent.mjs -p <prompt> [options]

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
    "maxTokens": 8192,
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
    apiKey: trimString(data.apiKey || process.env.ANTHROPIC_API_KEY),
    baseUrl: trimString(data.baseUrl || process.env.ANTHROPIC_BASE_URL) || DEFAULT_BASE_URL,
    model: normalizeRequestedModel(data.model || process.env.ANTHROPIC_MODEL, DEFAULT_MODEL),
    systemPrompt: trimString(data.systemPrompt),
    maxIterations: parsePositiveInteger(data.maxIterations, DEFAULT_MAX_ITERATIONS, { min: 1, max: 6 }),
    maxTokens: parsePositiveInteger(data.maxTokens, DEFAULT_MAX_TOKENS, { min: 256, max: 128000 }),
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
  const resolvedPath = resolveHomePath(configPath || process.env.ANTHROPIC_FAST_AGENT_CONFIG || DEFAULT_CONFIG_PATH, DEFAULT_CONFIG_PATH);
  const parsed = await loadJsonFile(resolvedPath);
  const config = normalizeConfig(parsed, resolvedPath);
  if (!config.apiKey) {
    throw new Error(`Anthropic fast agent config is missing apiKey: ${resolvedPath}`);
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
    'You are using Anthropic Claude through the Messages API, not Claude Code.',
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
      name: 'bash',
      description: 'Run a short shell command in the current working directory on the local machine. Good for quick inspection or simple local operations. Avoid destructive or long-running commands unless the user explicitly asked.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
          timeout_ms: { type: 'integer', minimum: 500, maximum: 120000, description: 'Optional timeout override.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    });
  }
  if (config.tools.listDir) {
    tools.push({
      name: 'list_dir',
      description: 'List files and directories for a path on the local machine.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path or path relative to the current working directory.' },
        },
        additionalProperties: false,
      },
    });
  }
  if (config.tools.readFile) {
    tools.push({
      name: 'read_file',
      description: 'Read a small text file from the local machine.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path or path relative to the current working directory.' },
          max_chars: { type: 'integer', minimum: 128, maximum: 200000, description: 'Optional character limit for the returned file content.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    });
  }
  if (config.tools.clipboardRead) {
    tools.push({
      name: 'clipboard_read',
      description: 'Read the current clipboard contents from the local machine.',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    });
  }
  if (config.tools.clipboardWrite) {
    tools.push({
      name: 'clipboard_write',
      description: 'Write text to the local clipboard.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to write to the clipboard.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    });
  }
  if (config.tools.openApp) {
    tools.push({
      name: 'open_app',
      description: 'Open or activate a local application by name.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Application name, such as Safari or WeChat.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    });
  }
  if (config.tools.notify) {
    tools.push({
      name: 'notify',
      description: 'Show a local desktop notification.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title.' },
          body: { type: 'string', description: 'Notification body text.' },
        },
        required: ['body'],
        additionalProperties: false,
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
    input_tokens: Number.isInteger(usage.input_tokens) ? usage.input_tokens : 0,
    output_tokens: Number.isInteger(usage.output_tokens) ? usage.output_tokens : 0,
    cache_creation_input_tokens: Number.isInteger(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0,
    cache_read_input_tokens: Number.isInteger(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0,
  };
}

function emitJsonLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitAssistantMessage({ sessionId, messageId, model, content, usage, stopReason }) {
  emitJsonLine({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      type: 'message',
      id: messageId,
      model,
      stop_reason: trimString(stopReason) || null,
      stop_sequence: null,
      usage: buildClaudeUsage(usage),
      content: Array.isArray(content) ? content : [],
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

function extractAssistantText(content = []) {
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => entry?.type === 'text' ? String(entry.text || '') : '')
    .filter(Boolean)
    .join('\n');
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

function buildMessagesUrl(baseUrl) {
  const normalized = trimString(baseUrl).replace(/\/$/, '');
  return `${normalized}/v1/messages`;
}

async function fetchMessage(config, requestedModel, systemPrompt, messages, tools) {
  const modelToUse = normalizeRequestedModel(requestedModel, config.model) || config.model;
  const payload = {
    model: modelToUse,
    max_tokens: config.maxTokens,
    system: systemPrompt,
    messages,
  };
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
  }

  const timeout = makeTimeoutSignal(config.requestTimeoutMs);
  try {
    const response = await fetch(buildMessagesUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: timeout.signal,
    });
    const rawText = await response.text();
    let json = null;
    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      throw new Error(clipText(json?.error?.message || rawText || `HTTP ${response.status}`, config.maxToolOutputChars));
    }
    return json || {};
  } finally {
    timeout.cancel();
  }
}

function aggregateUsage(accumulator, usage = {}) {
  accumulator.input_tokens += Number.isInteger(usage.input_tokens) ? usage.input_tokens : 0;
  accumulator.output_tokens += Number.isInteger(usage.output_tokens) ? usage.output_tokens : 0;
  accumulator.cache_creation_input_tokens += Number.isInteger(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0;
  accumulator.cache_read_input_tokens += Number.isInteger(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
  return accumulator;
}

async function runAgent(config, args) {
  const sessionId = trimString(args.resumeId) || randomUUID().replace(/-/g, '');
  const tools = buildTools(config);
  const outputJson = ensureJsonEventOutput(args.outputFormat);
  const usageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const systemPrompt = buildSystemPrompt(config);
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: args.prompt }],
    },
  ];

  if (outputJson) {
    emitJsonLine({ type: 'system', subtype: 'init', session_id: sessionId });
  }

  for (let iteration = 0; iteration < config.maxIterations; iteration += 1) {
    const response = await fetchMessage(config, args.model, systemPrompt, messages, tools);
    const content = Array.isArray(response?.content) ? response.content : [];
    const toolCalls = content
      .filter((block) => block?.type === 'tool_use' && trimString(block?.name))
      .slice(0, config.maxToolCallsPerTurn)
      .map((block) => ({
        id: trimString(block.id) || `tool_${randomUUID().replace(/-/g, '')}`,
        name: trimString(block.name),
        input: block.input && typeof block.input === 'object' ? block.input : {},
      }));
    const assistantText = extractAssistantText(content);
    aggregateUsage(usageTotals, response?.usage || {});

    if (outputJson) {
      emitAssistantMessage({
        sessionId,
        messageId: trimString(response?.id) || `msg_${randomUUID().replace(/-/g, '')}`,
        model: trimString(response?.model) || config.model,
        content,
        usage: response?.usage,
        stopReason: response?.stop_reason,
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
      content,
    });

    const toolResults = [];
    const userContent = [];
    for (const toolCall of toolCalls) {
      const result = await executeToolCall(toolCall, config);
      toolResults.push({
        id: toolCall.id,
        isError: result.isError === true,
        content: result.content,
      });
      userContent.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: result.content,
        is_error: result.isError === true,
      });
    }

    messages.push({
      role: 'user',
      content: userContent,
    });

    if (outputJson) {
      emitToolResults(sessionId, toolResults);
    }
  }

  throw new Error(`Anthropic fast agent hit the tool-loop limit (${config.maxIterations}) before producing a final reply.`);
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
