import { resolve } from 'path';
import { readFile } from 'node:fs/promises';
import { workboardReceipt } from './workboard-command.mjs';

import {
  createRemoteLabHttpClient,
  DEFAULT_CHAT_BASE_URL,
  normalizeBaseUrl,
  trimString,
} from './remotelab-http-client.mjs';

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab assistant-message [options]\n\nOptions:\n  --text <text>             Optional assistant message text\n  --workboard-file <path>   JSON task snapshot with IDs, revision, statuses and evidence refs\n  --file <path>             Local file to publish into the current session (repeatable)\n  --session <id>            Target session id (default: $REMOTELAB_SESSION_ID)\n  --run-id <id>             Associate the message with a run (default: $REMOTELAB_RUN_ID)\n  --source <text>           Optional assistant message source tag\n  --progress-mode <mode>    Start work path expanded or collapsed in this Run\n  --as-file                 Force file-card rendering for every attached file\n  --json                    Print machine-readable JSON\n  --compact                 Print only receipt fields with --json\n  --base-url <url>          RemoteLab base URL (default: $REMOTELAB_CHAT_BASE_URL or local 7690)\n  --help                    Show this help\n\nExamples:\n  remotelab assistant-message --text "Generated report attached." --file ./report.pdf --json\n  node "$REMOTELAB_PROJECT_ROOT/cli.js" assistant-message --file ./preview.png --file ./notes.txt --json\n`);
}

function parseArgs(argv = []) {
  const options = {
    text: '',
    sessionId: trimString(process.env.REMOTELAB_SESSION_ID),
    runId: trimString(process.env.REMOTELAB_RUN_ID),
    source: 'assistant_message_command',
    files: [],
    asFile: false,
    json: false,
    baseUrl: trimString(process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--text':
        options.text = argv[index + 1] || '';
        index += 1;
        break;
      case '--workboard-file':
        options.workboardFile = argv[++index] || '';
        break;
      case '--file':
        options.files.push(argv[index + 1] || '');
        index += 1;
        break;
      case '--session':
        options.sessionId = argv[index + 1] || '';
        index += 1;
        break;
      case '--run-id':
        options.runId = argv[index + 1] || '';
        index += 1;
        break;
      case '--source':
        options.source = argv[index + 1] || '';
        index += 1;
        break;
      case '--progress-mode':
        options.progressMode = argv[++index];
        if (!['expanded', 'collapsed'].includes(options.progressMode)) throw new Error('--progress-mode needs expanded or collapsed');
        break;
      case '--as-file':
        options.asFile = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--compact':
        options.compact = true;
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
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.text = typeof options.text === 'string' ? options.text : '';
  options.sessionId = trimString(options.sessionId);
  options.runId = trimString(options.runId);
  options.source = trimString(options.source) || 'assistant_message_command';
  options.files = options.files.map((filePath) => trimString(filePath)).filter(Boolean);
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

function buildPayload(options = {}) {
  return {
    ...(options.workboard ? { workboard: options.workboard, source: 'workboard_checklist' } : {}),
    ...(options.text ? { text: options.text } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.progressMode ? { progressMode: options.progressMode } : {}),
    ...(options.source && !options.workboard ? { source: options.source } : {}),
    ...(options.files.length > 0
      ? {
          attachments: options.files.map((filePath) => ({
            localPath: resolve(filePath),
            ...(options.asFile ? { renderAs: 'file' } : {}),
          })),
        }
      : {}),
  };
}

function writeResult(result, options = {}, stdout = process.stdout) {
  if (options.json) {
    const output = options.compact && result?.event?.workboard ? workboardReceipt(result)
      : options.compact ? { eventSeq: result?.event?.seq, sessionId: result?.session?.id,
        ...(result.progressPolicy ? { progressPolicy: result.progressPolicy } : {}) } : result;
    stdout.write(`${JSON.stringify(output, null, options.compact ? 0 : 2)}\n`);
    return;
  }

  const event = result?.event && typeof result.event === 'object' ? result.event : {};
  const attachmentNames = Array.isArray(event.attachments)
    ? event.attachments
      .map((attachment) => trimString(attachment?.originalName || attachment?.filename))
      .filter(Boolean)
    : [];
  const lines = [
    `sessionId: ${trimString(result?.session?.id)}`,
    `eventSeq: ${event?.seq ?? ''}`,
  ];
  if (trimString(event?.content)) {
    lines.push(`text: ${trimString(event.content)}`);
  }
  if (attachmentNames.length > 0) {
    lines.push(`attachments: ${attachmentNames.join(', ')}`);
  }
  stdout.write(`${lines.join('\n')}\n`);
}

export async function runAssistantMessageCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help) {
    printHelp(stdout);
    return 0;
  }
  if (!options.sessionId) {
    throw new Error('No session id provided. Pass --session or set REMOTELAB_SESSION_ID.');
  }
  if (options.workboardFile) options.workboard = JSON.parse(await readFile(resolve(options.workboardFile), 'utf8'));
  if (!trimString(options.text) && options.files.length === 0 && !options.workboard && !options.progressMode) {
    throw new Error('Provide --text, at least one --file, or both.');
  }

  const client = createRemoteLabHttpClient({ baseUrl: options.baseUrl });
  const result = await client.request(`/api/sessions/${encodeURIComponent(options.sessionId)}/assistant-messages`, {
    method: 'POST',
    body: buildPayload(options),
  });
  if (!result.response.ok || (!result.json?.event && !result.json?.progressPolicy)) {
    throw new Error(result.json?.error || result.text || `Failed to append assistant message (${result.response.status})`);
  }

  writeResult(result.json, options, stdout);
  return 0;
}
