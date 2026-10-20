import { observeContextQuery } from '../chat/context-query-monitoring.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requestKey, requests } from '../chat/requests.mjs';
import { appendEvent, loadHistory } from '../chat/history.mjs';
import { loadAuthDocument } from './auth-config.mjs';
import { loadCompletedTurnContext, loadTurnSourceRequest } from '../chat/session-turn-context.mjs';
import { contextOperationEvent } from '../chat/normalizer.mjs';
import { applyLearningUpdates, buildLearningContext, inspectLearning, maintainHandbook, learningContextReceipts, learningDeliveryReceipts, learningTurnEvidence, loadLearningPolicy } from '../chat/memory-learning.mjs';
import { findSessionMeta as getSession } from '../chat/session-meta-store.mjs';
import { resolveLearningProject } from '../chat/project-memory-runtime.mjs';
import { retrieveNecessaryContext } from '../chat/necessary-background.mjs';

const help = `Usage:
  remotelab memory status [--json]
  remotelab memory inspect [--handbook] [--key <key-or-id>] [--summary] [--run-id <id>] [--json]
  remotelab memory context [--handbook] --query <task> [--run-id <id>] [--json]
  remotelab memory apply --file <updates.json> [--run-id <id>] [--json]
  remotelab memory handbook-migrate [--run-id <id>] [--json]
  remotelab memory handbook-export --file <new-file.md> [--run-id <id>] [--json]
  remotelab memory handbook-rollback [--run-id <id>] [--json]

The current Run defaults to REMOTELAB_RUN_ID. Attribution comes from that
Run's accepted Request identity, never the Session creator or machine user.
apply accepts {"updates":[...]} using the schema in docs/memory-learning.md.
It verifies exact user/tool quotes from this Run, scope, versions and the
instance's learning-policy.json. It cannot write core principles or AGENTS.md.
inspect shows observations, withdrawals, evidence and revisions; context shows
only the bounded applicable snapshot. Delivery is not behavioral acceptance.
inspect --summary omits handbook archives; --key follows one entry's evidence.
context/inspect --handbook reads only methods, without loading Person records
or unrelated background. This explicit query keeps the same scope/status and
context budgets; it changes no policy or default multi-source retrieval.
handbook-migrate preserves the original file and moves methods to atomic
per-entry current records plus immutable revision archives. It changes no
learning policy or entry semantics. Export writes a new complete legacy file.
Rollback reconstructs the latest legacy file, including post-migration changes;
old readers still have their original size limit. Archives remain available.
For the opted-in conversational trial, apply action "propose" records one
pending question on an existing observed/inferred personal entry. Supply its
key, kind, expectedVersion, exact question and current user evidence. It sends
no ordinary reply and grants no acceptance; an explicitly enabled Feishu memory-card trial queues its independent card. Inspect reviewProposal before asking or
resolving it. Concurrent/repeated proposals are rejected. A clear owner reply
uses the existing explicit revise/withdraw workflow, preserving source scope.
`;

export async function runMemoryLearningCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { stdout.write(help); return 0; }
  const [action, ...args] = argv;
  if (!['status', 'inspect', 'context', 'apply', 'handbook-migrate', 'handbook-export', 'handbook-rollback'].includes(action)) throw new Error('Use memory --help for supported operations');
  const options = { runId: process.env.REMOTELAB_RUN_ID || '', json: false };
  const flags = { '--run-id': 'runId', '--file': 'file', '--query': 'query', '--key': 'key' };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') { options.json = true; continue; }
    if (flag === '--summary') { options.summary = true; continue; }
    if (flag === '--handbook') { options.handbook = true; continue; }
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
    const handbookRead = options.handbook && ['inspect', 'context'].includes(action);
    const sourceRequest = (action.startsWith('handbook-') || handbookRead) && !turn.userMessage ? request : await loadTurnSourceRequest(request.sessionId, turn.userMessage, {
      getRequest: (id, requestId) => requests.get(requestKey(id, requestId)),
    });
    // Storage maintenance and method-only reads can run in a delegated Request that
    // has no human message event. Never extend this to semantic apply or use it
    // to reinterpret a present but unmatched/steered human message.
    if (!sourceRequest) throw new Error('Current source message has no matching accepted Request');
    const actor = { personId: sourceRequest.options?.viewPersonId, identityId: sourceRequest.options?.initiatedByIdentityId,
      authDocument: await loadAuthDocument({ persistMigration: false }) };
    if (action === 'inspect') result = await inspectLearning({ ...actor, summary: options.summary, key: options.key, handbookOnly: options.handbook });
    else if (action.startsWith('handbook-')) result = await maintainHandbook({ ...actor,
      action: action.slice('handbook-'.length), file: options.file ? resolve(options.file) : undefined });
    else if (action === 'context') {
      if (!options.query) throw new Error('memory context requires --query');
      const session = await getSession(request.sessionId);
      const projectContext = await resolveLearningProject(session, sourceRequest.options?.sourceContext);
      result = await observeContextQuery({ sessionId: request.sessionId, runId: options.runId, requestId: sourceRequest.requestId, kind: 'memory', query: options.query }, async () => {
        if (options.handbook) {
          const coverage = [];
          const context = await buildLearningContext({ ...actor, query: options.query, project: projectContext,
            handbookOnly: true, onCoverage: value => coverage.push({ kind: 'scoped-learning', ...value }) });
          return { context, coverage };
        }
        return retrieveNecessaryContext(session, { ...actor, query: options.query,
          sourceContext: sourceRequest.options?.sourceContext, project: projectContext });
      });
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
