import {
  createRemoteLabHttpClient,
  DEFAULT_CHAT_BASE_URL,
  normalizeBaseUrl,
  trimString,
} from './remotelab-http-client.mjs';

const DEFAULT_WAIT_INTERVAL_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:
  remotelab local-bridge <command> [options]

Commands:
  pair-code create            Create a pairing code for the current session
  bootstrap create            Create a first-launch bootstrap token for the current session
  status                      Show linked local-helper status for the current session
  list                        List entries under a linked local root
  find                        Search within a linked local root
  stat                        Read file metadata from a linked local root
  read-text                   Read text content from a linked local root
  stage                       Upload a linked local file into the current session
  pack                        Pack and upload a linked local directory as tar.gz

General options:
  --session <id>              Target session id (default: $REMOTELAB_SESSION_ID)
  --base-url <url>            RemoteLab base URL (default: $REMOTELAB_CHAT_BASE_URL or local 7690)
  --timeout-ms <ms>           Wait timeout for queued commands
  --json                      Print JSON
  --help                      Show this help

Filesystem options:
  --root <alias>              Allowed root alias
  --path <relPath>            Relative path inside the allowed root
  --depth <n>                 List depth
  --query <text>              Search query for find
  --glob <pattern>            Glob pattern for find
  --max-results <n>           Result cap for find
  --offset <n>                Byte offset for read-text
  --max-bytes <n>             Byte limit for read-text
  --encoding <name>           Encoding for read-text
  --mime-type <type>          Optional mime type hint for stage
  --size-bytes <n>            Optional size hint for stage
  --purpose <text>            Optional stage purpose (default: attach_to_session)
  --exclude <patterns>        Comma-separated exclude patterns for pack

Examples:
  remotelab local-bridge pair-code create --session sess_123 --json
  remotelab local-bridge status --json
  remotelab local-bridge list --root projects --path . --json
  remotelab local-bridge find --root projects --path . --query tower --glob "*.rvt" --json
  remotelab local-bridge read-text --root projects --path notes/scope.txt --json
  remotelab local-bridge stage --root projects --path A/model/main.rvt --json
`);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function writeOutput(payload, options = {}, stdout = process.stdout) {
  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv = []) {
  const options = {
    command: trimString(argv[0]).toLowerCase(),
    subcommand: trimString(argv[1]).toLowerCase(),
    sessionId: trimString(process.env.REMOTELAB_SESSION_ID),
    baseUrl: trimString(process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    json: false,
    help: false,
    rootAlias: '',
    relPath: '',
    depth: null,
    query: '',
    glob: '',
    maxResults: null,
    offset: null,
    maxBytes: null,
    encoding: '',
    mimeType: '',
    sizeBytes: null,
    purpose: '',
    exclude: '',
  };

  const startIndex = options.command === 'pair-code' || options.command === 'bootstrap' ? 2 : 1;
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--session':
        options.sessionId = argv[index + 1] || '';
        index += 1;
        break;
      case '--base-url':
        options.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInteger(argv[index + 1], DEFAULT_WAIT_TIMEOUT_MS);
        index += 1;
        break;
      case '--root':
        options.rootAlias = argv[index + 1] || '';
        index += 1;
        break;
      case '--path':
        options.relPath = argv[index + 1] || '';
        index += 1;
        break;
      case '--depth':
        options.depth = parseOptionalInteger(argv[index + 1]);
        index += 1;
        break;
      case '--query':
        options.query = argv[index + 1] || '';
        index += 1;
        break;
      case '--glob':
        options.glob = argv[index + 1] || '';
        index += 1;
        break;
      case '--max-results':
        options.maxResults = parseOptionalInteger(argv[index + 1]);
        index += 1;
        break;
      case '--offset':
        options.offset = parseOptionalInteger(argv[index + 1]);
        index += 1;
        break;
      case '--max-bytes':
        options.maxBytes = parseOptionalInteger(argv[index + 1]);
        index += 1;
        break;
      case '--encoding':
        options.encoding = argv[index + 1] || '';
        index += 1;
        break;
      case '--mime-type':
        options.mimeType = argv[index + 1] || '';
        index += 1;
        break;
      case '--size-bytes':
        options.sizeBytes = parseOptionalInteger(argv[index + 1]);
        index += 1;
        break;
      case '--purpose':
        options.purpose = argv[index + 1] || '';
        index += 1;
        break;
      case '--exclude':
        options.exclude = argv[index + 1] || '';
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.command = trimString(options.command).toLowerCase();
  options.subcommand = trimString(options.subcommand).toLowerCase();
  options.sessionId = trimString(options.sessionId);
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  options.rootAlias = trimString(options.rootAlias);
  options.relPath = trimString(options.relPath);
  options.query = trimString(options.query);
  options.glob = trimString(options.glob);
  options.encoding = trimString(options.encoding);
  options.mimeType = trimString(options.mimeType);
  options.purpose = trimString(options.purpose) || 'attach_to_session';
  options.exclude = trimString(options.exclude);
  return options;
}

function requireSessionId(options) {
  if (!options.sessionId) {
    throw new Error('No session id provided. Pass --session or set REMOTELAB_SESSION_ID.');
  }
}

function buildCommandPayload(options) {
  const rootAlias = options.rootAlias;
  const relPath = options.relPath || '.';
  if (!rootAlias) {
    throw new Error('--root is required');
  }

  if (options.command === 'list') {
    return {
      name: 'list',
      args: {
        rootAlias,
        relPath,
        ...(options.depth !== null ? { depth: options.depth } : {}),
      },
    };
  }

  if (options.command === 'find') {
    return {
      name: 'find',
      args: {
        rootAlias,
        relPath,
        ...(options.query ? { query: options.query } : {}),
        ...(options.glob ? { glob: options.glob } : {}),
        ...(options.maxResults !== null ? { maxResults: options.maxResults } : {}),
      },
    };
  }

  if (options.command === 'stat') {
    return {
      name: 'stat',
      args: { rootAlias, relPath },
    };
  }

  if (options.command === 'read-text') {
    return {
      name: 'read_text',
      args: {
        rootAlias,
        relPath,
        ...(options.offset !== null ? { offset: options.offset } : {}),
        ...(options.maxBytes !== null ? { maxBytes: options.maxBytes } : {}),
        ...(options.encoding ? { encoding: options.encoding } : {}),
      },
    };
  }

  if (options.command === 'stage') {
    return {
      name: 'stage',
      args: {
        rootAlias,
        relPath,
        purpose: options.purpose,
        ...(options.mimeType ? { mimeType: options.mimeType } : {}),
        ...(options.sizeBytes !== null ? { sizeBytes: options.sizeBytes } : {}),
      },
    };
  }

  if (options.command === 'pack') {
    const exclude = options.exclude
      ? options.exclude.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    return {
      name: 'pack',
      args: {
        rootAlias,
        relPath,
        ...(exclude.length > 0 ? { exclude } : {}),
      },
    };
  }

  throw new Error(`Unsupported local-bridge command: ${options.command}`);
}

async function waitForCommand(client, sessionId, commandId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/local-bridge/commands/${encodeURIComponent(commandId)}`);
    if (!result.response.ok || !result.json?.command?.id) {
      throw new Error(result.json?.error || result.text || `Failed to load local-bridge command ${commandId}`);
    }
    const command = result.json.command;
    if (command.state === 'completed' || command.state === 'failed') {
      return command;
    }
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_WAIT_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for local-bridge command ${commandId}; retry with a larger --timeout-ms if the remote operation is expected to run longer`);
}

export async function runLocalBridgeCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    printHelp(stdout);
    return 0;
  }
  const client = createRemoteLabHttpClient({ baseUrl: options.baseUrl });

  if (options.command === 'pair-code') {
    requireSessionId(options);
    if (options.subcommand !== 'create') {
      throw new Error('pair-code requires the `create` subcommand');
    }
    const result = await client.request(`/api/sessions/${encodeURIComponent(options.sessionId)}/local-bridge/pairing-code`, {
      method: 'POST',
      body: {},
    });
    if (!result.response.ok || !result.json?.pairing?.code) {
      throw new Error(result.json?.error || result.text || `Failed to create pairing code (${result.response.status})`);
    }
    writeOutput({ pairing: result.json.pairing }, options, stdout);
    return 0;
  }

  if (options.command === 'bootstrap') {
    requireSessionId(options);
    if (options.subcommand !== 'create') {
      throw new Error('bootstrap requires the `create` subcommand');
    }
    const result = await client.request(`/api/sessions/${encodeURIComponent(options.sessionId)}/local-bridge/bootstrap`, {
      method: 'POST',
      body: {},
    });
    if (!result.response.ok || !result.json?.bootstrap?.token) {
      throw new Error(result.json?.error || result.text || `Failed to create local bridge bootstrap token (${result.response.status})`);
    }
    writeOutput({ bootstrap: result.json.bootstrap }, options, stdout);
    return 0;
  }

  if (options.command === 'status') {
    requireSessionId(options);
    const result = await client.request(`/api/sessions/${encodeURIComponent(options.sessionId)}/local-bridge/status`);
    if (!result.response.ok) {
      throw new Error(result.json?.error || result.text || `Failed to load local-bridge status (${result.response.status})`);
    }
    writeOutput({ localBridge: result.json?.localBridge || null }, options, stdout);
    return 0;
  }

  requireSessionId(options);
  const payload = buildCommandPayload(options);
  const created = await client.request(`/api/sessions/${encodeURIComponent(options.sessionId)}/local-bridge/commands`, {
    method: 'POST',
    body: payload,
  });
  if (!created.response.ok || !created.json?.command?.id) {
    throw new Error(created.json?.error || created.text || `Failed to queue local-bridge command (${created.response.status})`);
  }

  const command = await waitForCommand(client, options.sessionId, created.json.command.id, options.timeoutMs);
  if (command.state === 'failed') {
    throw new Error(command.error || `Local-bridge command failed: ${command.id}`);
  }
  writeOutput({ command }, options, stdout);
  return 0;
}
