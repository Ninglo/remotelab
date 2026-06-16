import { readFile } from 'fs/promises';

import {
  buildSessionUrl,
  createRemoteLabHttpClient,
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_RUN_POLL_TIMEOUT_MS,
  normalizeBaseUrl,
  parsePositiveInteger,
  loadAssistantReply,
  trimString,
} from './remotelab-http-client.mjs';

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab api <METHOD> <PATH> [options]\n\nExamples:\n  remotelab api GET /api/tools\n  remotelab api POST /api/sessions --body '{"folder":"~/code/remotelab","tool":"codex","model":"gpt-5.4","effort":"medium","name":"scratch"}'\n  remotelab api POST /api/sessions/<session-id>/messages --body '{"text":"hello"}' --wait-run\n\nOptions:\n  --body <json>            JSON request body; use - to read from stdin\n  --body-file <path>       Read JSON request body from a file\n  --wait-run               If the response contains run.id, wait for terminal state\n  --timeout-ms <ms>        Wait timeout for --wait-run (default: 600000)\n  --base-url <url>         RemoteLab base URL (default: $REMOTELAB_CHAT_BASE_URL or local 7690)\n  --help                   Show this help\n`);
}

function parseArgs(argv = []) {
  const options = {
    method: '',
    path: '',
    body: '',
    bodyFile: '',
    waitRun: false,
    timeoutMs: DEFAULT_RUN_POLL_TIMEOUT_MS,
    baseUrl: trimString(process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--body':
        options.body = argv[index + 1] || '';
        index += 1;
        break;
      case '--body-file':
        options.bodyFile = argv[index + 1] || '';
        index += 1;
        break;
      case '--wait-run':
        options.waitRun = true;
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInteger(argv[index + 1], DEFAULT_RUN_POLL_TIMEOUT_MS);
        index += 1;
        break;
      case '--base-url':
        options.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        positional.push(arg);
        break;
    }
  }

  options.method = trimString(positional[0]).toUpperCase();
  options.path = trimString(positional[1]);
  options.body = options.body === undefined ? '' : String(options.body);
  options.bodyFile = trimString(options.bodyFile);
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

async function readStdin(stdin = process.stdin) {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveRequestBody(options, stdin) {
  if (options.body && options.bodyFile) {
    throw new Error('--body and --body-file cannot be used together');
  }

  let raw = '';
  if (options.body === '-') {
    raw = await readStdin(stdin);
  } else if (options.body) {
    raw = options.body;
  } else if (options.bodyFile) {
    raw = await readFile(options.bodyFile, 'utf8');
  }

  const trimmed = trimString(raw);
  if (!trimmed) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function extractSessionId(path, payload) {
  const payloadSessionId = trimString(payload?.session?.id);
  if (payloadSessionId) return payloadSessionId;

  const match = String(path || '').match(/^\/api\/sessions\/([^/]+)/);
  if (!match) return '';

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return trimString(match[1]);
  }
}

function writeJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runRemoteLabApiCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stdin = io.stdin || process.stdin;
  const options = parseArgs(argv);

  if (options.help) {
    printHelp(stdout);
    return 0;
  }

  if (!options.method || !options.path) {
    throw new Error('Usage: remotelab api <METHOD> <PATH> [options]');
  }

  const client = createRemoteLabHttpClient({ baseUrl: options.baseUrl });
  const body = await resolveRequestBody(options, stdin);
  const result = await client.request(options.path, {
    method: options.method,
    body,
  });

  if (!result.response.ok) {
    throw new Error(result.json?.error || result.text || `RemoteLab request failed (${result.response.status})`);
  }

  let output = result.json ?? { text: result.text };

  if (options.waitRun) {
    const runId = trimString(output?.run?.id);
    if (!runId) {
      throw new Error('--wait-run requires the response to include run.id');
    }
    const run = await client.waitForRun(runId, { timeoutMs: options.timeoutMs });
    const sessionId = extractSessionId(options.path, output);
    output = {
      ...output,
      awaitedRun: run,
    };
    if (sessionId) {
      output.sessionUrl = buildSessionUrl(sessionId);
      const reply = await loadAssistantReply(client, sessionId, runId).catch(() => '');
      if (reply) output.reply = reply;
    }
  }

  writeJson(stdout, output);
  return 0;
}
