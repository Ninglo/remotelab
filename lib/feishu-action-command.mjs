import { execFile as execFileCallback } from 'child_process';
import { createRequire } from 'module';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const CLI_SCRIPT = require.resolve('@larksuite/cli/scripts/run.js');
const ACTIONS = Object.freeze({
  'contact.get': 'Read one known open_id',
  'message.send': 'Send Bot text to one user or chat',
  'message.get': 'Read one message without reaction enrichment',
  'card.send': 'Send a fixed Bot status card',
  'reaction.add': 'Add a Bot emoji to a message',
  'reaction.list': 'Read reactions on a message',
  'calendar.list': 'List Bot-visible calendars',
  'calendar.get': 'Read one Bot-visible event',
  'calendar.create': 'Create an event on a Bot-writable calendar',
  'task.list': 'List Bot-visible tasks',
  'task.get': 'Read one Bot-visible task',
  'task.create': 'Create a task with a stable idempotency key',
  'base.records': 'Read selected fields from Base records',
  'base.upsert': 'Explicitly create or update a Base record',
});

const FLAG_NAMES = new Set([
  'profile', 'user-id', 'chat-id', 'message-id', 'text', 'title', 'body',
  'status', 'key', 'emoji', 'calendar-id', 'event-id', 'start', 'end',
  'task-guid', 'summary', 'due', 'assignee', 'tasklist-id', 'base-token',
  'table-id', 'record-id', 'field', 'fields-json', 'limit', 'dry-run', 'create',
]);
const ACTION_OPTIONS = Object.freeze({
  'contact.get': ['user-id'],
  'message.send': ['user-id', 'chat-id', 'text', 'key'],
  'message.get': ['message-id'],
  'card.send': ['user-id', 'chat-id', 'title', 'body', 'status', 'key'],
  'reaction.add': ['message-id', 'emoji'],
  'reaction.list': ['message-id', 'limit'],
  'calendar.list': [],
  'calendar.get': ['calendar-id', 'event-id'],
  'calendar.create': ['calendar-id', 'summary', 'start', 'end', 'key'],
  'task.list': ['limit'],
  'task.get': ['task-guid'],
  'task.create': ['summary', 'due', 'assignee', 'tasklist-id', 'key'],
  'base.records': ['base-token', 'table-id', 'field', 'limit'],
  'base.upsert': ['base-token', 'table-id', 'fields-json', 'record-id', 'create'],
});
const STATUS_COLORS = Object.freeze({ info: 'blue', success: 'green', warning: 'orange', error: 'red' });

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function validateId(value, pattern, name) {
  if (!pattern.test(value)) throw new Error(`--${name} has an invalid Feishu ID`);
  return value;
}

function recipientArgs(options) {
  const userId = options['user-id'];
  const chatId = options['chat-id'];
  if (Boolean(userId) === Boolean(chatId)) throw new Error('Provide exactly one of --user-id and --chat-id');
  return userId
    ? ['--user-id', validateId(userId, /^ou_[A-Za-z0-9_]+$/, 'user-id')]
    : ['--chat-id', validateId(chatId, /^oc_[A-Za-z0-9_]+$/, 'chat-id')];
}

function limitedNumber(value, fallback, max, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`--${name} must be an integer from 1 to ${max}`);
  }
  return parsed;
}

function stableKey(options) {
  const key = requireOption(options, 'key');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error('--key must be 8-128 letters, digits, _ or -');
  return key;
}

function fieldsJson(options) {
  const raw = requireOption(options, 'fields-json');
  let fields;
  try { fields = JSON.parse(raw); } catch { throw new Error('--fields-json must be a JSON object'); }
  if (!fields || Array.isArray(fields) || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    throw new Error('--fields-json must be a nonempty JSON object');
  }
  return JSON.stringify(fields);
}

function calendarTime(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`--${name} must be ISO 8601 with a timezone`);
  }
  return value;
}

function fixedStatusCard(options) {
  const title = requireOption(options, 'title');
  const body = requireOption(options, 'body');
  if (title.length > 200 || body.length > 6000) throw new Error('Card title or body is too long');
  const status = options.status || 'info';
  if (!Object.hasOwn(STATUS_COLORS, status)) throw new Error('--status must be info, success, warning or error');
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: STATUS_COLORS[status] },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }],
  });
}

function commonArgs(options) {
  const profile = requireOption(options, 'profile');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(profile)) throw new Error('--profile has an invalid name');
  return ['--profile', profile];
}

function validateOptions(action, options) {
  const allowed = new Set(['profile', 'dry-run', ...ACTION_OPTIONS[action]]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`--${name} is not used by ${action}`);
  }
}

export function parseFeishuActionArgs(argv = []) {
  const action = argv[0] || '';
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    const name = flag.slice(2);
    if (!FLAG_NAMES.has(name)) throw new Error(`Unknown option: ${flag}`);
    if (name === 'dry-run' || name === 'create') {
      if (options[name] !== undefined) throw new Error(`Duplicate option: ${flag}`);
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (name === 'field') (options.field ||= []).push(value);
    else if (options[name] !== undefined) throw new Error(`Duplicate option: ${flag}`);
    else options[name] = value;
    index += 1;
  }
  return { action, options };
}

export function planFeishuAction(action, options = {}) {
  if (!Object.hasOwn(ACTIONS, action)) throw new Error(`Unknown Feishu action: ${action}`);
  validateOptions(action, options);
  const args = commonArgs(options);
  const add = (...values) => args.push(...values);
  switch (action) {
    case 'contact.get':
      add('contact', '+get-user', '--user-id', validateId(requireOption(options, 'user-id'), /^ou_[A-Za-z0-9_]+$/, 'user-id'));
      add('--jq', '{ok,user:{name:.data.user.name,open_id:.data.user.open_id},error:.error}');
      break;
    case 'message.send':
      add('im', '+messages-send', ...recipientArgs(options), '--text', requireOption(options, 'text'));
      add('--idempotency-key', stableKey(options), '--jq', '{ok,message_id:.data.message_id,chat_id:.data.chat_id,error:.error}');
      break;
    case 'message.get':
      add('im', '+messages-mget', '--message-ids', validateId(requireOption(options, 'message-id'), /^om[A-Za-z0-9_]+$/, 'message-id'));
      add('--no-reactions', '--jq', '{ok,messages:[.data.messages[]? | {message_id,chat_id,msg_type,content}],error:.error}');
      break;
    case 'card.send':
      add('im', '+messages-send', ...recipientArgs(options), '--msg-type', 'interactive', '--content', fixedStatusCard(options));
      add('--idempotency-key', stableKey(options), '--jq', '{ok,message_id:.data.message_id,chat_id:.data.chat_id,error:.error}');
      break;
    case 'reaction.add': {
      const emoji = requireOption(options, 'emoji');
      if (!/^[A-Z0-9_]{2,50}$/.test(emoji)) throw new Error('--emoji must be a Feishu emoji_type');
      add('im', 'reactions', 'create', '--message-id', validateId(requireOption(options, 'message-id'), /^om[A-Za-z0-9_]+$/, 'message-id'));
      add('--data', JSON.stringify({ reaction_type: { emoji_type: emoji } }), '--jq', '{ok,reaction_id:.data.reaction_id,emoji_type:.data.reaction_type.emoji_type,error:.error}');
      break;
    }
    case 'reaction.list':
      add('im', 'reactions', 'list', '--message-id', validateId(requireOption(options, 'message-id'), /^om[A-Za-z0-9_]+$/, 'message-id'));
      add('--page-size', String(limitedNumber(options.limit, 10, 50, 'limit')), '--jq', '{ok,items:[.data.items[]? | {reaction_id,reaction_type,operator}],error:.error}');
      break;
    case 'calendar.list':
      add('calendar', 'calendars', 'list', '--page-size', '50', '--jq', '{ok,calendars:[.data.calendar_list[]? | {calendar_id,summary}],has_more:.data.has_more,error:.error}');
      break;
    case 'calendar.get':
      add('calendar', 'events', 'get', '--calendar-id', requireOption(options, 'calendar-id'), '--event-id', requireOption(options, 'event-id'));
      add('--jq', '{ok,event:(.data.event | {event_id,summary,start_time,end_time,description}),error:.error}');
      break;
    case 'calendar.create':
      add('calendar', 'events', 'create', '--calendar-id', requireOption(options, 'calendar-id'));
      {
        const start = calendarTime(requireOption(options, 'start'), 'start');
        const end = calendarTime(requireOption(options, 'end'), 'end');
        if (Date.parse(end) <= Date.parse(start)) throw new Error('--end must be later than --start');
        add('--idempotency-key', stableKey(options), '--data', JSON.stringify({
          summary: requireOption(options, 'summary'),
          start_time: { timestamp: String(Math.floor(Date.parse(start) / 1000)) },
          end_time: { timestamp: String(Math.floor(Date.parse(end) / 1000)) },
        }));
      }
      add('--jq', '{ok,event_id:(.event.event_id // .data.event.event_id // .data.event_id),error:.error}');
      break;
    case 'task.list':
      add('task', 'tasks', 'list', '--page-size', String(limitedNumber(options.limit, 10, 50, 'limit')));
      add('--jq', '{ok,items:[(.data.items // .data.tasks // [])[] | {guid,summary}],has_more:.data.has_more,error:.error}');
      break;
    case 'task.get':
      add('task', 'tasks', 'get', '--task-guid', requireOption(options, 'task-guid'));
      add('--jq', '{ok,task:(.data.task | {guid,summary,description,due,completed_at}),error:.error}');
      break;
    case 'task.create':
      add('task', '+create', '--summary', requireOption(options, 'summary'), '--idempotency-key', stableKey(options));
      if (options.due) add('--due', options.due);
      if (options.assignee) add('--assignee', options.assignee);
      if (options['tasklist-id']) add('--tasklist-id', options['tasklist-id']);
      add('--jq', '{ok,task_guid:(.task.guid // .data.task.guid // .data.guid),error:.error}');
      break;
    case 'base.records':
      add('base', '+record-list', '--base-token', requireOption(options, 'base-token'), '--table-id', requireOption(options, 'table-id'));
      add('--limit', String(limitedNumber(options.limit, 10, 20, 'limit')), '--format', 'json');
      if (!options.field?.length) throw new Error('Use --field to select at least one Base field');
      if (options.field.length > 5 || options.field.some((field) => !field || field.length > 100)) {
        throw new Error('Select 1-5 nonempty Base fields with --field');
      }
      for (const field of options.field) add('--field-id', field);
      add('--jq', '{ok,records:(.records // .data.records // .data.items // []),has_more:(.has_more // .data.has_more),error:.error}');
      break;
    case 'base.upsert':
      if (Boolean(options.create) === Boolean(options['record-id'])) {
        throw new Error('Choose exactly one of --create and --record-id for Base upsert');
      }
      add('base', '+record-upsert', '--base-token', requireOption(options, 'base-token'), '--table-id', requireOption(options, 'table-id'));
      add('--json', fieldsJson(options));
      if (options['record-id']) add('--record-id', options['record-id']);
      add('--jq', '{ok,record_id:(.record.record_id // .data.record.record_id // .data.record_id),created:(.created // .data.created),updated:(.updated // .data.updated),ignored_fields:(.ignored_fields // .data.ignored_fields // []),error:.error}');
      break;
    default: throw new Error(`Unsupported Feishu action: ${action}`);
  }
  add('--as', 'bot');
  if (options['dry-run']) add('--dry-run');
  return { action, args };
}

function printHelp(stdout) {
  stdout.write(`Usage: remotelab feishu list | <action> --profile <bot-profile> [options]\n\n`);
  for (const [name, description] of Object.entries(ACTIONS)) stdout.write(`  ${name.padEnd(18)} ${description}\n`);
  stdout.write(`\nExamples:\n`);
  stdout.write(`  remotelab feishu contact.get --profile bot-2 --user-id ou_xxx\n`);
  stdout.write(`  remotelab feishu card.send --profile bot-2 --user-id ou_xxx --title Status --body Ready --status success --key unique-request-123\n`);
  stdout.write(`  remotelab feishu base.records --profile bot-2 --base-token <token> --table-id <table> --field Name --limit 10\n`);
  stdout.write(`\nAll calls use Bot identity. Each action is a fixed lark-cli recipe with no shell interpolation or model-generated request shape.\n`);
}

function trimLargeResult(action, result) {
  let truncated = false;
  const shorten = (value, max) => {
    if (typeof value !== 'string' || value.length <= max) return value;
    truncated = true;
    return `${value.slice(0, max)}…`;
  };
  if (action === 'message.get') {
    result.messages = (result.messages || []).map((message) => ({
      ...message, content: shorten(message.content, 6000),
    }));
  }
  if (action === 'calendar.get' && result.event) {
    result.event.description = shorten(result.event.description, 3000);
  }
  if (action === 'task.get' && result.task) {
    result.task.description = shorten(result.task.description, 3000);
  }
  if (action === 'base.records') {
    const compactCell = (value, depth = 0) => {
      if (typeof value === 'string') return shorten(value, 300);
      if (!value || typeof value !== 'object') return value;
      if (depth >= 5) { truncated = true; return '[nested value]'; }
      if (Array.isArray(value)) {
        if (value.length > 10) truncated = true;
        return value.slice(0, 10).map((item) => compactCell(item, depth + 1));
      }
      const entries = Object.entries(value);
      if (entries.length > 20) truncated = true;
      return Object.fromEntries(entries.slice(0, 20).map(([name, item]) => [name, compactCell(item, depth + 1)]));
    };
    result.records = (result.records || []).map((record) => ({
      ...record,
      fields: Object.fromEntries(Object.entries(record.fields || {}).map(([name, value]) => [
        name, compactCell(value),
      ])),
    }));
  }
  if (truncated) result.truncated = true;
  return result;
}

async function verifyBotWrite(action, options, result, invoke) {
  let verifyAction;
  let verifyOptions;
  if (action === 'message.send' || action === 'card.send') {
    if (!result.message_id) return { confirmed: false, verification_error: 'Message ID missing from send response' };
    verifyAction = 'message.get';
    verifyOptions = { profile: options.profile, 'message-id': result.message_id };
  } else if (action === 'reaction.add') {
    if (!result.reaction_id) return { confirmed: false, verification_error: 'Reaction ID missing from create response' };
    verifyAction = 'reaction.list';
    verifyOptions = { profile: options.profile, 'message-id': options['message-id'], limit: '50' };
  } else if (action === 'calendar.create') {
    if (!result.event_id) return { confirmed: false, verification_error: 'Event ID missing from create response' };
    verifyAction = 'calendar.get';
    verifyOptions = { profile: options.profile, 'calendar-id': options['calendar-id'], 'event-id': result.event_id };
  } else if (action === 'task.create') {
    if (!result.task_guid) return { confirmed: false, verification_error: 'Task GUID missing from create response' };
    verifyAction = 'task.get';
    verifyOptions = { profile: options.profile, 'task-guid': result.task_guid };
  } else return {};
  try {
    const receiptPlan = planFeishuAction(verifyAction, verifyOptions);
    const { stdout } = await invoke(process.execPath, [CLI_SCRIPT, ...receiptPlan.args], { timeout: 30_000, maxBuffer: 2_000_000 });
    const receipt = JSON.parse(stdout);
    if (receipt.ok !== true) return { confirmed: false, verification_error: 'Readback API failed' };
    let confirmed = false;
    if (verifyAction === 'message.get') {
      confirmed = receipt.messages?.some((item) => item.message_id === result.message_id
        && item.msg_type === (action === 'card.send' ? 'interactive' : 'text'));
    } else if (verifyAction === 'reaction.list') {
      confirmed = receipt.items?.some((item) => item.reaction_id === result.reaction_id
        && item.reaction_type?.emoji_type === options.emoji);
    } else if (verifyAction === 'calendar.get') {
      confirmed = receipt.event?.event_id === result.event_id
        && receipt.event?.summary === options.summary;
    } else if (verifyAction === 'task.get') {
      confirmed = receipt.task?.guid === result.task_guid
        && receipt.task?.summary === options.summary;
    }
    return { confirmed: confirmed === true };
  } catch {
    return { confirmed: false, verification_error: 'Readback API unavailable' };
  }
}

export async function runFeishuActionCommand(argv = [], io = {}, invoke = execFile) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') { printHelp(stdout); return 0; }
  if (argv[0] === 'list') {
    if (argv.length !== 1) { stderr.write('list takes no options\n'); return 1; }
    stdout.write(`${JSON.stringify({ actions: ACTIONS })}\n`);
    return 0;
  }
  try {
    const { action, options } = parseFeishuActionArgs(argv);
    const plan = planFeishuAction(action, options);
    const { stdout: cliOutput } = await invoke(process.execPath, [CLI_SCRIPT, ...plan.args], { timeout: 30_000, maxBuffer: 2_000_000 });
    if (options['dry-run']) { stdout.write(cliOutput); return 0; }
    const result = trimLargeResult(action, JSON.parse(cliOutput));
    if (result.ok === true) Object.assign(result, await verifyBotWrite(action, options, result, invoke));
    stdout.write(`${JSON.stringify({ action, ...result })}\n`);
    return result.ok === true ? 0 : 1;
  } catch (error) {
    let message = error?.message || String(error);
    if (error?.cmd) {
      try { message = JSON.parse(error.stdout)?.error?.message || 'Feishu CLI call failed'; }
      catch { message = `Feishu CLI call failed (${error.code || 'unknown'})`; }
    }
    stderr.write(`${message.slice(0, 500)}\n`);
    return 1;
  }
}
