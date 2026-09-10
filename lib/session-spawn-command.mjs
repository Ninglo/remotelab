import { readFile } from 'node:fs/promises';
import {
  buildSessionUrl,
  createRemoteLabHttpClient,
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_RUN_POLL_TIMEOUT_MS,
  loadAssistantReply,
  normalizeBaseUrl,
  parsePositiveInteger,
  trimString,
} from './remotelab-http-client.mjs';

function normalizeOutputMode(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || normalized === 'default') return 'default';
  if (normalized === 'final-only') return 'final-only';
  throw new Error(`Unsupported output mode: ${value}`);
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab session-spawn --task "<focused task>" [options]\n\nOptions:\n  --task <text>             Delegated task / handoff goal\n  --task-file <path>        Read a UTF-8 handoff instead of --task\n  --guide                   Print the shipped visible delegation workflow\n  --source-session <id>     Source session id (default: $REMOTELAB_SESSION_ID)\n  --source-run <id>         Inherit this source run snapshot (default: $REMOTELAB_RUN_ID)\n  --name <text>             Optional initial session name\n  --tool <id>               Optional child tool override\n  --wait                    Wait for the spawned run and return its reply\n  --internal                Create a hidden internal child session and suppress parent notice\n  --output-mode <mode>      Output mode: default | final-only\n  --final-only              Sugar for --wait plus --output-mode final-only\n  --json                    Print machine-readable JSON\n  --base-url <url>          RemoteLab base URL (default: $REMOTELAB_CHAT_BASE_URL or local 7690)\n  --timeout-ms <ms>         Wait timeout for --wait (default: 600000)\n  --help                    Show this help\n`);
}

function parseArgs(argv = []) {
  const options = {
    task: '',
    taskFile: '',
    sourceSessionId: trimString(process.env.REMOTELAB_SESSION_ID),
    sourceRunId: trimString(process.env.REMOTELAB_RUN_ID),
    guide: false,
    name: '',
    tool: '',
    wait: false,
    internal: false,
    outputMode: 'default',
    json: false,
    baseUrl: trimString(process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    timeoutMs: DEFAULT_RUN_POLL_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--task':
        options.task = argv[index + 1] || '';
        index += 1;
        break;
      case '--task-file':
        options.taskFile = argv[index + 1] || '';
        index += 1;
        break;
      case '--source-run':
        options.sourceRunId = argv[index + 1] || '';
        index += 1;
        break;
      case '--guide':
        options.guide = true;
        break;
      case '--source-session':
        options.sourceSessionId = argv[index + 1] || '';
        index += 1;
        break;
      case '--name':
        options.name = argv[index + 1] || '';
        index += 1;
        break;
      case '--tool':
        options.tool = argv[index + 1] || '';
        index += 1;
        break;
      case '--wait':
        options.wait = true;
        break;
      case '--internal':
        options.internal = true;
        break;
      case '--output-mode':
        options.outputMode = argv[index + 1] || '';
        index += 1;
        break;
      case '--final-only':
        options.wait = true;
        options.outputMode = 'final-only';
        break;
      case '--json':
        options.json = true;
        break;
      case '--base-url':
        options.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInteger(argv[index + 1], DEFAULT_RUN_POLL_TIMEOUT_MS);
        index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.task = trimString(options.task);
  options.taskFile = trimString(options.taskFile);
  options.sourceSessionId = trimString(options.sourceSessionId);
  if (options.sourceSessionId !== trimString(process.env.REMOTELAB_SESSION_ID) && !argv.includes('--source-run')) options.sourceRunId = '';
  options.sourceRunId = trimString(options.sourceRunId);
  options.name = trimString(options.name);
  options.tool = trimString(options.tool);
  options.outputMode = normalizeOutputMode(options.outputMode);
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

function writeResult(result, options = {}, stdout = process.stdout) {
  if (options.outputMode === 'final-only') {
    if (options.json) {
      stdout.write(`${JSON.stringify({
        state: result.state || '',
        reply: trimString(result.reply || ''),
      }, null, 2)}\n`);
      return;
    }
    stdout.write(`${trimString(result.reply || '')}\n`);
    return;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [
    `sessionId: ${result.sessionId || ''}`,
    `runId: ${result.runId || ''}`,
    `state: ${result.state || ''}`,
    `sessionUrl: ${result.sessionUrl || ''}`,
  ];
  if (result.reply) {
    lines.push('', result.reply);
  }
  stdout.write(`${lines.join('\n')}\n`);
}

export async function runSessionSpawnCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const options = parseArgs(argv);
  if (options.help) {
    printHelp(stdout);
    return 0;
  }
  if (options.guide) {
    stdout.write(await readFile(new URL('../docs/platform-skills/session-delegate.md', import.meta.url), 'utf8'));
    return 0;
  }
  if (options.taskFile) {
    if (options.task) throw new Error('Provide only one of --task and --task-file');
    options.task = (await readFile(options.taskFile, 'utf8')).trim();
  }
  if (!options.task) {
    throw new Error('--task is required');
  }
  if (!options.sourceSessionId) {
    throw new Error('No source session id provided. Pass --source-session or set REMOTELAB_SESSION_ID.');
  }
  if (options.outputMode === 'final-only' && !options.wait) {
    throw new Error('--output-mode final-only requires --wait');
  }

  const client = createRemoteLabHttpClient({ baseUrl: options.baseUrl });

  const result = await client.request(`/api/sessions/${encodeURIComponent(options.sourceSessionId)}/delegate`, {
    method: 'POST',
    body: {
      task: options.task,
      ...(options.sourceRunId ? { sourceRunId: options.sourceRunId } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.tool ? { tool: options.tool } : {}),
      ...(options.internal ? { internal: true } : {}),
    },
  });
  if (!result.response.ok || !result.json?.session?.id || !result.json?.run?.id) {
    throw new Error(result.json?.error || result.text || `Failed to spawn session (${result.response.status})`);
  }

  const output = {
    sourceSessionId: options.sourceSessionId,
    task: options.task,
    sessionId: result.json.session.id,
    sessionName: trimString(result.json.session.name || ''),
    runId: result.json.run.id,
    state: trimString(result.json.run.state) || 'accepted',
    sessionUrl: trimString(result.json.sessionUrl) || buildSessionUrl(result.json.session.id),
  };

  if (options.wait) {
    const run = await client.waitForRun(result.json.run.id, { timeoutMs: options.timeoutMs });
    output.state = run.state;
    output.reply = await loadAssistantReply(client, result.json.session.id, result.json.run.id);
    if (run.state !== 'completed') {
      writeResult(output, options, stdout);
      stderr.write(`Child session run finished in state ${run.state}.\n`);
      return 1;
    }
  }

  writeResult(output, options, stdout);
  return 0;
}
