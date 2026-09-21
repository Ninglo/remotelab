import { scheduledConversationOptions } from './scheduled-conversation-command.mjs';
import { readFile } from 'fs/promises';
import {
  createRemoteLabHttpClient,
  DEFAULT_CHAT_BASE_URL,
  normalizeBaseUrl,
  trimString,
} from './remotelab-http-client.mjs';

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab schedule <command> [options]\n\nCommands:\n  create                   Create a recurring task\n  list                     List recurring tasks\n  get <schedule-id>        Load one task\n  cancel <schedule-id>     Cancel future and pending occurrences\n  delete <schedule-id>     Delete a task\n\nCreate options:\n  --cron <expression>      Five-field cron expression\n  --every <duration>       Interval such as 10s, 5m, or 2h (minimum 10s)\n  --timezone <iana-zone>   IANA timezone for cron (default: Asia/Shanghai)\n  --times <count>          Stop after this many Agent admissions\n  --max-checks <count>     Stop after this many condition checks\n  --until <timestamp>      Stop at this ISO timestamp\n  --gate-file <path>       Run a snapshotted script before admitting the Agent\n  --gate-runtime <runtime> bash, python, or node (default: bash)\n  --gate-timeout <seconds> Script timeout, 1-30 seconds (default: 5)\n  --cooldown <duration>    Minimum time between matched admissions\n  --text <text>            Required prompt for each admitted occurrence\n  --session <id>           Source Session (default: $REMOTELAB_SESSION_ID)\n  --conversation <json|source>  Bind result delivery to an external conversation\n  --conversation-file <path>   Read the same binding JSON from a file\n  --source-request <id>    Pin result delivery to this source request\n  --no-source-delivery     Keep generated results in RemoteLab only\n  --title <text>           Optional label\n  --tool/--model/--effort  Optional runtime overrides\n  --thinking               Enable thinking\n\nGate output:\n  Print exactly yes/no, or JSON like {"trigger":true,"reason":"changed","dedupeKey":"v2"}.\n  Gate errors fail closed and never admit the Agent.\n\nCancel options:\n  --include-active         Also cancel the currently active occurrence\n\nGeneral options:\n  --json                   Print JSON\n  --base-url <url>         RemoteLab base URL\n  --help                   Show this help\n`);
  stdout.write(`\nConversation behavior:\n  A group-only JSON starts a new topic and independent Session.\n  --conversation source and --source-request continue the source request's bound Session/topic.\n`);
}

function parseArgs(argv = []) {
  const command = trimString(argv[0]).toLowerCase();
  const consumesId = new Set(['get', 'cancel', 'delete']).has(command);
  const options = {
    command,
    scheduleId: consumesId ? trimString(argv[1]) : '',
    sessionId: trimString(process.env.REMOTELAB_SESSION_ID),
    sourceRequestId: trimString(process.env.REMOTELAB_REQUEST_ID),
    sourceDelivery: undefined,
    cron: '',
    every: '',
    timezone: 'Asia/Shanghai',
    text: '',
    title: '',
    tool: '',
    model: '',
    effort: '',
    thinking: false,
    times: 0,
    maxChecks: 0,
    until: '',
    gateFile: '',
    gateRuntime: 'bash',
    gateTimeout: 5,
    cooldown: '',
    includeActive: false,
    json: false,
    help: false,
    baseUrl: trimString(process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
  };
  for (let index = consumesId ? 2 : 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === '--session') options.sessionId = take();
    else if (arg === '--source-request') { options.sourceRequestId = take(); options.sourceDelivery = true; }
    else if (arg === '--conversation') options.conversation = take();
    else if (arg === '--conversation-file') options.conversationFile = take();
    else if (arg === '--cron') options.cron = take();
    else if (arg === '--every') options.every = take();
    else if (arg === '--timezone') options.timezone = take();
    else if (arg === '--text') options.text = take();
    else if (arg === '--title') options.title = take();
    else if (arg === '--tool') options.tool = take();
    else if (arg === '--model') options.model = take();
    else if (arg === '--effort') options.effort = take();
    else if (arg === '--base-url') options.baseUrl = take();
    else if (arg === '--thinking') options.thinking = true;
    else if (arg === '--times') options.times = parsePositiveInteger(take(), '--times');
    else if (arg === '--max-checks') options.maxChecks = parsePositiveInteger(take(), '--max-checks');
    else if (arg === '--until') options.until = take();
    else if (arg === '--gate-file') options.gateFile = take();
    else if (arg === '--gate-runtime') options.gateRuntime = take();
    else if (arg === '--gate-timeout') options.gateTimeout = parsePositiveInteger(take(), '--gate-timeout');
    else if (arg === '--cooldown') options.cooldown = take();
    else if (arg === '--include-active') options.includeActive = true;
    else if (arg === '--no-source-delivery') options.sourceDelivery = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const field of ['sessionId', 'sourceRequestId', 'cron', 'every', 'timezone', 'text', 'title', 'tool', 'model', 'effort', 'until', 'gateFile', 'gateRuntime', 'cooldown']) {
    options[field] = trimString(options[field]);
  }
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

function parsePositiveInteger(value, fieldName) {
  if (!/^\d+$/.test(trimString(value)) || Number.parseInt(value, 10) < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

function parseDurationSeconds(value, fieldName) {
  const match = /^(\d+)(s|m|h|d)?$/i.exec(trimString(value));
  if (!match) throw new Error(`${fieldName} must be a duration like 10s, 5m, or 2h`);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[(match[2] || 's').toLowerCase()];
  return Number.parseInt(match[1], 10) * multiplier;
}

function output(payload, options, stdout) {
  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const schedules = Array.isArray(payload.schedules) ? payload.schedules : [payload.schedule].filter(Boolean);
  stdout.write(`${schedules.map((schedule) => [
    `id: ${schedule.id}`,
    `status: ${schedule.status}`,
    `sourceSessionId: ${schedule.sourceSessionId}`,
    schedule.cadence?.type === 'interval'
      ? `everySeconds: ${schedule.cadence.everySeconds}`
      : `cron: ${schedule.cron}`,
    schedule.cadence?.type === 'interval' ? '' : `timezone: ${schedule.timezone}`,
    `nextRunAt: ${schedule.nextRunAt || ''}`,
    schedule.title ? `title: ${schedule.title}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')}\n`);
}

export async function runScheduleCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (!options.command || options.help) {
    printHelp(stdout);
    return 0;
  }
  const client = createRemoteLabHttpClient({ baseUrl: options.baseUrl });
  if (options.command === 'create') {
    if (!options.sessionId) throw new Error('No session id provided. Pass --session or set REMOTELAB_SESSION_ID.');
    if (Boolean(options.cron) === Boolean(options.every)) throw new Error('Provide exactly one of --cron or --every');
    if (!options.text) throw new Error('--text is required');
    if ((options.times && options.times < 1) || (options.maxChecks && options.maxChecks < 1)) {
      throw new Error('--times and --max-checks must be positive integers');
    }
    const everySeconds = options.every ? parseDurationSeconds(options.every, '--every') : 0;
    const cooldownSeconds = options.cooldown ? parseDurationSeconds(options.cooldown, '--cooldown') : 0;
    const gateSource = options.gateFile ? await readFile(options.gateFile, 'utf8') : '';
    const lifetimeBounds = {
      ...(options.times ? { maxExecutions: options.times } : {}),
      ...(options.maxChecks ? { maxChecks: options.maxChecks } : {}),
      ...(options.until ? { endsAt: options.until } : {}),
    };
    const body = {
      sessionId: options.sessionId,
      ...(options.cron ? { cron: options.cron, timezone: options.timezone || 'Asia/Shanghai' } : { everySeconds }),
      lifetime: Object.keys(lifetimeBounds).length > 0
        ? { mode: 'bounded', ...lifetimeBounds }
        : { mode: 'continuous' },
      gate: gateSource
        ? {
          mode: 'script',
          runtime: options.gateRuntime,
          source: gateSource,
          timeoutSeconds: options.gateTimeout,
          cooldownSeconds,
        }
        : { mode: 'direct' },
      text: options.text,
      ...(options.title ? { title: options.title } : {}),
      ...(options.tool ? { tool: options.tool } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.thinking ? { thinking: true } : {}),
      ...await scheduledConversationOptions(options),
    };
    const result = await client.request('/api/schedules', { method: 'POST', body });
    if (!result.response.ok || !result.json?.schedule?.id) {
      throw new Error(result.json?.error || result.text || `Failed to create schedule (${result.response.status})`);
    }
    output({ schedule: result.json.schedule }, options, stdout);
    return 0;
  }
  if (options.command === 'list') {
    const query = options.sessionId ? `?sessionId=${encodeURIComponent(options.sessionId)}` : '';
    const result = await client.request(`/api/schedules${query}`);
    if (!result.response.ok || !Array.isArray(result.json?.schedules)) {
      throw new Error(result.json?.error || result.text || `Failed to list schedules (${result.response.status})`);
    }
    output({ schedules: result.json.schedules }, options, stdout);
    return 0;
  }
  if (!options.scheduleId) throw new Error(`${options.command} requires a schedule id`);
  if (options.command === 'get') {
    const result = await client.request(`/api/schedules/${encodeURIComponent(options.scheduleId)}`);
    if (!result.response.ok || !result.json?.schedule?.id) throw new Error(result.json?.error || result.text || 'Failed to load schedule');
    output({ schedule: result.json.schedule }, options, stdout);
    return 0;
  }
  if (options.command === 'cancel') {
    const result = await client.request(`/api/schedules/${encodeURIComponent(options.scheduleId)}`, {
      method: 'PATCH',
      body: { enabled: false, ...(options.includeActive ? { includeActive: true } : {}) },
    });
    if (!result.response.ok || !result.json?.schedule?.id) throw new Error(result.json?.error || result.text || 'Failed to cancel schedule');
    output({ schedule: result.json.schedule }, options, stdout);
    return 0;
  }
  if (options.command === 'delete') {
    const result = await client.request(`/api/schedules/${encodeURIComponent(options.scheduleId)}`, { method: 'DELETE' });
    if (!result.response.ok || !result.json?.schedule?.id) throw new Error(result.json?.error || result.text || 'Failed to delete schedule');
    output({ schedule: result.json.schedule }, options, stdout);
    return 0;
  }
  throw new Error(`Unknown schedule command: ${options.command}`);
}
