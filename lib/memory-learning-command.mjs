import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requestKey, requests } from '../chat/requests.mjs';
import { appendEvent, loadHistory } from '../chat/history.mjs';
import { loadAuthDocument } from './auth-config.mjs';
import { loadCompletedTurnContext, loadTurnSourceRequest } from '../chat/session-turn-context.mjs';
import { contextOperationEvent } from '../chat/normalizer.mjs';
import { applyLearningUpdates, buildLearningContext, inspectLearning, learningContextReceipts, learningDeliveryReceipts, learningTurnEvidence, loadLearningPolicy } from '../chat/memory-learning.mjs';
import { findSessionMeta as getSession } from '../chat/session-meta-store.mjs';
import { resolveLearningProject } from '../chat/project-memory-runtime.mjs';

const help = `Usage:
  remotelab memory status [--json]
  remotelab memory inspect [--run-id <id>] [--json]
  remotelab memory context --query <task> [--run-id <id>] [--json]
  remotelab memory apply --file <updates.json> [--run-id <id>] [--json]

The current Run defaults to REMOTELAB_RUN_ID. Attribution comes from that
Run's accepted Request identity, never the Session creator or machine user.
apply accepts {"updates":[...]} using the schema in docs/memory-learning.md.
It verifies exact user/tool quotes from this Run, scope, versions and the
instance's learning-policy.json. It cannot write core principles or AGENTS.md.
inspect shows observations, withdrawals, evidence and revisions; context shows
only the bounded applicable snapshot. Delivery is not behavioral acceptance.
`;

export async function runMemoryLearningCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { stdout.write(help); return 0; }
  const [action, ...args] = argv;
  if (!['status', 'inspect', 'context', 'apply'].includes(action)) throw new Error('Use memory status, inspect, context or apply');
  const options = { runId: process.env.REMOTELAB_RUN_ID || '', json: false };
  const flags = { '--run-id': 'runId', '--file': 'file', '--query': 'query' };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') { options.json = true; continue; }
    if (!flags[flag] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
    options[flags[flag]] = args[++index];
  }
  let result;
  if (action === 'status') result = await loadLearningPolicy();
  else {
    if (!/^run_[a-zA-Z0-9_-]{1,96}$/.test(options.runId)) throw new Error('A valid current Run is required');
    const request = await requests.byRunId(options.runId);
    if (!request) throw new Error('Run has no accepted Request');
    const turn = await loadCompletedTurnContext(request.sessionId, options.runId, { loadSessionHistory: loadHistory });
    const sourceRequest = await loadTurnSourceRequest(request.sessionId, turn.userMessage, {
      getRequest: (id, requestId) => requests.get(requestKey(id, requestId)),
    });
    if (!sourceRequest) throw new Error('Current source message has no matching accepted Request');
    const actor = { personId: sourceRequest.options?.viewPersonId, identityId: sourceRequest.options?.initiatedByIdentityId,
      authDocument: await loadAuthDocument({ persistMigration: false }) };
    if (action === 'inspect') result = await inspectLearning(actor);
    else if (action === 'context') {
      if (!options.query) throw new Error('memory context requires --query');
      const session = await getSession(request.sessionId);
      result = { context: await buildLearningContext({ ...actor, query: options.query,
        project: await resolveLearningProject(session, sourceRequest.options?.sourceContext) }) };
      if (result.context) {
        const event = await appendEvent(request.sessionId, contextOperationEvent({
          operation: 'read_memory', phase: 'delivered', trigger: 'conversation',
          title: 'Scoped memory retrieved', summary: 'Current scoped entries returned to the Harness; not behavioral acceptance.',
          learningReceipts: learningContextReceipts(result.context), runId: options.runId,
        }));
        result.eventSeq = event.seq;
      }
    } else {
      if (!options.file) throw new Error('memory apply requires --file');
      const payload = JSON.parse(await readFile(resolve(options.file), 'utf8'));
      const session = await getSession(request.sessionId);
      const sources = learningTurnEvidence({ sessionId: request.sessionId, runId: options.runId,
        userMessage: turn.userMessage?.content, sourceEventSeq: turn.userMessage?.seq, turnEvents: turn.turnEvents });
      const delivered = learningDeliveryReceipts(turn.turnEvents, options.runId);
      result = await applyLearningUpdates({ ...actor, updates: payload.updates, sources, delivered,
        project: await resolveLearningProject(session, sourceRequest.options?.sourceContext) });
      const event = await appendEvent(request.sessionId, contextOperationEvent({
        operation: 'write_memory', phase: result.promotedCount ? 'applied' : 'rejected', trigger: 'conversation',
        title: 'Scoped memory update', summary: `${result.promotedCount} entry update(s); this is not behavioral acceptance.`,
        learningResults: result.results || [], rejectedLearningUpdates: result.rejected || [], runId: options.runId,
      }));
      result.eventSeq = event.seq;
    }
  }
  stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`);
  return result.rejected?.length ? 1 : 0;
}
