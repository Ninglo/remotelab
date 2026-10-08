import { readBody } from '../lib/utils.mjs';
import { requests } from './requests.mjs';
import { findSessionMeta } from './session-meta-store.mjs';
import { loadHistory } from './history.mjs';
import { buildRelatedPersonContext, collectRelatedPeople } from './related-person-context.mjs';
import { verifiedWorkActor, queryRelatedWork, queryWorkCandidates, reviewRelatedWork, workInbox, startWork, updateWork, createWorkSuggestion, explainWorkSuggestion } from './work-awareness.mjs';
import { broadcastAll } from './ws-clients.mjs';
import { retrieveNecessaryContext } from './necessary-background.mjs';

export async function handleWorkAwarenessRoutes({ req, res, pathname, parsedUrl, authSession, writeJson }) {
  if (!/^\/api\/work-awareness(?:\/(?:start|update|suggest|explain|people|review))?$/.test(pathname)) return false;
  try {
    const body = req.method === 'POST' ? JSON.parse(await readBody(req, 32 * 1024)) : {};
    const runId = body.runId || parsedUrl.searchParams.get('runId');
    const record = runId ? await requests.byRunId(runId) : null;
    const sessionId = record?.sessionId || parsedUrl.searchParams.get('sessionId');
    const session = sessionId ? await findSessionMeta(sessionId) : null;
    if (!session) throw Object.assign(new Error('A current Session is required'), { statusCode: 404 });
    const query = body.query || parsedUrl.searchParams.get('query') || record?.text || '';
    if (pathname.endsWith('/people') && ['GET', 'POST'].includes(req.method)) {
      const context = await buildRelatedPersonContext({ query, sourceContext: record?.options?.sourceContext,
        personId: record?.options?.viewPersonId || authSession?.personId,
        identityId: record?.options?.initiatedByIdentityId || authSession?.identityId });
      writeJson(res, 200, { context });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/work-awareness') {
      const scope = { sessionId, query: parsedUrl.searchParams.get('query') || '', object: parsedUrl.searchParams.get('object') || '',
        projectId: parsedUrl.searchParams.get('project') || '', limit: parsedUrl.searchParams.get('limit') || 5 };
      const [related, candidates, suggestions] = await Promise.all([
        queryRelatedWork({ ...scope, limit: 3 }), queryWorkCandidates(scope), workInbox(sessionId, { describe: true }),
      ]);
      writeJson(res, 200, { sessionId, current: session.workAwareness || null, related, candidates, suggestions,
        ...(parsedUrl.searchParams.get('includeBackground') === 'false' ? {} : { background: await retrieveNecessaryContext(session, { query, sourceContext: record?.options?.sourceContext,
          personId: record?.options?.viewPersonId || authSession?.personId,
          identityId: record?.options?.initiatedByIdentityId || authSession?.identityId }) }) });
      return true;
    }
    const actor = verifiedWorkActor(record?.options?.viewPersonId, record?.options?.initiatedByIdentityId);
    if (req.method !== 'POST' || !record || !actor) throw Object.assign(new Error('Mutation requires the current Run accepted human Request'), { statusCode: 403 });
    // The service credential supplies tools for the current Run. Browser actors
    // may act only for their own Request; payload identity is never trusted.
    if (authSession?.authKind !== 'service' && authSession?.personId !== actor.personId) {
      throw Object.assign(new Error('Run belongs to a different requester'), { statusCode: 403 });
    }
    const evidenceRefs = body.evidenceRefs || [];
    if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 8 || evidenceRefs.some(seq => !Number.isInteger(seq) || seq <= 0)) throw new Error('Invalid source event references');
    if (evidenceRefs.length) {
      const events = await loadHistory(sessionId, { includeBodies: false });
      if (evidenceRefs.some(seq => !events.some(event => event.seq === seq && ['tool_result', 'message', 'work_event'].includes(event.type)))) throw new Error('Source event evidence does not exist');
    }
    const options = { ...body, sessionId, actor, runId: record.runId, requestId: record.requestId, evidenceRefs,
      people: collectRelatedPeople({ personId: actor.personId, identityId: actor.identityId,
        sourceContext: record.options?.sourceContext, query: body.content || body.goal || '' }) };
    let result;
    if (pathname.endsWith('/start')) result = await startWork(options);
    else if (pathname.endsWith('/update')) result = await updateWork(options);
    else if (pathname.endsWith('/suggest')) result = await createWorkSuggestion(options);
    else if (pathname.endsWith('/explain')) result = await explainWorkSuggestion(options);
    else if (pathname.endsWith('/review')) result = await reviewRelatedWork(options);
    else throw Object.assign(new Error('Unsupported work operation'), { statusCode: 405 });
    broadcastAll({ type: 'session_invalidated', sessionId });
    broadcastAll({ type: 'sessions_invalidated' });
    writeJson(res, 200, result);
  } catch (error) { writeJson(res, error.statusCode || 400, { error: error.message }); }
  return true;
}
