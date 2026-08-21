import {
  createRemoteLabHttpClient,
  DEFAULT_CHAT_BASE_URL,
  normalizeBaseUrl,
  trimString,
} from './remotelab-http-client.mjs';

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab schedule <command> [options]\n\nCommands:\n  create                   Create a recurring five-field cron schedule\n  list                     List recurring schedules\n  get <schedule-id>        Load one schedule\n  cancel <schedule-id>     Cancel future and pending occurrences\n  delete <schedule-id>     Delete a schedule\n\nCreate options:\n  --cron <expression>      Required five-field cron expression\n  --timezone <iana-zone>   IANA timezone (default: Asia/Shanghai)\n  --text <text>            Required prompt for each occurrence\n  --session <id>           Source session used to seed isolated occurrences (default: $REMOTELAB_SESSION_ID)\n  --reuse-session          Run every occurrence in the source session (opt-in legacy mode)\n  --source-request <id>    Pin delivery to this source request\n  --no-source-delivery     Keep generated results in RemoteLab only\n  --title <text>           Optional label\n  --tool/--model/--effort  Optional runtime overrides\n  --thinking               Enable thinking\n\nCancel options:\n  --include-active         Also cancel the currently active occurrence\n\nGeneral options:\n  --json                   Print JSON\n  --base-url <url>         RemoteLab base URL\n  --help                   Show this help\n`);
}

function parseArgs(argv = []) {
  const command = trimString(argv[0]).toLowerCase();
  const consumesId = new Set(['get', 'cancel', 'delete']).has(command);
  const options = {
    command,
    scheduleId: consumesId ? trimString(argv[1]) : '',
    sessionId: trimString(process.env.REMOTELAB_SESSION_ID),
    sourceRequestId: trimString(process.env.REMOTELAB_REQUEST_ID),
    sourceDelivery: true,
    cron: '',
    timezone: 'Asia/Shanghai',
    text: '',
    title: '',
    tool: '',
    model: '',
    effort: '',
    thinking: false,
    reuseSession: false,
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
    else if (arg === '--source-request') options.sourceRequestId = take();
    else if (arg === '--cron') options.cron = take();
    else if (arg === '--timezone') options.timezone = take();
    else if (arg === '--text') options.text = take();
    else if (arg === '--title') options.title = take();
    else if (arg === '--tool') options.tool = take();
    else if (arg === '--model') options.model = take();
    else if (arg === '--effort') options.effort = take();
    else if (arg === '--base-url') options.baseUrl = take();
    else if (arg === '--thinking') options.thinking = true;
    else if (arg === '--reuse-session') options.reuseSession = true;
    else if (arg === '--include-active') options.includeActive = true;
    else if (arg === '--no-source-delivery') options.sourceDelivery = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const field of ['sessionId', 'sourceRequestId', 'cron', 'timezone', 'text', 'title', 'tool', 'model', 'effort']) {
    options[field] = trimString(options[field]);
  }
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
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
    `executionMode: ${schedule.executionMode}`,
    `sessionId: ${schedule.sessionId}`,
    `cron: ${schedule.cron}`,
    `timezone: ${schedule.timezone}`,
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
    if (!options.cron) throw new Error('--cron is required');
    if (!options.text) throw new Error('--text is required');
    const body = {
      sessionId: options.sessionId,
      executionMode: options.reuseSession ? 'existing_session' : 'fresh_session',
      cron: options.cron,
      timezone: options.timezone || 'Asia/Shanghai',
      text: options.text,
      ...(options.title ? { title: options.title } : {}),
      ...(options.tool ? { tool: options.tool } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.thinking ? { thinking: true } : {}),
      ...(options.sourceDelivery ? { deliverTo: 'session_source' } : {}),
      ...(options.sourceRequestId ? { sourceRequestId: options.sourceRequestId } : {}),
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
