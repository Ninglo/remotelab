import { homedir } from 'os';
import { join, resolve } from 'path';

import { readBody } from '../lib/utils.mjs';
import { readEventBody } from './history.mjs';
import { createSessionDetail, createSessionListItem } from './session-api-shapes.mjs';
import { buildEventBlockEvents, buildSessionDisplayEvents } from './session-display-events.mjs';
import {
  applyTemplateToSession,
  cancelActiveRun,
  createSession,
  getRunState,
  getSession,
  getSessionEventsAfter,
  getSessionSourceContext,
  getSessionTimelineEvents,
  listSessions,
  sendMessage,
  submitHttpMessage,
} from './session-manager.mjs';

function createClientSessionDetail(session) {
  return createSessionDetail(session);
}

async function listSessionListItemsForClient(options = {}) {
  const sessions = await listSessions(options);
  return sessions.map(createSessionListItem);
}

async function getSessionForClient(id, options = {}) {
  return createClientSessionDetail(await getSession(id, options));
}

async function getSessionListItemForClient(id, options = {}) {
  return createSessionListItem(await getSession(id, options));
}

function getGrantedCapability(authSession, capability, fallback = false) {
  if (authSession?.role === 'owner') return true;
  if (!capability) return fallback;
  return authSession?.capabilities?.[capability] === true
    ? true
    : fallback;
}

export async function handleSessionMainRoutes({
  req,
  res,
  parsedUrl,
  pathname,
  authSession,
  sessionGetRoute,
  ensureOwnerStarterSessions,
  createSessionSummaryRef,
  immutablePrivateEventCacheControl,
  isDirectoryPath,
  readSessionMessagePayload,
  requireSessionAccess,
  isSessionVisibleToAuthSession,
  getAuthPrincipalId,
  getAuthScopeAgentId,
  isAgentScopedAuthSession,
  resolveRequestedSessionAttachments,
  writeJson,
  writeJsonCached,
}) {
  if (sessionGetRoute?.kind === 'list' || sessionGetRoute?.kind === 'archived-list') {
    if (authSession?.role === 'visitor' && !getGrantedCapability(authSession, 'listSessions')) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    if (authSession?.role === 'owner') {
      await ensureOwnerStarterSessions();
    }
    const includeVisitor = authSession?.role === 'owner'
      && ['1', 'true', 'yes'].includes(String(parsedUrl.query.includeVisitor || '').toLowerCase());
    const view = typeof parsedUrl.query.view === 'string'
      ? String(parsedUrl.query.view || '').trim().toLowerCase()
      : '';
    const sessionList = await listSessionListItemsForClient({
      includeVisitor: includeVisitor || isAgentScopedAuthSession(authSession),
      includeArchived: true,
      templateId: typeof parsedUrl.query.templateId === 'string' ? parsedUrl.query.templateId : '',
      sourceId: typeof parsedUrl.query.sourceId === 'string' ? parsedUrl.query.sourceId : '',
    });
    const visibleSessions = authSession?.role === 'owner'
      ? sessionList
      : sessionList.filter((session) => isSessionVisibleToAuthSession(authSession, session));
    const folderFilter = parsedUrl.query.folder;
    const filtered = folderFilter
      ? visibleSessions.filter((session) => session.folder === folderFilter)
      : visibleSessions;
    const archivedSessions = filtered.filter((session) => session?.archived === true);
    const activeSessions = filtered.filter((session) => session?.archived !== true);
    const targetSessions = sessionGetRoute.kind === 'archived-list'
      ? archivedSessions
      : activeSessions;
    const sessionRefs = targetSessions.map(createSessionSummaryRef).filter((ref) => ref?.id);
    if (view === 'refs') {
      writeJsonCached(req, res, {
        sessionRefs,
        archivedCount: archivedSessions.length,
      });
      return true;
    }
    writeJsonCached(req, res, {
      sessions: targetSessions,
      archivedCount: archivedSessions.length,
    });
    return true;
  }

  if (sessionGetRoute?.kind === 'detail') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const view = typeof parsedUrl.query.view === 'string'
      ? String(parsedUrl.query.view || '').trim().toLowerCase()
      : '';
    const session = view === 'summary' || view === 'sidebar'
      ? await getSessionListItemForClient(sessionId)
      : await getSessionForClient(sessionId, { includeQueuedMessages: true });
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    writeJsonCached(req, res, { session });
    return true;
  }

  if (sessionGetRoute?.kind === 'events') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const filter = typeof parsedUrl.query.filter === 'string'
      ? String(parsedUrl.query.filter || '').trim().toLowerCase()
      : '';
    if (filter === 'all') {
      const events = await getSessionEventsAfter(sessionId, 0);
      writeJsonCached(req, res, { sessionId, filter: 'all', events });
      return true;
    }
    const session = await getSessionForClient(sessionId);
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const timeline = await getSessionTimelineEvents(sessionId);
    const events = buildSessionDisplayEvents(timeline, {
      sessionRunning: session?.activity?.run?.state === 'running',
    });
    writeJsonCached(req, res, { sessionId, filter: 'visible', events });
    return true;
  }

  if (sessionGetRoute?.kind === 'source-context') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const sourceContext = await getSessionSourceContext(sessionId, {
      requestId: typeof parsedUrl.query.requestId === 'string' ? parsedUrl.query.requestId : '',
    });
    if (!sourceContext) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    writeJson(res, 200, { sessionId, sourceContext });
    return true;
  }

  if (sessionGetRoute?.kind === 'event-block') {
    const {
      sessionId,
      startSeq,
      endSeq,
    } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const session = await getSessionForClient(sessionId);
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const timeline = await getSessionTimelineEvents(sessionId);
    const events = buildEventBlockEvents(timeline, startSeq, endSeq);
    if (events.length === 0) {
      writeJson(res, 404, { error: 'Event block not found' });
      return true;
    }
    writeJsonCached(req, res, { sessionId, startSeq, endSeq, events }, {
      cacheControl: immutablePrivateEventCacheControl,
      vary: '',
    });
    return true;
  }

  if (sessionGetRoute?.kind === 'event-body') {
    const { sessionId, seq } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const body = await readEventBody(sessionId, seq);
    if (!body) {
      writeJson(res, 404, { error: 'Event body not found' });
      return true;
    }
    writeJsonCached(req, res, { body }, {
      cacheControl: immutablePrivateEventCacheControl,
      vary: '',
    });
    return true;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    const action = parts[3] || null;

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'messages') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      let body;
      try {
        body = await readSessionMessagePayload(req, pathname);
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      const payload = body;
      if (!payload || typeof payload !== 'object') {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      if (!payload?.text || typeof payload.text !== 'string') {
        writeJson(res, 400, { error: 'text is required' });
        return true;
      }
      try {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
        const requestedAttachments = Array.isArray(payload?.attachments) ? payload.attachments.filter(Boolean) : [];
        const preSavedAttachments = await resolveRequestedSessionAttachments(authSession, requestedAttachments, {
          sessionId,
        });
        const messageOptions = {
          tool: authSession?.role === 'visitor' ? undefined : payload.tool || undefined,
          thinking: authSession?.role === 'visitor' ? false : !!payload.thinking,
          model: authSession?.role === 'visitor' ? undefined : payload.model || undefined,
          effort: authSession?.role === 'visitor' ? undefined : payload.effort || undefined,
          sourceContext: authSession?.role === 'visitor' ? undefined : payload.sourceContext,
          ...(preSavedAttachments.length > 0 ? { preSavedAttachments } : {}),
        };
        const outcome = requestId
          ? await submitHttpMessage(sessionId, payload.text.trim(), [], {
              ...messageOptions,
              requestId,
            })
          : await sendMessage(sessionId, payload.text.trim(), [], messageOptions);
        writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: requestId || outcome.run?.requestId || null,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          run: outcome.run,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode = error?.code === 'SESSION_ARCHIVED' ? 409 : 400;
        writeJson(res, statusCode, { error: error.message || 'Failed to submit message' });
      }
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'cancel') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      const run = await cancelActiveRun(sessionId);
      if (!run) {
        const session = await getSessionForClient(sessionId);
        if (session && session.activity?.run?.state !== 'running') {
          writeJson(res, 200, { run: null, session });
          return true;
        }
        writeJson(res, 409, { error: 'No active run' });
        return true;
      }
      writeJson(res, 200, { run });
      return true;
    }
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    if (authSession?.role === 'visitor' && !getGrantedCapability(authSession, 'createSession')) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    let body;
    try {
      body = await readBody(req, 10240);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return true;
      }
      throw err;
    }
    try {
      const payload = JSON.parse(body);
      const {
        folder,
        tool,
        name,
        sourceId,
        sourceName,
        templateId,
        templateName,
        group,
        description,
        systemPrompt,
        internalRole,
        completionTargets,
        externalTriggerId,
        sourceContext,
      } = payload;
      const agentScoped = isAgentScopedAuthSession(authSession);
      const scopedAgentId = getAuthScopeAgentId(authSession);
      const scopedPrincipalId = getAuthPrincipalId(authSession);
      const effectiveFolder = agentScoped
        ? homedir()
        : (folder.startsWith('~')
          ? join(homedir(), folder.slice(1))
          : resolve(folder));
      const effectiveTool = agentScoped
        ? (typeof authSession?.agentTool === 'string' && authSession.agentTool.trim()
          ? authSession.agentTool.trim()
          : tool)
        : tool;
      if ((!agentScoped && !folder) || !effectiveTool) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'folder and tool are required' }));
        return true;
      }
      if (!await isDirectoryPath(effectiveFolder)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder does not exist' }));
        return true;
      }
      const createOptions = {
        sourceId: agentScoped ? 'share_link' : (typeof sourceId === 'string' ? sourceId : ''),
        sourceName: agentScoped ? 'Share Link' : (typeof sourceName === 'string' ? sourceName : ''),
        templateId: agentScoped ? scopedAgentId : (typeof templateId === 'string' ? templateId : ''),
        templateName: agentScoped
          ? (typeof authSession?.agentName === 'string' ? authSession.agentName : '')
          : (typeof templateName === 'string' ? templateName : ''),
        group: group || '',
        description: description || '',
        completionTargets: Array.isArray(completionTargets) ? completionTargets : [],
        externalTriggerId: typeof externalTriggerId === 'string' ? externalTriggerId : '',
      };
      if (agentScoped) {
        createOptions.agentId = scopedAgentId;
        createOptions.createdByPrincipalId = scopedPrincipalId;
        createOptions.visitorId = scopedPrincipalId;
        createOptions.visitorName = 'Guest';
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'systemPrompt')) {
        createOptions.systemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'internalRole')) {
        if (agentScoped) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Owner access required' }));
          return true;
        }
        if (internalRole !== null && typeof internalRole !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internalRole must be a string when provided' }));
          return true;
        }
        createOptions.internalRole = typeof internalRole === 'string' ? internalRole.trim() : '';
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'sourceContext')) {
        createOptions.sourceContext = sourceContext;
      }
      let session = await createSession(effectiveFolder, effectiveTool, name || '', createOptions);
      if (createOptions.templateId) {
        session = await applyTemplateToSession(session.id, createOptions.templateId, {
          appendWelcome: true,
          allowVisitor: agentScoped,
        }) || session;
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: createClientSessionDetail(session) }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return true;
  }

  if (pathname.startsWith('/api/runs/') && req.method === 'GET') {
    const parts = pathname.split('/').filter(Boolean);
    const runId = parts[2];
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'runs' || !runId) {
      writeJson(res, 400, { error: 'Invalid run path' });
      return true;
    }
    const run = await getRunState(runId);
    if (!run) {
      writeJson(res, 404, { error: 'Run not found' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, run.sessionId)) return true;
    writeJsonCached(req, res, { run });
    return true;
  }

  if (pathname.startsWith('/api/runs/') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const runId = parts[2];
    const action = parts[3];
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'runs' && action === 'cancel' && runId) {
      const run = await getRunState(runId);
      if (!run) {
        writeJson(res, 404, { error: 'Run not found' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, run.sessionId)) return true;
      const updated = await cancelActiveRun(run.sessionId);
      if (!updated) {
        const refreshed = await getRunState(runId);
        if (refreshed && refreshed.state !== 'running' && refreshed.state !== 'accepted') {
          writeJson(res, 200, { run: refreshed });
          return true;
        }
        writeJson(res, 409, { error: 'No active run' });
        return true;
      }
      writeJson(res, 200, { run: updated });
      return true;
    }
  }

  return false;
}
