import { createRemoteLabHttpClient, DEFAULT_CHAT_BASE_URL, normalizeBaseUrl } from './remotelab-http-client.mjs';

const help = `Usage:
  remotelab workboard show [--task <id>] [--json]
  remotelab workboard update --task <id> --item <id> --status <state> --evidence <seq> [--json]

Options:
  --task-status <state>  Task outcome, e.g. completed after all items pass
  --reason <text>        Required for unfinished outcomes or withdrawing done
  --revision <number>    Optional current revision precondition
  --session <id>         Defaults to $REMOTELAB_SESSION_ID
  --run-id <id>          Defaults to $REMOTELAB_RUN_ID
  --base-url <url>       Defaults to $REMOTELAB_CHAT_BASE_URL
  --evidence <seq>       Repeat for multiple evidence events
  --json                Compact machine-readable result

Semantic acceptance belongs to the Harness. Code merges state and validates
evidence references; it does not decide whether the evidence proves completion.
`;

export function workboardReceipt(result = {}) {
  const event = result.event || {};
  const board = event.workboard || {};
  return { eventSeq: event.seq, taskId: board.taskId, revision: board.revision, status: board.status,
    ...(board.reason ? { reason: board.reason } : {}),
    items: (board.items || []).map(({ id, status, evidenceRefs }) => ({ id, status, evidenceRefs })) };
}

export async function runWorkboardCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { stdout.write(help); return 0; }
  const [action, ...args] = argv;
  if (!['show', 'update'].includes(action)) throw new Error('Use workboard show or update');
  const options = { session: process.env.REMOTELAB_SESSION_ID || '', runId: process.env.REMOTELAB_RUN_ID || '',
    baseUrl: process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL, evidenceRefs: [], json: false };
  const values = { '--task': 'taskId', '--item': 'itemId', '--status': 'status', '--task-status': 'taskStatus',
    '--reason': 'reason', '--revision': 'expectedRevision', '--session': 'session', '--run-id': 'runId', '--base-url': 'baseUrl' };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') { options.json = true; continue; }
    if (flag !== '--evidence' && !values[flag]) throw new Error(`Unknown argument: ${flag}`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--evidence' || flag === '--revision') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${flag} needs a positive integer`);
      if (flag === '--evidence') options.evidenceRefs.push(Number(value));
      else options.expectedRevision = Number(value);
    } else options[values[flag]] = value;
  }
  if (!options.session) throw new Error('Pass --session or set REMOTELAB_SESSION_ID');
  const client = createRemoteLabHttpClient({ baseUrl: normalizeBaseUrl(options.baseUrl) });
  const path = `/api/sessions/${encodeURIComponent(options.session)}`;
  let outcome;
  if (action === 'show') {
    if (options.itemId || options.status || options.taskStatus || options.reason !== undefined
        || options.evidenceRefs.length || options.expectedRevision !== undefined) throw new Error('State updates require workboard update');
    outcome = await client.request(`${path}/workboards${options.taskId ? `?taskId=${encodeURIComponent(options.taskId)}` : ''}`);
  } else {
    if (!options.taskId) throw new Error('workboard update needs --task');
    if (options.itemId && !options.status) throw new Error('--item needs --status');
    if (!options.itemId && (options.status || options.evidenceRefs.length)) throw new Error('Item status and evidence need --item');
    if (!options.itemId && !options.taskStatus && options.reason === undefined) throw new Error('Provide an item update, task status or reason');
    const patch = { taskId: options.taskId,
      ...(options.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}),
      ...(options.taskStatus ? { status: options.taskStatus } : {}),
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.itemId ? { items: [{ id: options.itemId, status: options.status,
        ...(options.evidenceRefs.length ? { evidenceRefs: options.evidenceRefs } : {}) }] } : {}) };
    outcome = await client.request(`${path}/assistant-messages`, { method: 'POST', body: {
      workboardPatch: patch, ...(options.runId ? { runId: options.runId } : {}),
    } });
  }
  if (!outcome.response.ok) throw new Error(outcome.json?.error || `Workboard request failed (${outcome.response.status})`);
  const result = action === 'show' ? outcome.json : workboardReceipt(outcome.json);
  stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`);
  return 0;
}
