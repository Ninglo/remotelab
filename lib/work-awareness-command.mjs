import { readFile } from 'node:fs/promises';
import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';

const help = 'Usage:\n'
  + '  remotelab work context --query <goal> [--focus work|project|all] [--object <path/id>] [--project <id>] [--json]\n'
  + '  remotelab work retrieve --query <question> [--context <known facts>] [--source-request <accepted input>] [--file <options.json>] [--json] (personal v5; returns immediately, useful findings arrive as references)\n'
  + '  remotelab work discover [--query <task>] [--json] (registered groups and up to three topic candidates; no transcript scan)\n'
  + '  remotelab work directory [--query <goal>] [--object <path/id>] [--project <id>] [--json] (search scoped work metadata; omit query/object for the full directory)\n'
  + '  remotelab work people --query <text naming involved people> [--json]\n'
  + '  remotelab work start --goal <goal> [--object <path/id>] [--project <id>] [--json]\n'
  + '  remotelab work update --file <update.json> [--json]\n'
  + '  remotelab work suggest --file <suggestion.json> [--json]\n'
  + '  remotelab work explain --file <explanation.json> [--json]\n'
  + '  remotelab work review --file <review.json> [--json]\n'
  + '  remotelab work route --file <routing.json> [--json] (enabled pilot group only)\n'
  + '  remotelab work reply --file <reply.json> [--json] (pilot mainline inputs only)\n'
  + '  remotelab work kickoff --file <proposal.json> [--json] (propose or resume; native question approval only)\n'
  + '  remotelab work plan --file <plan.json> [--json] (personal execution trial)\n'
  + '  remotelab work delivery --file <review.json> [--json] (publish a review or return linked feedback)\n'
  + 'Kickoff: propose needs goal, plan, sources, unresolved, acceptance and actual sourceRequestId when steering. Requires active participation and a registered projectLinks discussion/work pair. Pass the complete returned question title/options to the native question tool; only its subsequent human answer can approve. Resume takes proposalId for an already approved packet. No response or reaction is not consent. This does not enable general topic routing or require the personal routing trial.\n'
  + 'Delivery review: publish needs key, chatId, text, scope and authorization identifying the current human instruction to publish AND receive related feedback. It queues exactly this text in the registered group and records the actual message receipt; no draft is sent automatically. If that scope is not authorized, show the concrete destination, text and return scope to the human first. feedback needs originSessionId, reviewId, messageId, requestIds, reason, handled, unresolved; keeps original authors/attachments and group reply ownership. close needs reviewId, expectedVersion, reason. SourceRequestId selects an actually accepted input of this execution. Context includes deliveryReviews. Never use this for task handoff or generic forwarding.\n'
  + 'Plan: action record/propose/start/approve/amend/continue/answer/stop/resume; sourceRequestId identifies this accepted human input. Propose/start branchSurface defaults to web-silent: background child Sessions, questions/results return to the parent. Use feishu-thread only when the human wants a separate conversation, not merely delegation. Include the selected surface in the proposal context. Propose needs goal, context, reason, branches[{id,name,task,writeScope,dependsOn}]. It creates no sessions. Approve needs planId, expectedVersion, selected branch IDs and approval explaining the subsequent human decision. The Harness must verify actual consent; silence, discussion and its own text cannot approve. Start needs authorization tied to this actual human instruction; multiple explicitly requested branches also need executionMode parallel-sessions. In this trial, requested parallel work means independent RemoteLab child Sessions, not native subagents or concurrent tool calls. Agent-suggested splits still require propose/approve. Continue reuses an ended non-stopped child Session for an explicitly authorized follow-up, preserves prior results and returns a new review to the parent; never creates another Session. Amend/continue/stop need planId, expectedVersion, selected and text. Answer needs planId,branchId,questionId,text from the human. Record needs understanding,intent,where,approach,reason. Context returns plans and decisions.\n'
  + 'Reply: sourceRequestId, text, optional reaction (or noTextReason for an explicit no-body decision), requestIds for related inputs covered by one combined answer, replyMode inline|thread when placement is not yet selected. Related supplements should share one answer; an opening does not prevent combining the final. Uses the same response decision and durable outbox as native feishu-response finals; use this tool only for an immediate answer, never to register a final already sent.\n'
  + 'Route: mode new/continue/sync/handoff, task, reason; continue/sync/handoff need targetSessionId. Handoff accepts existing thread/topic targets within the registered Bot/tenant/group scope, independently of the automatic-routing preference. If the current human explicitly specified the content and destination, include authorization:{sourceRequestId,quote} with that accepted input ID and exact instruction; the Harness must verify its meaning and scope. This dispatches without duplicate approval. Otherwise it saves a concrete draft with requestIds and original attachments; pass the returned question unchanged to the native user-input tool. Only the verified owner’s subsequent choice dispatches that draft; an Agent flag, uncertain destination or silence cannot approve it. Resume an already approved packet with {mode:handoff,proposalId} only; no task, target or input changes. New may include name; handoff may include requestIds. Sync saves a draft; only a human source message 确认同步 <id> approves bounded reconsideration and return.\n'
  + '\nDefaults: current REMOTELAB_SESSION_ID and REMOTELAB_RUN_ID.\n'
  + 'Updates require workId, expectedVersion, status, result, evidenceRefs; optional artifacts/methods.\n'
  + 'Suggestions require targetSessionId, content, impact, evidenceRefs; optional sourceWorkId/targetWorkId/purpose.\n'
  + 'Use explanation {summary, relevance, nextAction} for readable advice; it is required when content exceeds 240 characters. Keep technical details in content.\n'
  + 'Optional sourceRefs [{sessionId, requestId}] identify actual source messages. Origin and timestamps are read from accepted records.\n'
  + 'Explain an existing suggestion with suggestionId, expectedVersion, explanation, evidenceRefs and optional sourceRefs. It adds a readable explanation while retaining the original content and decision state; it never sends the suggestion.\n'
  + 'A candidate project tag is not a confirmed project binding. Registration is non-exclusive.\n'
  + 'Context returns unreviewed candidates separately from related recommendations. Search using the understood task, not conversational filler.\n'
  + 'Reuse current injected context first. --focus work returns matched current work and compact candidates without loading background; --focus project reads only registered project background. Omit focus or use all for the full existing view when needed.\n'
  + 'Context projectBackground returns registered scope and project-name candidates. --project reads the registered brief as a reference; directory --project reads its topics. Neither binds the Session or adopts project rules. Verify originals and ask when ownership is unclear.\n'
  + 'Review writes only a reference list for this Session: items (max 3) need sessionId, workId, fingerprint, relation (overlap/dependency/reuse), concrete reason; name the specific material and the step of the current task it can help in plain language. evidenceRefs identify the source read. Empty items clears the list.\n'
  + 'A relevance review does not send a message, change another task or approve a collaboration suggestion.\n'
  + 'Human publishes a reviewed draft by typing 确认协作建议 <id> 发布 in its source Session.\n'
  + 'The target receives a reference, not a task change; human adoption requires 确认协作建议 <id> 执行 in the target Session.\n'
  + 'There is no Agent approval command. Routing continues through existing human-reviewed Session tools.\n'
  + 'See docs/session-work-awareness.md for recovery, evidence and budget boundaries.\n';

export async function runWorkAwarenessCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!argv.length || argv.includes('--help')) { stdout.write(help); return 0; }
  const [action, ...args] = argv;
  if (!['context', 'directory', 'discover', 'people', 'start', 'update', 'suggest', 'explain', 'review', 'route', 'reply', 'plan', 'kickoff', 'delivery', 'retrieve'].includes(action)) throw new Error('Use work context, directory, discover, people, start, update, suggest, explain, review, route, reply, plan, kickoff, delivery or retrieve');
  const options = { runId: process.env.REMOTELAB_RUN_ID, sessionId: process.env.REMOTELAB_SESSION_ID };
  const flags = { '--run-id': 'runId', '--session': 'sessionId', '--query': 'query', '--object': 'object', '--project': 'projectId', '--focus': 'focus', '--goal': 'goal', '--file': 'file', '--context': 'context', '--source-request': 'sourceRequestId' };
  let json = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') { json = true; continue; }
    if (!flags[args[index]] || !args[index + 1]) throw new Error('Invalid work argument: ' + args[index]);
    options[flags[args[index]]] = args[++index];
  }
  const client = io.client || createRemoteLabHttpClient();
  let response;
  if (['context', 'directory', 'discover', 'people'].includes(action)) {
    const search = new URLSearchParams();
    for (const key of ['sessionId', 'runId', 'query', 'object', 'focus']) if (options[key]) search.set(key, options[key]);
    if (options.projectId) search.set('project', options.projectId);
    response = await client.request('/api/work-awareness' + (action === 'context' ? '' : '/' + action) + '?' + search);
  } else {
    const payload = options.file ? JSON.parse(await readFile(options.file, 'utf8')) : {};
    response = await client.request('/api/work-awareness/' + action, { method: 'POST', body: { ...payload, ...options } });
  }
  if (!response.response.ok) throw new Error(response.json?.error || response.text);
  stdout.write(JSON.stringify(response.json, null, json ? 0 : 2) + '\n');
  return 0;
}
