import {
  createRemoteLabHttpClient,
  DEFAULT_CHAT_BASE_URL,
  normalizeBaseUrl,
  trimString,
} from './remotelab-http-client.mjs';

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab trigger <command> [options]\n\nCommands:\n  create                   Create a one-time task in a fresh session\n  list                     List triggers\n  get <trigger-id>         Load one trigger\n  cancel <trigger-id>      Disable a trigger without deleting it\n  delete <trigger-id>      Delete a trigger\n\nCreate options:\n  --text <text>            Required prompt for the triggered task\n  --in <duration>          Relative delay like 30s, 10m, 2h, 1d\n  --at <timestamp>         Absolute ISO timestamp\n  --session <id>           Source session used to seed the fresh task (default: $REMOTELAB_SESSION_ID)\n  --reuse-session          Inject into the source session instead (explicit legacy mode)\n  --source-request <id>    Pin delivery to the source of this request (default: $REMOTELAB_REQUEST_ID)\n  --no-source-delivery     Keep the generated result in RemoteLab only\n  --title <text>           Optional human-readable label\n  --tool <id>              Optional runtime override\n  --model <id>             Optional runtime override\n  --effort <level>         Optional runtime override\n  --thinking               Enable thinking mode for the triggered run\n\nGeneral options:\n  --json                   Print machine-readable JSON\n  --base-url <url>         RemoteLab base URL (default: $REMOTELAB_CHAT_BASE_URL or local 7690)\n  --help                   Show this help\n\nExamples:\n  remotelab trigger create --in 2h --text "Review this later"\n  remotelab trigger create --session sess_123 --at 2026-03-21T09:00:00Z --text "Morning follow-up" --json\n  remotelab trigger list --session sess_123 --json\n  remotelab trigger cancel trg_1234567890abcdef123456\n`);
}

function parseDurationMs(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return 0;
  const match = normalized.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 0;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isInteger(amount) || amount <= 0) return 0;
  const unit = match[2];
  const factor = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[unit] || 0;
  return amount * factor;
}

function resolveScheduledAt(options) {
  const inDuration = trimString(options.in);
  const at = trimString(options.at);
  if (!!inDuration === !!at) {
    throw new Error('Provide exactly one of --in or --at');
  }
  if (inDuration) {
    const delayMs = parseDurationMs(inDuration);
    if (!(delayMs > 0)) {
      throw new Error('--in must be a positive duration like 30s, 10m, 2h, or 1d');
    }
    return new Date(Date.now() + delayMs).toISOString();
  }
  const parsedAt = Date.parse(at);
  if (!Number.isFinite(parsedAt)) {
    throw new Error('--at must be a valid timestamp');
  }
  return new Date(parsedAt).toISOString();
}

function buildOutputLines(trigger) {
  return [
    `id: ${trimString(trigger?.id)}`,
    `status: ${trimString(trigger?.status)}`,
    trimString(trigger?.sourceSessionId) ? `sourceSessionId: ${trimString(trigger.sourceSessionId)}` : '',
    trimString(trigger?.sessionId) ? `sessionId: ${trimString(trigger.sessionId)}` : '',
    `scheduledAt: ${trimString(trigger?.scheduledAt)}`,
    trimString(trigger?.title) ? `title: ${trimString(trigger.title)}` : '',
    trimString(trigger?.text) ? `text: ${trimString(trigger.text)}` : '',
  ].filter(Boolean);
}

function writeOutput(payload, options = {}, stdout = process.stdout) {
  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (Array.isArray(payload?.triggers)) {
    const blocks = payload.triggers.map((trigger) => buildOutputLines(trigger).join('\n'));
    stdout.write(`${blocks.join('\n\n')}\n`);
    return;
  }

  if (payload?.trigger) {
    stdout.write(`${buildOutputLines(payload.trigger).join('\n')}\n`);
    return;
  }

  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv = []) {
  const options = {
    command: trimString(argv[0]).toLowerCase(),
    triggerId: trimString(argv[1]),
    text: '',
    in: '',
    at: '',
    sessionId: trimString(process.env.REMOTELAB_SESSION_ID),
    title: '',
    tool: '',
    model: '',
    effort: '',
    thinking: false,
    reuseSession: false,
    sourceRequestId: trimString(process.env.REMOTELAB_REQUEST_ID),
    sourceDelivery: true,
    json: false,
    baseUrl: trimString(process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    help: false,
  };

  const valueFlags = new Set(['--text', '--in', '--at', '--session', '--source-request', '--title', '--tool', '--model', '--effort', '--base-url']);
  const commandConsumesId = new Set(['get', 'cancel', 'delete']);
  const argsStartIndex = commandConsumesId.has(options.command) ? 2 : 1;
  options.triggerId = commandConsumesId.has(options.command) ? trimString(argv[1]) : '';

  for (let index = argsStartIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--text':
        options.text = argv[index + 1] || '';
        index += 1;
        break;
      case '--in':
        options.in = argv[index + 1] || '';
        index += 1;
        break;
      case '--at':
        options.at = argv[index + 1] || '';
        index += 1;
        break;
      case '--session':
        options.sessionId = argv[index + 1] || '';
        index += 1;
        break;
      case '--title':
        options.title = argv[index + 1] || '';
        index += 1;
        break;
      case '--source-request':
        options.sourceRequestId = argv[index + 1] || '';
        index += 1;
        break;
      case '--no-source-delivery':
        options.sourceDelivery = false;
        break;
      case '--tool':
        options.tool = argv[index + 1] || '';
        index += 1;
        break;
      case '--model':
        options.model = argv[index + 1] || '';
        index += 1;
        break;
      case '--effort':
        options.effort = argv[index + 1] || '';
        index += 1;
        break;
      case '--thinking':
        options.thinking = true;
        break;
      case '--reuse-session':
        options.reuseSession = true;
        break;
      case '--json':
        options.json = true;
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
        if (valueFlags.has(arg)) {
          throw new Error(`Missing value for ${arg}`);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.command = trimString(options.command).toLowerCase();
  options.triggerId = trimString(options.triggerId);
  options.text = String(options.text || '');
  options.in = trimString(options.in);
  options.at = trimString(options.at);
  options.sessionId = trimString(options.sessionId);
  options.title = trimString(options.title);
  options.sourceRequestId = trimString(options.sourceRequestId);
  options.tool = trimString(options.tool);
  options.model = trimString(options.model);
  options.effort = trimString(options.effort);
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

export async function runTriggerCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    printHelp(stdout);
    return 0;
  }

  const client = createRemoteLabHttpClient({ baseUrl: options.baseUrl });

  if (options.command === 'create') {
    if (!options.sessionId) {
      throw new Error('No session id provided. Pass --session or set REMOTELAB_SESSION_ID.');
    }
    if (!trimString(options.text)) {
      throw new Error('--text is required');
    }
    const scheduledAt = resolveScheduledAt(options);
    const body = {
      sessionId: options.sessionId,
      executionMode: options.reuseSession ? 'existing_session' : 'fresh_session',
      scheduledAt,
      text: trimString(options.text),
      ...(options.title ? { title: options.title } : {}),
      ...(options.tool ? { tool: options.tool } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.thinking ? { thinking: true } : {}),
      ...(options.sourceDelivery ? { deliverTo: 'session_source' } : {}),
      ...(options.sourceRequestId ? { sourceRequestId: options.sourceRequestId } : {}),
    };
    const result = await client.request('/api/triggers', { method: 'POST', body });
    if (!result.response.ok || !result.json?.trigger?.id) {
      throw new Error(result.json?.error || result.text || `Failed to create trigger (${result.response.status})`);
    }
    writeOutput({ trigger: result.json.trigger }, options, stdout);
    return 0;
  }

  if (options.command === 'list') {
    const query = options.sessionId ? `?sessionId=${encodeURIComponent(options.sessionId)}` : '';
    const result = await client.request(`/api/triggers${query}`);
    if (!result.response.ok || !Array.isArray(result.json?.triggers)) {
      throw new Error(result.json?.error || result.text || `Failed to list triggers (${result.response.status})`);
    }
    writeOutput({ triggers: result.json.triggers }, options, stdout);
    return 0;
  }

  if (!options.triggerId) {
    throw new Error(`${options.command} requires a trigger id`);
  }

  if (options.command === 'get') {
    const result = await client.request(`/api/triggers/${encodeURIComponent(options.triggerId)}`);
    if (!result.response.ok || !result.json?.trigger?.id) {
      throw new Error(result.json?.error || result.text || `Failed to load trigger (${result.response.status})`);
    }
    writeOutput({ trigger: result.json.trigger }, options, stdout);
    return 0;
  }

  if (options.command === 'cancel') {
    const result = await client.request(`/api/triggers/${encodeURIComponent(options.triggerId)}`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    if (!result.response.ok || !result.json?.trigger?.id) {
      throw new Error(result.json?.error || result.text || `Failed to cancel trigger (${result.response.status})`);
    }
    writeOutput({ trigger: result.json.trigger }, options, stdout);
    return 0;
  }

  if (options.command === 'delete') {
    const result = await client.request(`/api/triggers/${encodeURIComponent(options.triggerId)}`, {
      method: 'DELETE',
    });
    if (!result.response.ok || !result.json?.trigger?.id) {
      throw new Error(result.json?.error || result.text || `Failed to delete trigger (${result.response.status})`);
    }
    writeOutput({ trigger: result.json.trigger }, options, stdout);
    return 0;
  }

  throw new Error(`Unknown trigger command: ${options.command}`);
}
