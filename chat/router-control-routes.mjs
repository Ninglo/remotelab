import { readFile, readdir } from 'fs/promises';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { CHAT_IMAGES_DIR, FILE_ASSET_STORAGE_PROVIDER } from '../lib/config.mjs';
import { createTask, getTask, listTasks, updateTask, deleteTask } from './task-manager.mjs';
import { createReport, listReports, getReport, getReportHtml, markAsRead, deleteReport } from './reports.mjs';
import { updateLastRun, reloadSchedule } from './scheduler.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { saveUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { getAvailableToolsAsync, saveSimpleToolAsync } from '../lib/tools.mjs';
import { readBody } from '../lib/utils.mjs';
import { getModelsForTool } from './models.mjs';
import { getPublicKey, addSubscription } from './push.mjs';
import { createSessionDetail } from './session-api-shapes.mjs';
import { normalizeSessionEntryMode } from './session-entry-mode.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  updateTrigger,
} from './triggers.mjs';
import {
  buildAttachmentContentDisposition,
  buildFileAssetDirectUrl,
  createFileAssetUploadIntent,
  finalizeFileAssetUpload,
  getFileAsset,
  getFileAssetForClient,
  localizeFileAsset,
} from './file-assets.mjs';
import { createShareSnapshot } from './shares.mjs';
import {
  pathExists,
} from './fs-utils.mjs';
import {
  applyTemplateToSession,
  appendAssistantMessage,
  compactSession,
  delegateSession,
  dropToolUse,
  forkSession,
  getHistory,
  getSession,
  renameSession,
  saveSessionAsTemplate,
  setSessionArchived,
  setSessionPinned,
  updateSessionAgreements,
  updateSessionEntryMode,
  updateSessionGrouping,
  updateSessionLastReviewedAt,
  updateSessionRuntimePreferences,
  updateSessionWorkflowClassification,
} from './session-manager.mjs';

const uploadedMediaMimeTypes = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  m4a: 'audio/mp4',
  m4v: 'video/x-m4v',
  md: 'text/markdown; charset=utf-8',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain; charset=utf-8',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  zip: 'application/zip',
};

function createClientSessionDetail(session) {
  return createSessionDetail(session);
}

async function getSessionForClient(id, options = {}) {
  return createClientSessionDetail(await getSession(id, options));
}

export async function handleControlRoutes({
  req,
  res,
  parsedUrl,
  pathname,
  authSession,
  triggerId,
  fileAssetRoute,
  buildHeaders,
  isDirectoryPath,
  readSessionMessagePayload,
  requireSessionAccess,
  resolveRequestedSessionAttachments,
  streamResponse,
  writeFileCached,
  writeJson,
  writeJsonCached,
}) {
  if (pathname === '/api/triggers' && req.method === 'GET') {
    const sessionId = typeof parsedUrl?.query?.sessionId === 'string'
      ? parsedUrl.query.sessionId
      : '';
    const triggers = await listTriggers({ sessionId });
    writeJson(res, 200, { triggers });
    return true;
  }

  if (pathname === '/api/triggers' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      if (Object.prototype.hasOwnProperty.call(payload, 'thinking') && typeof payload.thinking !== 'boolean') {
        writeJson(res, 400, { error: 'thinking must be a boolean' });
        return true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'enabled') && typeof payload.enabled !== 'boolean') {
        writeJson(res, 400, { error: 'enabled must be a boolean' });
        return true;
      }
      const trigger = await createTrigger(payload || {});
      writeJson(res, 201, { trigger });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to create trigger' });
    }
    return true;
  }

  if (triggerId && req.method === 'GET') {
    const trigger = await getTrigger(triggerId);
    if (!trigger) {
      writeJson(res, 404, { error: 'Trigger not found' });
      return true;
    }
    writeJson(res, 200, { trigger });
    return true;
  }

  if (triggerId && req.method === 'PATCH') {
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      if (Object.prototype.hasOwnProperty.call(payload, 'thinking') && typeof payload.thinking !== 'boolean') {
        writeJson(res, 400, { error: 'thinking must be a boolean' });
        return true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'enabled') && typeof payload.enabled !== 'boolean') {
        writeJson(res, 400, { error: 'enabled must be a boolean' });
        return true;
      }
      const trigger = await updateTrigger(triggerId, payload || {});
      if (!trigger) {
        writeJson(res, 404, { error: 'Trigger not found' });
        return true;
      }
      writeJson(res, 200, { trigger });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to update trigger' });
    }
    return true;
  }

  if (triggerId && req.method === 'DELETE') {
    const trigger = await deleteTrigger(triggerId);
    if (!trigger) {
      writeJson(res, 404, { error: 'Trigger not found' });
      return true;
    }
    writeJson(res, 200, { ok: true, trigger });
    return true;
  }

  if (pathname === '/api/assets/upload-intents' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }

    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) {
      writeJson(res, 400, { error: 'sessionId is required' });
      return true;
    }
    if (!requireSessionAccess(res, authSession, sessionId)) return true;

    try {
      const intent = await createFileAssetUploadIntent({
        sessionId,
        originalName: typeof payload?.originalName === 'string' ? payload.originalName : '',
        mimeType: typeof payload?.mimeType === 'string' ? payload.mimeType : '',
        sizeBytes: payload?.sizeBytes,
        createdBy: authSession?.role === 'visitor' ? 'visitor' : 'owner',
      });
      writeJson(res, 200, intent);
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to create upload intent' });
    }
    return true;
  }

  if (fileAssetRoute && req.method === 'GET' && !fileAssetRoute.action) {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return true;
    }
    if (!requireSessionAccess(res, authSession, asset.sessionId)) return true;
    const clientAsset = await getFileAssetForClient(asset.id, {
      includeDirectUrl: asset.status === 'ready',
    });
    writeJson(res, 200, { asset: clientAsset });
    return true;
  }

  if (fileAssetRoute?.action === 'finalize' && req.method === 'POST') {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return true;
    }
    if (!requireSessionAccess(res, authSession, asset.sessionId)) return true;

    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }

    try {
      const next = await finalizeFileAssetUpload(asset.id, {
        sizeBytes: payload?.sizeBytes,
        etag: typeof payload?.etag === 'string' ? payload.etag : '',
      });
      writeJson(res, 200, { asset: next });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to finalize asset upload' });
    }
    return true;
  }

  if (fileAssetRoute?.action === 'download' && req.method === 'GET') {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return true;
    }
    if (!requireSessionAccess(res, authSession, asset.sessionId)) return true;
    const downloadRequested = String(parsedUrl?.query?.download || '') === '1';

    try {
      if (asset.storage?.provider === 'local' || (downloadRequested && FILE_ASSET_STORAGE_PROVIDER === 'tos')) {
        const localPath = await localizeFileAsset(asset);
        streamResponse(res, localPath, {
          'Content-Type': asset.mimeType || 'application/octet-stream',
          'Content-Disposition': buildAttachmentContentDisposition(asset.originalName, { attachment: downloadRequested }),
          'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        });
        return true;
      }
      const direct = await buildFileAssetDirectUrl(asset, { attachment: downloadRequested });
      res.writeHead(302, buildHeaders({
        Location: direct.url,
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end();
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to build asset download link' });
    }
    return true;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'PATCH') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'sessions' || !sessionId) {
      writeJson(res, 400, { error: 'Invalid session path' });
      return true;
    }
    if (!requireSessionAccess(res, authSession, sessionId)) return true;
    let body;
    try { body = await readBody(req, 10240); } catch {
      writeJson(res, 400, { error: 'Bad request' });
      return true;
    }
    let patch;
    try { patch = JSON.parse(body); } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    const hasArchivedPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'archived');
    const hasPinnedPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'pinned');
    const hasToolPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'tool');
    const hasModelPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'model');
    const hasEffortPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'effort');
    const hasThinkingPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'thinking');
    const hasGroupPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'group');
    const hasDescriptionPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'description');
    const hasSidebarOrderPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'sidebarOrder');
    const hasActiveAgreementsPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'activeAgreements');
    const hasWorkflowStatePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'workflowState');
    const hasWorkflowPriorityPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'workflowPriority');
    const hasLastReviewedAtPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'lastReviewedAt');
    const hasEntryModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'entryMode');
    if (hasArchivedPatch && typeof patch.archived !== 'boolean') {
      writeJson(res, 400, { error: 'archived must be a boolean' });
      return true;
    }
    if (hasPinnedPatch && typeof patch.pinned !== 'boolean') {
      writeJson(res, 400, { error: 'pinned must be a boolean' });
      return true;
    }
    if (hasToolPatch && typeof patch.tool !== 'string') {
      writeJson(res, 400, { error: 'tool must be a string' });
      return true;
    }
    if (hasModelPatch && typeof patch.model !== 'string') {
      writeJson(res, 400, { error: 'model must be a string' });
      return true;
    }
    if (hasEffortPatch && typeof patch.effort !== 'string') {
      writeJson(res, 400, { error: 'effort must be a string' });
      return true;
    }
    if (hasThinkingPatch && typeof patch.thinking !== 'boolean') {
      writeJson(res, 400, { error: 'thinking must be a boolean' });
      return true;
    }
    if (hasGroupPatch && patch.group !== null && typeof patch.group !== 'string') {
      writeJson(res, 400, { error: 'group must be a string or null' });
      return true;
    }
    if (hasDescriptionPatch && patch.description !== null && typeof patch.description !== 'string') {
      writeJson(res, 400, { error: 'description must be a string or null' });
      return true;
    }
    if (hasSidebarOrderPatch && patch.sidebarOrder !== null && (!Number.isInteger(patch.sidebarOrder) || patch.sidebarOrder < 1)) {
      writeJson(res, 400, { error: 'sidebarOrder must be a positive integer or null' });
      return true;
    }
    if (hasActiveAgreementsPatch && patch.activeAgreements !== null && !Array.isArray(patch.activeAgreements)) {
      writeJson(res, 400, { error: 'activeAgreements must be an array of strings or null' });
      return true;
    }
    if (hasActiveAgreementsPatch && Array.isArray(patch.activeAgreements)) {
      const invalidAgreement = patch.activeAgreements.find((entry) => typeof entry !== 'string');
      if (invalidAgreement !== undefined) {
        writeJson(res, 400, { error: 'activeAgreements must contain only strings' });
        return true;
      }
    }
    if (hasWorkflowStatePatch && patch.workflowState !== null && typeof patch.workflowState !== 'string') {
      writeJson(res, 400, { error: 'workflowState must be a string or null' });
      return true;
    }
    if (hasWorkflowPriorityPatch && patch.workflowPriority !== null && typeof patch.workflowPriority !== 'string') {
      writeJson(res, 400, { error: 'workflowPriority must be a string or null' });
      return true;
    }
    if (hasLastReviewedAtPatch && patch.lastReviewedAt !== null && typeof patch.lastReviewedAt !== 'string') {
      writeJson(res, 400, { error: 'lastReviewedAt must be a string or null' });
      return true;
    }
    if (hasEntryModePatch && patch.entryMode !== null && typeof patch.entryMode !== 'string') {
      writeJson(res, 400, { error: 'entryMode must be a string or null' });
      return true;
    }
    if (hasEntryModePatch && authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required to update entryMode' });
      return true;
    }
    if (
      hasWorkflowStatePatch
      && patch.workflowState !== null
      && String(patch.workflowState).trim()
      && !normalizeSessionWorkflowState(String(patch.workflowState))
    ) {
      writeJson(res, 400, { error: 'workflowState must be parked, waiting_user, or done' });
      return true;
    }
    if (
      hasWorkflowPriorityPatch
      && patch.workflowPriority !== null
      && String(patch.workflowPriority).trim()
      && !normalizeSessionWorkflowPriority(String(patch.workflowPriority))
    ) {
      writeJson(res, 400, { error: 'workflowPriority must be high, medium, or low' });
      return true;
    }
    if (
      hasLastReviewedAtPatch
      && patch.lastReviewedAt !== null
      && String(patch.lastReviewedAt).trim()
      && !Number.isFinite(Date.parse(String(patch.lastReviewedAt).trim()))
    ) {
      writeJson(res, 400, { error: 'lastReviewedAt must be a valid timestamp or null' });
      return true;
    }
    if (
      hasEntryModePatch
      && patch.entryMode !== null
      && String(patch.entryMode).trim()
      && !normalizeSessionEntryMode(String(patch.entryMode), { allowDefault: true })
    ) {
      writeJson(res, 400, { error: 'entryMode must be read, resume, or null' });
      return true;
    }
    let session = null;
    if (typeof patch.name === 'string' && patch.name.trim()) {
      session = await renameSession(sessionId, patch.name.trim());
    }
    if (hasArchivedPatch) {
      session = await setSessionArchived(sessionId, patch.archived) || session;
    }
    if (hasPinnedPatch) {
      session = await setSessionPinned(sessionId, patch.pinned) || session;
    }
    if (hasGroupPatch || hasDescriptionPatch || hasSidebarOrderPatch) {
      session = await updateSessionGrouping(sessionId, {
        ...(hasGroupPatch ? { group: patch.group ?? '' } : {}),
        ...(hasDescriptionPatch ? { description: patch.description ?? '' } : {}),
        ...(hasSidebarOrderPatch ? { sidebarOrder: patch.sidebarOrder ?? null } : {}),
      }) || session;
    }
    if (hasActiveAgreementsPatch) {
      session = await updateSessionAgreements(sessionId, {
        activeAgreements: patch.activeAgreements ?? [],
      }) || session;
    }
    if (hasWorkflowStatePatch || hasWorkflowPriorityPatch) {
      session = await updateSessionWorkflowClassification(sessionId, {
        ...(hasWorkflowStatePatch ? { workflowState: patch.workflowState || '' } : {}),
        ...(hasWorkflowPriorityPatch ? { workflowPriority: patch.workflowPriority || '' } : {}),
      }) || session;
    }
    if (hasToolPatch || hasModelPatch || hasEffortPatch || hasThinkingPatch) {
      session = await updateSessionRuntimePreferences(sessionId, {
        ...(hasToolPatch ? { tool: patch.tool } : {}),
        ...(hasModelPatch ? { model: patch.model } : {}),
        ...(hasEffortPatch ? { effort: patch.effort } : {}),
        ...(hasThinkingPatch ? { thinking: patch.thinking } : {}),
      }) || session;
    }
    if (hasLastReviewedAtPatch) {
      session = await updateSessionLastReviewedAt(sessionId, patch.lastReviewedAt || '') || session;
    }
    if (hasEntryModePatch) {
      session = await updateSessionEntryMode(sessionId, patch.entryMode || '') || session;
    }
    if (!session) {
      session = await getSessionForClient(sessionId);
    }
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    writeJson(res, 200, { session: createClientSessionDetail(session) });
    return true;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    const action = parts[3] || null;

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'assistant-messages') {
      if (!requireSessionAccess(res, authSession, sessionId)) return true;
      if (authSession?.role !== 'owner') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
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
      try {
        const requestedAttachments = Array.isArray(payload?.attachments) ? payload.attachments.filter(Boolean) : [];
        const preSavedAttachments = await resolveRequestedSessionAttachments(authSession, requestedAttachments, {
          sessionId,
          allowLocalPaths: true,
          createdBy: 'assistant',
        });
        const outcome = await appendAssistantMessage(sessionId, payload.text || '', [], {
          requestId: typeof payload?.requestId === 'string' ? payload.requestId.trim() : '',
          runId: typeof payload?.runId === 'string' ? payload.runId.trim() : '',
          source: payload.source || 'assistant_message_api',
          ...(preSavedAttachments.length > 0 ? { preSavedAttachments } : {}),
        });
        writeJson(res, 201, {
          event: outcome.event,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode = error?.code === 'SESSION_ARCHIVED'
          ? 409
          : (Number.isInteger(error?.statusCode) ? error.statusCode : (error?.code === 'MESSAGE_EMPTY' ? 400 : 400));
        writeJson(res, statusCode, { error: error.message || 'Failed to append assistant message' });
      }
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'voice-transcriptions' && req.method === 'POST') {
      if (!requireSessionAccess(res, authSession, sessionId)) return true;
      writeJson(res, 410, { error: 'Voice transcript cleanup has been removed. Send messages directly.' });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'compact') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      if (!await compactSession(sessionId)) {
        writeJson(res, 409, { error: 'Unable to compact session' });
        return true;
      }
      writeJson(res, 200, { ok: true, session: await getSessionForClient(sessionId) });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'drop-tools') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      if (!await dropToolUse(sessionId)) {
        writeJson(res, 409, { error: 'Unable to drop tool results' });
        return true;
      }
      writeJson(res, 200, { ok: true, session: await getSessionForClient(sessionId) });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'apply-template') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      if (!requireSessionAccess(res, authSession, sessionId)) return true;
      let body;
      try { body = await readBody(req, 10240); } catch {
        writeJson(res, 400, { error: 'Bad request' });
        return true;
      }
      let payload;
      try { payload = JSON.parse(body); } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      const templateId = typeof payload?.templateId === 'string' ? payload.templateId.trim() : '';
      if (!templateId) {
        writeJson(res, 400, { error: 'templateId is required' });
        return true;
      }
      const session = await getSessionForClient(sessionId);
      if (!session) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      if (session.activity?.run?.state === 'running') {
        writeJson(res, 409, { error: 'Session is running' });
        return true;
      }
      if ((session.messageCount || 0) > 0) {
        writeJson(res, 409, { error: 'Templates can only be applied before the first message' });
        return true;
      }
      const updated = await applyTemplateToSession(sessionId, templateId);
      if (!updated) {
        writeJson(res, 409, { error: 'Unable to apply template' });
        return true;
      }
      writeJson(res, 200, { session: createClientSessionDetail(updated) });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'save-template') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      if (!requireSessionAccess(res, authSession, sessionId)) return true;
      let body = '';
      try { body = await readBody(req, 10240); } catch {
        writeJson(res, 400, { error: 'Bad request' });
        return true;
      }
      let payload = {};
      if (body) {
        try { payload = JSON.parse(body); } catch {
          writeJson(res, 400, { error: 'Invalid request body' });
          return true;
        }
      }
      const session = await getSessionForClient(sessionId);
      if (!session) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      const template = await saveSessionAsTemplate(sessionId, typeof payload?.name === 'string' ? payload.name.trim() : '');
      if (!template) {
        writeJson(res, 409, { error: 'Unable to save template' });
        return true;
      }
      writeJson(res, 201, { template });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'fork') {
      if (!requireSessionAccess(res, authSession, sessionId)) return true;
      const source = await getSessionForClient(sessionId);
      if (!source) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      if (source.visitorId) {
        writeJson(res, 409, { error: 'Visitor sessions cannot be forked' });
        return true;
      }
      if (source.activity?.run?.state === 'running') {
        writeJson(res, 409, { error: 'Session is running' });
        return true;
      }
      const session = await forkSession(sessionId);
      if (!session) {
        writeJson(res, 409, { error: 'Unable to fork session' });
        return true;
      }
      writeJson(res, 201, { session: createClientSessionDetail(session) });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'delegate') {
      if (!requireSessionAccess(res, authSession, sessionId)) return true;
      const source = await getSessionForClient(sessionId);
      if (!source) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      if (source.visitorId) {
        writeJson(res, 409, { error: 'Visitor sessions cannot be delegated' });
        return true;
      }

      let payload = {};
      try {
        const body = await readBody(req, 32768);
        payload = body ? JSON.parse(body) : {};
      } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }

      const task = typeof payload?.task === 'string' ? payload.task.trim() : '';
      if (!task) {
        writeJson(res, 400, { error: 'task is required' });
        return true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'tool') && payload.tool !== null && typeof payload.tool !== 'string') {
        writeJson(res, 400, { error: 'tool must be a string when provided' });
        return true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'internal') && typeof payload.internal !== 'boolean') {
        writeJson(res, 400, { error: 'internal must be a boolean when provided' });
        return true;
      }

      try {
        const outcome = await delegateSession(sessionId, {
          task,
          name: typeof payload?.name === 'string' ? payload.name.trim() : '',
          tool: typeof payload?.tool === 'string' ? payload.tool.trim() : '',
          internal: payload?.internal === true,
        });
        if (!outcome?.session) {
          writeJson(res, 409, { error: 'Unable to delegate session' });
          return true;
        }
        writeJson(res, 201, {
          session: createClientSessionDetail(outcome.session),
          run: outcome.run || null,
        });
      } catch (error) {
        writeJson(res, 400, { error: error.message || 'Failed to delegate session' });
      }
      return true;
    }
  }

  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/share') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const id = parts[2];
    if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'sessions' || parts[3] !== 'share' || !id) {
      writeJson(res, 400, { error: 'Invalid session share path' });
      return true;
    }

    const session = await getSessionForClient(id);
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }

    const snapshot = await createShareSnapshot(session, await getHistory(id));
    writeJson(res, 201, {
      share: {
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        url: `share/${snapshot.id}`,
      },
    });
    return true;
  }

  if (pathname === '/api/runtime-selection' && req.method === 'POST') {
    if (authSession?.role === 'visitor') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let body;
    try { body = await readBody(req, 4096); } catch (err) {
      writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const selection = await saveUiRuntimeSelection(payload || {});
      writeJson(res, 200, { selection });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to save runtime selection' });
    }
    return true;
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const toolId = parsedUrl.query ? parsedUrl.query.tool || '' : '';
    const result = await getModelsForTool(toolId);
    writeJsonCached(req, res, result);
    return true;
  }

  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = await getAvailableToolsAsync();
    writeJsonCached(req, res, { tools });
    return true;
  }

  if (pathname === '/api/tools' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return true;
    }

    let body;
    try { body = await readBody(req, 65536); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return true;
    }

    try {
      const { name, command, runtimeFamily, models, reasoning } = JSON.parse(body);
      const tool = await saveSimpleToolAsync({ name, command, runtimeFamily, models, reasoning });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tool }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Invalid request body' }));
    }
    return true;
  }

  if (pathname === '/api/autocomplete' && req.method === 'GET') {
    const query = parsedUrl.query.q || '';
    const suggestions = [];
    try {
      const resolvedQuery = query.startsWith('~') ? join(homedir(), query.slice(1)) : query;
      const parentDir = dirname(resolvedQuery);
      const prefix = basename(resolvedQuery);
      if (await isDirectoryPath(parentDir)) {
        for (const entry of await readdir(parentDir)) {
          if (!prefix.startsWith('.') && entry.startsWith('.')) continue;
          const fullPath = join(parentDir, entry);
          if (await isDirectoryPath(fullPath)) {
            if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
              suggestions.push(fullPath);
            }
          }
        }
      }
    } catch {}
    writeJsonCached(req, res, { suggestions: suggestions.slice(0, 20) });
    return true;
  }

  if (pathname === '/api/browse' && req.method === 'GET') {
    const pathQuery = parsedUrl.query.path || '~';
    try {
      const resolvedPath = pathQuery === '~' || pathQuery === ''
        ? homedir()
        : pathQuery.startsWith('~')
          ? join(homedir(), pathQuery.slice(1))
          : resolve(pathQuery);
      const children = [];
      let parent = null;
      if (await isDirectoryPath(resolvedPath)) {
        const parentPath = dirname(resolvedPath);
        parent = parentPath !== resolvedPath ? parentPath : null;
        for (const entry of await readdir(resolvedPath)) {
          if (entry.startsWith('.')) continue;
          const fullPath = join(resolvedPath, entry);
          try {
            if (await isDirectoryPath(fullPath)) children.push({ name: entry, path: fullPath });
          } catch {}
        }
        children.sort((a, b) => a.name.localeCompare(b.name));
      }
      writeJsonCached(req, res, { path: resolvedPath, parent, children });
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to browse directory' }));
    }
    return true;
  }

  if ((pathname.startsWith('/api/images/') || pathname.startsWith('/api/media/')) && req.method === 'GET') {
    const prefix = pathname.startsWith('/api/media/') ? '/api/media/' : '/api/images/';
    const filename = pathname.slice(prefix.length);
    if (!/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid filename');
      return true;
    }
    const filepath = join(CHAT_IMAGES_DIR, filename);
    if (!await pathExists(filepath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return true;
    }
    const ext = filename.split('.').pop()?.toLowerCase();
    writeFileCached(req, res, uploadedMediaMimeTypes[ext] || 'application/octet-stream', await readFile(filepath), {
      cacheControl: 'public, max-age=31536000, immutable',
    });
    return true;
  }

  if (pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
    writeJsonCached(req, res, { publicKey: await getPublicKey() });
    return true;
  }

  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 4096); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return true;
    }
    try {
      const sub = JSON.parse(body);
      if (!sub.endpoint) throw new Error('Missing endpoint');
      await addSubscription(sub);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid subscription' }));
    }
    return true;
  }

  // ---- Internal Report Submission (MCP submit_report) ----

  if (pathname === '/api/internal/report' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 65536); } catch { body = '{}'; }
    let data;
    try { data = JSON.parse(body); } catch {
      writeJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const { title, file_path: filePath, session_id: sessionId, source } = data;
    try {
      const session = sessionId ? await getSession(sessionId) : null;
      const report = createReport({
        title,
        filePath,
        sessionId,
        sessionFolder: session?.folder || null,
        source: source || 'unknown',
      });
      writeJson(res, 201, { success: true, reportId: report.id, report });
    } catch (err) {
      writeJson(res, 400, { error: err.message });
    }
    return true;
  }

  // ---- Reports API ----

  if (pathname === '/api/reports' && req.method === 'GET') {
    writeJson(res, 200, listReports());
    return true;
  }

  const reportMatch = pathname.match(/^\/api\/reports\/([a-f0-9]+)(\/(\w+))?$/);
  if (reportMatch) {
    const id = reportMatch[1];
    const sub = reportMatch[3];

    if (!sub && req.method === 'GET') {
      const report = getReport(id);
      if (!report) {
        writeJson(res, 404, { error: 'Report not found' });
        return true;
      }
      writeJson(res, 200, report);
      return true;
    }

    if (sub === 'html' && req.method === 'GET') {
      const html = getReportHtml(id);
      if (html === null) {
        writeJson(res, 404, { error: 'Report not found' });
        return true;
      }
      const injected = html.replace(/(<head\b[^>]*>)/i, '$1<base target="_blank">');
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: blob:",
      });
      res.end(injected);
      return true;
    }

    if (sub === 'read' && req.method === 'PATCH') {
      const updated = markAsRead(id);
      if (!updated) {
        writeJson(res, 404, { error: 'Report not found' });
        return true;
      }
      writeJson(res, 200, updated);
      return true;
    }

    if (!sub && req.method === 'DELETE') {
      const ok = deleteReport(id);
      if (!ok) {
        writeJson(res, 404, { error: 'Report not found' });
        return true;
      }
      writeJson(res, 200, { ok: true });
      return true;
    }
  }

  // ---- Schedules API ----

  if (pathname === '/api/schedules' && req.method === 'GET') {
    try {
      const schedulesFile = join(__dirname, '..', 'workflows', 'schedules.json');
      const data = existsSync(schedulesFile)
        ? JSON.parse(readFileSync(schedulesFile, 'utf8'))
        : { schedules: [] };
      writeJson(res, 200, data);
    } catch (err) {
      writeJson(res, 500, { error: err.message });
    }
    return true;
  }

  const scheduleTriggerMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/trigger$/);
  if (scheduleTriggerMatch && req.method === 'POST') {
    const scheduleId = scheduleTriggerMatch[1];
    try {
      const schedulesFile = join(__dirname, '..', 'workflows', 'schedules.json');
      const data = existsSync(schedulesFile)
        ? JSON.parse(readFileSync(schedulesFile, 'utf8'))
        : { schedules: [] };
      const schedule = data.schedules.find(s => s.id === scheduleId);
      if (!schedule) {
        writeJson(res, 404, { error: 'Schedule not found' });
        return true;
      }
      updateLastRun(scheduleId);
      writeJson(res, 202, { ok: true, workflow: schedule.workflow, status: 'triggered' });
    } catch (err) {
      writeJson(res, 500, { error: err.message });
    }
    return true;
  }

  const scheduleReloadMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/reload$/);
  if (scheduleReloadMatch && req.method === 'POST') {
    reloadSchedule(scheduleReloadMatch[1]);
    writeJson(res, 200, { ok: true });
    return true;
  }

  const schedulePatchMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (schedulePatchMatch && req.method === 'PATCH') {
    const scheduleId = schedulePatchMatch[1];
    let body;
    try { body = await readBody(req, 4096); } catch { body = '{}'; }
    try {
      const updates = JSON.parse(body);
      const schedulesFile = join(__dirname, '..', 'workflows', 'schedules.json');
      const data = existsSync(schedulesFile)
        ? JSON.parse(readFileSync(schedulesFile, 'utf8'))
        : { schedules: [] };
      const schedule = data.schedules.find(s => s.id === scheduleId);
      if (!schedule) {
        writeJson(res, 404, { error: 'Schedule not found' });
        return true;
      }
      const ALLOWED = ['enabled', 'maxRuns', 'disposable', 'intervalMs'];
      for (const key of ALLOWED) {
        if (updates[key] !== undefined) schedule[key] = updates[key];
      }
      const tmp = schedulesFile + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, schedulesFile);
      if (updates.enabled !== undefined) {
        reloadSchedule(scheduleId);
      }
      writeJson(res, 200, { schedule });
    } catch (err) {
      writeJson(res, 400, { error: err.message || 'Invalid request body' });
    }
    return true;
  }

  if (schedulePatchMatch && req.method === 'DELETE') {
    const scheduleId = schedulePatchMatch[1];
    try {
      const schedulesFile = join(__dirname, '..', 'workflows', 'schedules.json');
      const data = existsSync(schedulesFile)
        ? JSON.parse(readFileSync(schedulesFile, 'utf8'))
        : { schedules: [] };
      const idx = data.schedules.findIndex(s => s.id === scheduleId);
      if (idx === -1) {
        writeJson(res, 404, { error: 'Schedule not found' });
        return true;
      }
      data.schedules.splice(idx, 1);
      const tmp = schedulesFile + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, schedulesFile);
      reloadSchedule(scheduleId);
      writeJson(res, 200, { ok: true });
    } catch (err) {
      writeJson(res, 500, { error: err.message });
    }
    return true;
  }

  // ---- Task API ----

  if (pathname === '/api/tasks' && req.method === 'GET') {
    const filters = {};
    if (parsedUrl.query?.status) filters.status = parsedUrl.query.status;
    if (parsedUrl.query?.assigned_session_id) filters.assigned_session_id = parsedUrl.query.assigned_session_id;
    writeJson(res, 200, { tasks: listTasks(filters) });
    return true;
  }

  if (pathname === '/api/tasks' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 16384)); } catch {
      writeJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    try {
      const task = createTask({
        subject: body.subject,
        description: body.description,
        assigned_session_id: body.assigned_session_id,
        blocked_by: body.blocked_by,
        report_to: body.report_to,
        repo_path: body.repo_path,
        worktree_path: body.worktree_path,
        branch: body.branch,
      });
      writeJson(res, 201, { task });
    } catch (err) {
      writeJson(res, 400, { error: err.message });
    }
    return true;
  }

  const taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskIdMatch && req.method === 'GET') {
    const task = getTask(taskIdMatch[1]);
    if (!task) {
      writeJson(res, 404, { error: 'Task not found' });
      return true;
    }
    writeJson(res, 200, { task });
    return true;
  }

  if (taskIdMatch && req.method === 'PATCH') {
    let body;
    try { body = JSON.parse(await readBody(req, 16384)); } catch {
      writeJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const task = updateTask(taskIdMatch[1], body);
    if (!task) {
      writeJson(res, 404, { error: 'Task not found' });
      return true;
    }
    writeJson(res, 200, { task });
    return true;
  }

  if (taskIdMatch && req.method === 'DELETE') {
    const deleted = deleteTask(taskIdMatch[1]);
    if (!deleted) {
      writeJson(res, 404, { error: 'Task not found' });
      return true;
    }
    writeJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
