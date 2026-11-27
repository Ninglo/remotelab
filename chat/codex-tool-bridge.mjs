#!/usr/bin/env node
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { runLocalBridgeCommand } from '../lib/local-bridge-command.mjs';

const MAX_TEXT_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RESULTS = 1_000;
const MAX_DEPTH = 32;
const MAX_TIMEOUT_MS = 10 * 60 * 1_000;

const stringProperty = (description, maxLength = MAX_TEXT_LENGTH) => ({
  type: 'string',
  description,
  maxLength,
});

const rootAndPathProperties = {
  rootAlias: stringProperty('Allowed local-helper root alias.', 128),
  relPath: stringProperty('Relative path inside that root.', MAX_PATH_LENGTH),
};

export const CODEX_TOOL_DEFINITIONS = [
  {
    name: 'remotelab_progress',
    description: 'Publish one useful progress update to RemoteLab. Use only when the user needs to know a finding, changed direction, blocker, or next step.',
    inputSchema: {
      type: 'object',
      properties: { text: stringProperty('The progress update to show the user.', MAX_TEXT_LENGTH) },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'remotelab_local_bridge_status',
    description: 'Show the linked local helper for this RemoteLab Session, including its allowed roots and connection state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'remotelab_local_bridge_list',
    description: 'List files and directories under an allowed root on the linked local helper.',
    inputSchema: {
      type: 'object',
      properties: {
        ...rootAndPathProperties,
        depth: { type: 'integer', minimum: 0, maximum: MAX_DEPTH, description: 'Optional traversal depth.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'Optional queue wait timeout in milliseconds.' },
      },
      required: ['rootAlias', 'relPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'remotelab_local_bridge_find',
    description: 'Search files under an allowed root on the linked local helper by text and/or glob.',
    inputSchema: {
      type: 'object',
      properties: {
        ...rootAndPathProperties,
        query: stringProperty('Optional text or filename query.', MAX_TEXT_LENGTH),
        glob: stringProperty('Optional glob pattern.', MAX_TEXT_LENGTH),
        maxResults: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: 'Optional result cap.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'Optional queue wait timeout in milliseconds.' },
      },
      required: ['rootAlias', 'relPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'remotelab_local_bridge_stat',
    description: 'Read metadata for a file or directory under an allowed root on the linked local helper.',
    inputSchema: {
      type: 'object',
      properties: {
        ...rootAndPathProperties,
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'Optional queue wait timeout in milliseconds.' },
      },
      required: ['rootAlias', 'relPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'remotelab_local_bridge_read_text',
    description: 'Read bounded UTF-8 or explicitly encoded text from a file under an allowed root on the linked local helper.',
    inputSchema: {
      type: 'object',
      properties: {
        ...rootAndPathProperties,
        offset: { type: 'integer', minimum: 0, description: 'Optional byte offset.' },
        maxBytes: { type: 'integer', minimum: 1, maximum: MAX_BYTES, description: 'Optional byte limit.' },
        encoding: stringProperty('Optional text encoding name.', 32),
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'Optional queue wait timeout in milliseconds.' },
      },
      required: ['rootAlias', 'relPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'remotelab_local_bridge_stage',
    description: 'Upload one selected file from an allowed root into this RemoteLab Session. This changes Session attachments.',
    inputSchema: {
      type: 'object',
      properties: {
        ...rootAndPathProperties,
        purpose: stringProperty('Optional attachment purpose.', 128),
        mimeType: stringProperty('Optional MIME type hint.', 128),
        sizeBytes: { type: 'integer', minimum: 0, maximum: MAX_BYTES, description: 'Optional size hint.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'Optional queue wait timeout in milliseconds.' },
      },
      required: ['rootAlias', 'relPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'remotelab_local_bridge_pack',
    description: 'Pack one selected directory from an allowed root and attach the archive to this RemoteLab Session. This changes Session attachments.',
    inputSchema: {
      type: 'object',
      properties: {
        ...rootAndPathProperties,
        exclude: { type: 'array', items: stringProperty('Exclude pattern.', MAX_TEXT_LENGTH), maxItems: 128 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'Optional queue wait timeout in milliseconds.' },
      },
      required: ['rootAlias', 'relPath'],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = new Map(CODEX_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function error(message, code = 'INVALID_ARGUMENT') {
  const failure = new Error(message);
  failure.code = code;
  return failure;
}

function ensureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('Tool arguments must be an object');
  return value;
}

function ensureAllowedKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw error(`Unknown tool argument: ${key}`);
  }
}

function ensureString(value, name, { required = false, maxLength = MAX_TEXT_LENGTH, defaultValue = '' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw error(`${name} is required`);
    return defaultValue;
  }
  if (typeof value !== 'string' || !value.trim()) {
    if (required) throw error(`${name} must be a non-empty string`);
    return defaultValue;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw error(`${name} is too long`);
  return normalized;
}

function ensureInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, defaultValue = null } = {}) {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) throw error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function normalizeCommonArgs(raw, { requirePath = true, extraKeys = [] } = {}) {
  const args = ensureObject(raw);
  ensureAllowedKeys(args, new Set(['rootAlias', 'relPath', 'timeoutMs', ...extraKeys]));
  const rootAlias = ensureString(args.rootAlias, 'rootAlias', { required: true, maxLength: 128 });
  const relPath = ensureString(args.relPath, 'relPath', { required: requirePath, maxLength: MAX_PATH_LENGTH, defaultValue: '.' }) || '.';
  const timeoutMs = ensureInteger(args.timeoutMs, 'timeoutMs', { min: 1, max: MAX_TIMEOUT_MS });
  return { rootAlias, relPath, ...(timeoutMs !== null ? { timeoutMs } : {}) };
}

function normalizeToolArguments(name, raw) {
  if (name === 'remotelab_progress') {
    const args = ensureObject(raw || {});
    ensureAllowedKeys(args, new Set(['text']));
    return { text: ensureString(args.text, 'text', { required: true, maxLength: MAX_TEXT_LENGTH }) };
  }
  if (name === 'remotelab_local_bridge_status') {
    const args = ensureObject(raw || {});
    ensureAllowedKeys(args, new Set());
    return {};
  }
  if (name === 'remotelab_local_bridge_list') {
    const args = normalizeCommonArgs(raw, { extraKeys: ['depth'] });
    const depth = ensureInteger(raw.depth, 'depth', { min: 0, max: MAX_DEPTH });
    return { ...args, ...(depth !== null ? { depth } : {}) };
  }
  if (name === 'remotelab_local_bridge_find') {
    const args = normalizeCommonArgs(raw, { extraKeys: ['query', 'glob', 'maxResults'] });
    ensureAllowedKeys(raw, new Set(['rootAlias', 'relPath', 'timeoutMs', 'query', 'glob', 'maxResults']));
    const query = ensureString(raw.query, 'query');
    const glob = ensureString(raw.glob, 'glob');
    const maxResults = ensureInteger(raw.maxResults, 'maxResults', { min: 1, max: MAX_RESULTS });
    return { ...args, ...(query ? { query } : {}), ...(glob ? { glob } : {}), ...(maxResults !== null ? { maxResults } : {}) };
  }
  if (name === 'remotelab_local_bridge_stat') return normalizeCommonArgs(raw);
  if (name === 'remotelab_local_bridge_read_text') {
    const args = normalizeCommonArgs(raw, { extraKeys: ['offset', 'maxBytes', 'encoding'] });
    ensureAllowedKeys(raw, new Set(['rootAlias', 'relPath', 'timeoutMs', 'offset', 'maxBytes', 'encoding']));
    const offset = ensureInteger(raw.offset, 'offset', { min: 0 });
    const maxBytes = ensureInteger(raw.maxBytes, 'maxBytes', { min: 1, max: MAX_BYTES });
    const encoding = ensureString(raw.encoding, 'encoding', { maxLength: 32 });
    return { ...args, ...(offset !== null ? { offset } : {}), ...(maxBytes !== null ? { maxBytes } : {}), ...(encoding ? { encoding } : {}) };
  }
  if (name === 'remotelab_local_bridge_stage') {
    const args = normalizeCommonArgs(raw, { extraKeys: ['purpose', 'mimeType', 'sizeBytes'] });
    ensureAllowedKeys(raw, new Set(['rootAlias', 'relPath', 'timeoutMs', 'purpose', 'mimeType', 'sizeBytes']));
    const purpose = ensureString(raw.purpose, 'purpose', { maxLength: 128 });
    const mimeType = ensureString(raw.mimeType, 'mimeType', { maxLength: 128 });
    const sizeBytes = ensureInteger(raw.sizeBytes, 'sizeBytes', { min: 0, max: MAX_BYTES });
    return { ...args, ...(purpose ? { purpose } : {}), ...(mimeType ? { mimeType } : {}), ...(sizeBytes !== null ? { sizeBytes } : {}) };
  }
  if (name === 'remotelab_local_bridge_pack') {
    const args = normalizeCommonArgs(raw, { extraKeys: ['exclude'] });
    ensureAllowedKeys(raw, new Set(['rootAlias', 'relPath', 'timeoutMs', 'exclude']));
    if (raw.exclude !== undefined && (!Array.isArray(raw.exclude) || raw.exclude.length > 128)) throw error('exclude must be an array of at most 128 strings');
    const exclude = (raw.exclude || []).map((value, index) => ensureString(value, `exclude[${index}]`, { required: true })).filter(Boolean);
    return { ...args, ...(exclude.length ? { exclude } : {}) };
  }
  throw error(`Unknown RemoteLab tool: ${name}`, 'UNKNOWN_TOOL');
}

function timeoutArgs(args) {
  return args.timeoutMs ? ['--timeout-ms', String(args.timeoutMs)] : [];
}

function commandArgs(name, args) {
  if (name === 'remotelab_progress') return [];
  if (name === 'remotelab_local_bridge_status') return ['status', '--json'];
  const command = {
    remotelab_local_bridge_list: 'list',
    remotelab_local_bridge_find: 'find',
    remotelab_local_bridge_stat: 'stat',
    remotelab_local_bridge_read_text: 'read-text',
    remotelab_local_bridge_stage: 'stage',
    remotelab_local_bridge_pack: 'pack',
  }[name];
  if (!command) throw error(`Unknown RemoteLab tool: ${name}`, 'UNKNOWN_TOOL');
  const argv = [command, '--root', args.rootAlias, '--path', args.relPath];
  if (args.depth !== undefined) argv.push('--depth', String(args.depth));
  if (args.query) argv.push('--query', args.query);
  if (args.glob) argv.push('--glob', args.glob);
  if (args.maxResults !== undefined) argv.push('--max-results', String(args.maxResults));
  if (args.offset !== undefined) argv.push('--offset', String(args.offset));
  if (args.maxBytes !== undefined) argv.push('--max-bytes', String(args.maxBytes));
  if (args.encoding) argv.push('--encoding', args.encoding);
  if (args.purpose) argv.push('--purpose', args.purpose);
  if (args.mimeType) argv.push('--mime-type', args.mimeType);
  if (args.sizeBytes !== undefined) argv.push('--size-bytes', String(args.sizeBytes));
  if (args.exclude?.length) argv.push('--exclude', args.exclude.join(','));
  argv.push(...timeoutArgs(args), '--json');
  return argv;
}

function captureStdout() {
  let value = '';
  return {
    stdout: new Writable({ write(chunk, encoding, callback) { value += chunk.toString(); callback(); } }),
    read() { return value; },
  };
}

async function executeTool(name, rawArguments = {}, { runCommand = runLocalBridgeCommand } = {}) {
  if (!TOOL_BY_NAME.has(name)) throw error(`Unknown RemoteLab tool: ${name}`, 'UNKNOWN_TOOL');
  const args = normalizeToolArguments(name, rawArguments);
  if (name === 'remotelab_progress') return { ok: true };
  const argv = commandArgs(name, args);
  const capture = captureStdout();
  const exitCode = await runCommand(argv, { stdout: capture.stdout });
  const output = capture.read().trim();
  if (exitCode && exitCode !== 0) throw error(`RemoteLab local bridge exited with code ${exitCode}`, 'BRIDGE_FAILED');
  if (!output) return { ok: true };
  try {
    return JSON.parse(output);
  } catch {
    throw error('RemoteLab local bridge returned invalid JSON', 'BRIDGE_INVALID_RESPONSE');
  }
}

function resultForValue(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function createCodexToolBridge({ runCommand = runLocalBridgeCommand, write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`) } = {}) {
  async function handle(message) {
    if (!message || typeof message !== 'object') return;
    const id = message.id;
    const method = message.method;
    if (typeof method !== 'string') {
      if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid MCP request' } });
      return;
    }
    if (method.startsWith('notifications/')) return;
    if (method === 'initialize') {
      write({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'remotelab-local-bridge', version: '1.0.0' },
      } });
      return;
    }
    if (method === 'ping') {
      write({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      write({ jsonrpc: '2.0', id, result: { tools: CODEX_TOOL_DEFINITIONS } });
      return;
    }
    if (method === 'tools/call') {
      const name = message.params?.name;
      try {
        const value = await executeTool(name, message.params?.arguments || {}, { runCommand });
        write({ jsonrpc: '2.0', id, result: resultForValue(value) });
      } catch (failure) {
        write({ jsonrpc: '2.0', id, result: {
          isError: true,
          content: [{ type: 'text', text: failure?.message || String(failure) }],
        } });
      }
      return;
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported MCP method: ${method}` } });
  }
  return { handle };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bridge = createCodexToolBridge();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { process.stderr.write('[remotelab-local-bridge] invalid JSON-RPC input\n'); return; }
    void bridge.handle(message).catch((failure) => process.stderr.write(`[remotelab-local-bridge] ${failure?.message || failure}\n`));
  });
}
