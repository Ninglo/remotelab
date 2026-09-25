import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadAuthDocument } from './auth-config.mjs';
import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';

const HELP = `Usage:
  remotelab todo list [--json]
  remotelab todo add --title <text> [--due <ISO timestamp|none>] [--status todo|in_progress|blocked|done]
                     [--current <number> --target <number> --unit <text>] [--note <text>]
  remotelab todo update <id> [--title <text>] [--due <ISO timestamp|none>] [--status <status>]
                            [--current <number>] [--target <number>] [--unit <text>] [--no-progress]
  remotelab todo done <id>
  remotelab todo delete <id>

Defaults to the Person who started this RemoteLab Session. Outside a Session, supply --person <person-id>.
Progress and task status are separate: reaching a numeric target does not silently mark the task done.
`;

function parseArgs(args) {
  const [command = '', ...rest] = args;
  const options = {};
  let id = '';
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (!word.startsWith('--') && !id) { id = word; continue; }
    if (['--json', '--no-progress'].includes(word)) { options[word.slice(2)] = true; continue; }
    if (!['--person', '--title', '--due', '--status', '--current', '--target', '--unit', '--note'].includes(word)) throw Error(`Unknown option: ${word}`);
    const value = rest[++index];
    if (value === undefined) throw Error(`Missing value for ${word}`);
    options[word.slice(2)] = value;
  }
  return { command, id, options };
}

function number(value, label, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw Error(`${label} must be an integer of at least ${minimum}`);
  return parsed;
}

function patchFrom(options) {
  const body = {};
  for (const key of ['title', 'status', 'note']) if (options[key] !== undefined) body[key] = options[key];
  if (options.due !== undefined) body.dueAt = options.due === 'none' ? null : options.due;
  if (options['no-progress']) body.progress = null;
  else if (['current', 'target', 'unit'].some((key) => options[key] !== undefined)) {
    body.progress = {};
    if (options.current !== undefined) body.progress.current = number(options.current, '--current', 0);
    if (options.target !== undefined) body.progress.target = number(options.target, '--target', 1);
    if (options.unit !== undefined) body.progress.unit = options.unit;
  }
  return body;
}

async function personFromSession(options) {
  const document = await loadAuthDocument();
  if (options.person) {
    if (!document.people.some((person) => person.id === options.person)) throw Error('Unknown Person');
    return options.person;
  }
  const sessionId = process.env.REMOTELAB_SESSION_ID;
  if (!sessionId) throw Error('No RemoteLab Session context; pass --person <person-id>');
  const result = await createRemoteLabHttpClient().request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!result.response.ok) throw Error('Cannot read the current RemoteLab Session');
  const identityId = result.json?.session?.initiatedByIdentityId;
  const person = document.people.find((item) => item.identities?.some((identity) => identity.id === identityId));
  if (!person) throw Error('Current Session is not linked to a Person');
  return person.id;
}

async function request(personId, command, id, body = undefined) {
  const configDir = process.env.REMOTELAB_CONFIG_DIR || join(homedir(), '.config', 'remotelab');
  const tokenPath = process.env.REMOTELAB_DISPLAY_ADMIN_TOKEN_FILE || join(configDir, 'display-admin-token');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  const base = (process.env.REMOTELAB_DISPLAY_INTERNAL_BASE_URL || 'http://127.0.0.1:8792').replace(/\/+$/, '');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('To do service must use the local display sidecar');
  const method = command === 'add' ? 'POST' : command === 'update' || command === 'done' ? 'PATCH' : command === 'delete' ? 'DELETE' : 'GET';
  const response = await fetch(`${base}/v1/people/${encodeURIComponent(personId)}/todos${id ? `/${encodeURIComponent(id)}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(command === 'add' && process.env.REMOTELAB_SESSION_ID ? { 'X-RemoteLab-Session-Id': process.env.REMOTELAB_SESSION_ID } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || `To do request failed (${response.status})`);
  return result;
}

export async function runTodoCommand(args, stdout = process.stdout, stderr = process.stderr) {
  try {
    const { command, id, options } = parseArgs(args);
    if (command === '--help' || command === '-h' || !command) { stdout.write(HELP); return 0; }
    if (!['list', 'add', 'update', 'done', 'delete'].includes(command)) throw Error(`Unknown To do command: ${command}`);
    if (['update', 'done', 'delete'].includes(command) && !/^todo_[a-f0-9]{16}$/.test(id)) throw Error('A valid To do ID is required');
    if (command === 'add' && !options.title) throw Error('--title is required');
    if (command === 'add' && options['no-progress']) throw Error('--no-progress is only for updates');
    const personId = await personFromSession(options);
    const body = command === 'done' ? { status: 'done' } : ['add', 'update'].includes(command) ? patchFrom(options) : undefined;
    const result = await request(personId, command, id, body);
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (command === 'list') {
      if (!result.items?.length) stdout.write('No To do items.\n');
      else for (const item of result.items) stdout.write(`${item.id}  ${item.status}  ${item.title}${item.progress ? `  ${item.progress.current}/${item.progress.target}${item.progress.unit}` : ''}${item.dueAt ? `  due ${item.dueAt}` : ''}\n`);
    } else stdout.write(`${command === 'delete' ? 'Deleted' : 'Saved'} ${result.item?.id || id}${result.item?.title ? `  ${result.item.title}` : ''}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}
