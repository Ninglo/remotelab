import { homedir } from 'os';
import { join, resolve } from 'path';

import { IS_GUEST_INSTANCE, MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import { resolveOrCreateExternalIdentity } from '../lib/auth.mjs';
import { SYSTEM_IDENTITY_ID, SYSTEM_PERSON_ID } from '../lib/auth-config.mjs';
import { readBody } from '../lib/utils.mjs';
import { appendEvent, readEventBody } from './history.mjs';
import { messageEvent } from './normalizer.mjs';
import { createSessionDetail, createSessionListItem } from './session-api-shapes.mjs';
import { buildEventBlockEvents, buildSessionDisplayEvents } from './session-display-events.mjs';
import { clampGuestSessionFolder } from './session-folder.mjs';
import { resolveStarterPresetDefinition } from './starter-session-content.mjs';
import {
  cancelActiveRun,
  removeQueuedMessage,
  createSession,
  getRunState,
  getSessionReplyPublication,
  getSession,
  getSessionEventsAfter,
  getSessionSourceContext,
  getSessionTimelineEvents,
  listSessions,
  mergeSessionPersonViewOwnership,
  sendMessage,
  submitHttpMessage,
} from './session-manager.mjs';
import { normalizeSessionStarterPreset } from './session-starter-preset.mjs';
import { normalizeSessionExecutionProfile, QUICK_SESSION_PROFILE } from '../lib/quick-session-profile.mjs';
import { readLangSmithCaseConfig, getLatestLangSmithCase } from '../lib/langsmith-case-link.mjs';
import { searchSessionLogs } from './session-log-search.mjs';

export const SESSION_CREATION_MAX_BYTES = 64 * 1024;

function sessionCreationBodyTooLargePayload(error) {
  const contentLengthKnown = Number.isSafeInteger(error?.contentLength);
  const receivedBytes = contentLengthKnown
    ? error.contentLength
    : (Number.isSafeInteger(error?.receivedBytes) ? error.receivedBytes : null);
  const sizeDescription = receivedBytes === null
    ? 'an unknown number of bytes'
    : `${contentLengthKnown ? '' : 'at least '}${receivedBytes} bytes`;
  return {
    error: `POST /api/sessions request body is ${sizeDescription}; maximum is ${SESSION_CREATION_MAX_BYTES} bytes (64 KiB). Keep Session metadata small and submit user content to POST /api/sessions/:sessionId/messages.`,
    code: 'BODY_TOO_LARGE',
    route: 'POST /api/sessions',
    maxBytes: SESSION_CREATION_MAX_BYTES,
    ...(receivedBytes === null ? {} : { receivedBytes }),
  };
}

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

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function resolveSessionInitiator(authSession, sourceId, sourceContext) {
  const context = sourceContext && typeof sourceContext === 'object' ? sourceContext : {};
  const sender = context.sender && typeof context.sender === 'object' ? context.sender : {};
  const kind = trimString(context.connector || sourceId).toLowerCase();
  const subjectId = trimString(
    sender.openId
    || sender.userId
    || sender.unionId
    || sender.address
    || sender.login,
  );
  if (kind && subjectId) {
    const resolved = await resolveOrCreateExternalIdentity({
      kind,
      realm: trimString(context.sourceRouteId || sender.tenantKey || context.tenantKey),
      subjectId,
      stableSubjectId: trimString(sender.unionId || sender.userId || subjectId),
      displayName: trimString(sender.name || sender.displayName || sender.address || sender.login),
      englishName: trimString(sender.englishName),
      handleHint: trimString(sender.handle || sender.username || sender.login),
    });
    if (resolved?.identityId) {
      if (resolved.sourcePersonId && resolved.targetPersonId) {
        await mergeSessionPersonViewOwnership(resolved.sourcePersonId, resolved.targetPersonId);
      }
      return resolved;
    }
  }
  if (authSession?.authKind === 'service') {
    return { identityId: SYSTEM_IDENTITY_ID, personId: SYSTEM_PERSON_ID };
  }
  return {
    identityId: trimString(authSession?.identityId) || SYSTEM_IDENTITY_ID,
    personId: trimString(authSession?.personId) || SYSTEM_PERSON_ID,
  };
}

async function resolveSessionCreationInitiator(req, authSession, sourceId, sourceContext) {
  const direct = await resolveSessionInitiator(authSession, sourceId, sourceContext);
  if (authSession?.authKind !== 'service' || direct.identityId !== SYSTEM_IDENTITY_ID) return direct;
  const sourceSessionId = trimString(req.headers['x-remotelab-source-session-id']);
  if (!sourceSessionId) return direct;
  const sourceSession = await getSession(sourceSessionId);
  const inheritedIdentityId = trimString(sourceSession?.initiatedByIdentityId);
  if (!inheritedIdentityId || inheritedIdentityId === SYSTEM_IDENTITY_ID) return direct;
  return {
    identityId: inheritedIdentityId,
    personId: trimString(authSession?.personId) || SYSTEM_PERSON_ID,
  };
}

export async function handleSessionMainRoutes({
  req,
  res,
  parsedUrl,
  pathname,
  authSession,
  sessionGetRoute,
  createSessionSummaryRef,
  immutablePrivateEventCacheControl,
  isDirectoryPath,
  readSessionMessagePayload,
  requireSessionAccess,
  resolveRequestedSessionAttachments,
  writeJson,
  writeJsonCached,
}) {
  if (sessionGetRoute?.kind === 'search') {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const query = typeof parsedUrl.query.q === 'string' ? parsedUrl.query.q : '';
      writeJson(res, 200, await searchSessionLogs(query));
    } catch (error) {
      writeJson(res, error.statusCode === 400 ? 400 : 503, { error: error.statusCode === 400
        ? error.message : 'Session search is temporarily unavailable' });
    }
    return true;
  }
  if (sessionGetRoute?.kind === 'list' || sessionGetRoute?.kind === 'archived-list') {
    const view = typeof parsedUrl.query.view === 'string'
      ? String(parsedUrl.query.view || '').trim().toLowerCase()
      : '';
    const sessionList = await listSessionListItemsForClient({
      includeArchived: true,
      sourceId: typeof parsedUrl.query.sourceId === 'string' ? parsedUrl.query.sourceId : '',
      viewPersonId: authSession?.personId || '',
    });
    const folderFilter = parsedUrl.query.folder;
    const filtered = folderFilter
      ? sessionList.filter((session) => session.folder === folderFilter)
      : sessionList;
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
      ? await getSessionListItemForClient(sessionId, { viewPersonId: authSession?.personId || '' })
      : await getSessionForClient(sessionId, { includeQueuedMessages: true, viewPersonId: authSession?.personId || '' });
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
    const session = await getSessionForClient(sessionId, { viewPersonId: authSession?.personId || '' });
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

  if (sessionGetRoute?.kind === 'langsmith') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const config = await readLangSmithCaseConfig();
    const latest = await getLatestLangSmithCase(sessionId, config, {
      runId: typeof parsedUrl.query.runId === 'string' ? parsedUrl.query.runId : '',
    });
    res.setHeader('Cache-Control', 'private, no-store');
    if (!latest) { writeJson(res, 202, { status: 'pending', sessionId }); return true; }
    res.writeHead(302, { Location: latest.url });
    res.end();
    return true;
  }

  if (sessionGetRoute?.kind === 'response') {
    const { sessionId, responseId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const replyPublication = await getSessionReplyPublication(sessionId, responseId);
    if (!replyPublication) {
      writeJson(res, 404, { error: 'Reply publication not found' });
      return true;
    }
    writeJsonCached(req, res, { sessionId, responseId, replyPublication });
    return true;
  }

  if (sessionGetRoute?.kind === 'event-block') {
    const {
      sessionId,
      startSeq,
      endSeq,
    } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const session = await getSessionForClient(sessionId, { viewPersonId: authSession?.personId || '' });
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

  if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length === 5 && parts[3] === 'queue') {
      const sessionId = parts[2];
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      let requestId;
      try { requestId = decodeURIComponent(parts[4]); } catch {
        writeJson(res, 400, { error: 'Invalid request id' });
        return true;
      }
      try {
        const outcome = await removeQueuedMessage(sessionId, requestId);
        writeJson(res, 200, { requestId: outcome.requestId, session: createClientSessionDetail(outcome.session) });
      } catch (error) {
        if (!['REQUEST_NOT_FOUND', 'REQUEST_NOT_QUEUED'].includes(error.code)) throw error;
        writeJson(res, error.code === 'REQUEST_NOT_FOUND' ? 404 : 409, { error: error.message, code: error.code });
      }
      return true;
    }
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
          tool: payload.tool || undefined,
          thinking: !!payload.thinking,
          model: payload.model || undefined,
          effort: payload.effort || undefined,
          sourceDelivery: payload.sourceDelivery,
          sourceContext: payload.sourceContext,
          ...(preSavedAttachments.length > 0 ? { preSavedAttachments } : {}),
        };
        const initiator = await resolveSessionInitiator(authSession, payload.sourceId, payload.sourceContext);
        messageOptions.initiatedByIdentityId = initiator.identityId;
        messageOptions.viewPersonId = initiator.personId;
        const outcome = requestId
          ? await submitHttpMessage(sessionId, payload.text.trim(), [], {
              ...messageOptions,
              requestId,
            })
          : await sendMessage(sessionId, payload.text.trim(), [], messageOptions);
        writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: requestId || outcome.requestId || outcome.run?.requestId || null,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          run: outcome.run,
          response: outcome.response || null,
          session: createClientSessionDetail(await getSession(sessionId, {
            viewPersonId: authSession?.personId || initiator.personId,
          }) || outcome.session),
        });
      } catch (error) {
        const statusCode = ['SESSION_ARCHIVED', 'SESSION_BUSY'].includes(error?.code) ? 409 : 400;
        writeJson(res, statusCode, { error: error.message || 'Failed to submit message', ...(error.code ? { code: error.code } : {}) });
      }
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'cancel') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      const run = await cancelActiveRun(sessionId);
      if (!run) {
        const session = await getSessionForClient(sessionId, { viewPersonId: authSession?.personId || '' });
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
    let body;
    try {
      body = await readBody(req, SESSION_CREATION_MAX_BYTES);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        writeJson(res, 413, sessionCreationBodyTooLargePayload(err));
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
        group,
        description,
        starterPreset,
        systemPrompt,
        welcomeMessage,
        model,
        effort,
        thinking,
        internalRole,
        completionTargets,
        externalTriggerId,
        sourceContext,
        executionProfile,
      } = payload;
      const requestedFolder = typeof folder === 'string' ? folder.trim() : '';
      const requestedEffectiveFolder = requestedFolder
        ? (requestedFolder.startsWith('~')
          ? join(homedir(), requestedFolder.slice(1))
          : resolve(requestedFolder))
        : MANAGED_WORK_ROOT_DIR;
      const effectiveFolder = clampGuestSessionFolder(requestedEffectiveFolder, {
        isGuestInstance: IS_GUEST_INSTANCE,
        managedWorkRoot: MANAGED_WORK_ROOT_DIR,
      }).folder;
      const effectiveTool = tool;
      const requestedStarterPreset = normalizeSessionStarterPreset(starterPreset);
      const starterDefinition = requestedStarterPreset
        ? resolveStarterPresetDefinition(requestedStarterPreset)
        : null;
      const explicitSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
      const explicitWelcomeMessage = typeof welcomeMessage === 'string' ? welcomeMessage.trim() : '';
      const requestedExecutionProfile = normalizeSessionExecutionProfile(executionProfile);
      if (executionProfile !== undefined && !requestedExecutionProfile) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'executionProfile must be quick when provided' }));
        return true;
      }
      if (!effectiveTool) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tool is required' }));
        return true;
      }
      if (model !== undefined && typeof model !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'model must be a string' }));
        return true;
      }
      if (effort !== undefined && typeof effort !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'effort must be a string' }));
        return true;
      }
      if (thinking !== undefined && typeof thinking !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'thinking must be a boolean' }));
        return true;
      }
      if (!await isDirectoryPath(effectiveFolder)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder does not exist' }));
        return true;
      }
      const createOptions = {
        sourceId: typeof sourceId === 'string' ? sourceId : '',
        sourceName: typeof sourceName === 'string' ? sourceName : '',
        group: group || '',
        description: description || '',
        completionTargets: Array.isArray(completionTargets) ? completionTargets : [],
        externalTriggerId: typeof externalTriggerId === 'string' ? externalTriggerId : '',
        ...(requestedExecutionProfile ? { executionProfile: requestedExecutionProfile } : {}),
      };
      if (Object.hasOwn(payload, 'conversation')) {
        createOptions.conversation = payload.conversation;
        createOptions.replaceConversation = payload.replaceConversation === true;
      }
      if (requestedStarterPreset) {
        createOptions.starterPreset = requestedStarterPreset;
      }
      if (!requestedExecutionProfile && Object.prototype.hasOwnProperty.call(payload, 'systemPrompt')) {
        createOptions.systemPrompt = explicitSystemPrompt;
      } else if (!requestedExecutionProfile && starterDefinition?.systemPrompt) {
        createOptions.systemPrompt = starterDefinition.systemPrompt;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'internalRole')) {
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
      const initiator = await resolveSessionCreationInitiator(
        req,
        authSession,
        createOptions.sourceId,
        createOptions.sourceContext,
      );
      createOptions.initiatedByIdentityId = initiator.identityId;
      createOptions.viewPersonId = initiator.personId;
      if (typeof model === 'string' && model.trim()) createOptions.model = model.trim();
      if (typeof effort === 'string' && effort.trim()) createOptions.effort = effort.trim();
      if (thinking === true) createOptions.thinking = true;
      const initialWelcomeMessage = requestedExecutionProfile
        ? ''
        : (Object.prototype.hasOwnProperty.call(payload, 'welcomeMessage')
          ? explicitWelcomeMessage
          : (starterDefinition?.welcomeMessage || ''));
      let session = await createSession(effectiveFolder, effectiveTool, name || '', createOptions);
      if (initialWelcomeMessage) {
        await appendEvent(session.id, messageEvent('assistant', initialWelcomeMessage));
        session = await getSession(session.id) || session;
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        session: createClientSessionDetail(await getSession(session.id, {
          viewPersonId: authSession?.personId || initiator.personId,
        }) || session),
      }));
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
