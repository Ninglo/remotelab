import { readFile } from 'node:fs/promises';
import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';

const help = 'Usage:\n'
  + '  remotelab work context --query <goal> [--object <path/id>] [--project <id>] [--json]\n'
  + '  remotelab work people --query <text naming involved people> [--json]\n'
  + '  remotelab work start --goal <goal> [--object <path/id>] [--project <id>] [--json]\n'
  + '  remotelab work update --file <update.json> [--json]\n'
  + '  remotelab work suggest --file <suggestion.json> [--json]\n'
  + '  remotelab work explain --file <explanation.json> [--json]\n'
  + '  remotelab work review --file <review.json> [--json]\n'
  + '\nDefaults: current REMOTELAB_SESSION_ID and REMOTELAB_RUN_ID.\n'
  + 'Updates require workId, expectedVersion, status, result, evidenceRefs; optional artifacts/methods.\n'
  + 'Suggestions require targetSessionId, content, impact, evidenceRefs; optional sourceWorkId/targetWorkId/purpose.\n'
  + 'Use explanation {summary, relevance, nextAction} for readable advice; it is required when content exceeds 240 characters. Keep technical details in content.\n'
  + 'Optional sourceRefs [{sessionId, requestId}] identify actual source messages. Origin and timestamps are read from accepted records.\n'
  + 'Explain an existing suggestion with suggestionId, expectedVersion, explanation, evidenceRefs and optional sourceRefs. It adds a readable explanation while retaining the original content and decision state; it never sends the suggestion.\n'
  + 'A candidate project tag is not a confirmed project binding. Registration is non-exclusive.\n'
  + 'Context returns unreviewed candidates separately from related recommendations. Search using the understood task, not conversational filler.\n'
  + 'Review writes only a reference list for this Session: items (max 3) need sessionId, workId, fingerprint, relation (overlap/dependency/reuse), concrete reason; evidenceRefs identify the source read. Empty items clears the list.\n'
  + 'A relevance review does not send a message, change another task or approve a collaboration suggestion.\n'
  + 'Human publishes a reviewed draft by typing 确认协作建议 <id> 发布 in its source Session.\n'
  + 'The target receives a reference, not a task change; human adoption requires 确认协作建议 <id> 执行 in the target Session.\n'
  + 'There is no Agent approval command. Routing continues through existing human-reviewed Session tools.\n'
  + 'See docs/session-work-awareness.md for recovery, evidence and budget boundaries.\n';

export async function runWorkAwarenessCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!argv.length || argv.includes('--help')) { stdout.write(help); return 0; }
  const [action, ...args] = argv;
  if (!['context', 'people', 'start', 'update', 'suggest', 'explain', 'review'].includes(action)) throw new Error('Use work context, people, start, update, suggest, explain or review');
  const options = { runId: process.env.REMOTELAB_RUN_ID, sessionId: process.env.REMOTELAB_SESSION_ID };
  const flags = { '--run-id': 'runId', '--session': 'sessionId', '--query': 'query', '--object': 'object', '--project': 'projectId', '--goal': 'goal', '--file': 'file' };
  let json = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') { json = true; continue; }
    if (!flags[args[index]] || !args[index + 1]) throw new Error('Invalid work argument: ' + args[index]);
    options[flags[args[index]]] = args[++index];
  }
  const client = io.client || createRemoteLabHttpClient();
  let response;
  if (['context', 'people'].includes(action)) {
    const search = new URLSearchParams();
    for (const key of ['sessionId', 'runId', 'query', 'object']) if (options[key]) search.set(key, options[key]);
    if (options.projectId) search.set('project', options.projectId);
    response = await client.request('/api/work-awareness' + (action === 'people' ? '/people' : '') + '?' + search);
  } else {
    const payload = options.file ? JSON.parse(await readFile(options.file, 'utf8')) : {};
    response = await client.request('/api/work-awareness/' + action, { method: 'POST', body: { ...payload, ...options } });
  }
  if (!response.response.ok) throw new Error(response.json?.error || response.text);
  stdout.write(JSON.stringify(response.json, null, json ? 0 : 2) + '\n');
  return 0;
}
