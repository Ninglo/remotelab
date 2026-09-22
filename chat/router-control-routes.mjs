import { buildScheduledSessionTemplate } from '../lib/scheduled-session.mjs';
import { scheduledRuntimePolicy, scheduledRuntimeIntent, patchScheduledRuntime } from '../lib/scheduled-runtime-policy.mjs';
import { findSessionConversation, requireConversation, updateSessionConversation } from './session-conversations.mjs';
import { readFile, readdir } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';

import { CHAT_IMAGES_DIR, CONFIG_DIR, FILE_ASSET_STORAGE_ENABLED, FILE_ASSET_STORAGE_PROVIDER } from '../lib/config.mjs';
import {
  addPersonCredential,
  createPerson,
  listPeopleForClient,
  moveIdentityToPerson,
  removePersonCredential,
  resolveOrCreateExternalIdentity,
  updatePerson,
} from '../lib/auth.mjs';
import { loadUiRuntimeSelection, saveUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { normalizeExternalRuntimeOverride } from '../lib/external-runtime-selection.mjs';
import {
  completeRuntimeProfile,
  normalizeRuntimeProfile,
  resolveRuntimeProfile,
  runtimeProfileFromUiSelection,
} from '../lib/runtime-profile.mjs';
import { getAvailableToolsAsync, saveSimpleToolAsync } from '../lib/tools.mjs';
import { readBody } from '../lib/utils.mjs';
import { getModelsForTool } from './models.mjs';
import { getPublicKey, addSubscription } from './push.mjs';
import { backfillBootstrapSessions } from './bootstrap-sessions.mjs';
import { createSessionDetail } from './session-api-shapes.mjs';
import { normalizeSessionEntryMode } from './session-entry-mode.mjs';
import { isQuickSession } from '../lib/quick-session-profile.mjs';
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
  cancelScheduleTriggers,
} from './triggers.mjs';
import {
  createRecurringSchedule,
  deleteRecurringSchedule,
  getRecurringSchedule,
  listRecurringSchedules,
  updateRecurringSchedule,
} from './recurring-schedules.mjs';
import {
  applyAutomationTaskAction,
  createAutomationTask,
  getAutomationTask,
  listAutomationTasks,
} from './automation-tasks.mjs';
import {
  buildSourceDeliveryPlan,
  claimSourceDelivery,
  claimSourceDeliveryWithWait,
  enqueueSourceDelivery,
  resolveSourceDelivery,
  completeSourceDelivery,
  failSourceDelivery,
  listSourceDeliveries,
  listSourceDeliveryActivity,
} from './source-deliveries.mjs';
import {
  buildAttachmentContentDisposition,
  buildFileAssetDirectUrl,
  createFileAssetUploadIntent,
  finalizeFileAssetUpload,
  getFileAsset,
  getFileAssetForClient,
  ingestFileAssetUpload,
  localizeFileAsset,
} from './file-assets.mjs';
import { createShareSnapshot } from './shares.mjs';
import { pathExists } from './fs-utils.mjs';
import {
  isScopedInstanceUserSurface,
  isUserVisiblePathAllowed,
  resolveUserVisiblePathInput,
} from './instance-visible-paths.mjs';
import { queryUsageLedger } from './usage-ledger.mjs';
import {
  buildClientInstanceSettings,
  loadInstanceSettings,
  updateInstanceSettings,
} from './instance-settings.mjs';
import { broadcastAll } from './ws-clients.mjs';
import {
  appendAssistantMessage,
  delegateSession,
  forkSession,
  getHistory,
  getSession,
  getSessionRunInitiatorIdentity,
  getSessionSourceContext,
  mergeSessionPersonViewOwnership,
  renameSession,
  setSessionArchived,
  setSessionPinned,
  updateSessionAgreements,
  updateSessionEntryMode,
  updateSessionGrouping,
  updateSessionLastReviewedAt,
  updateSessionRuntimePreferences,
  updateSessionSystemPrompt,
  updateSessionWorkflowClassification,
} from './session-manager.mjs';

const uploadedMediaMimeTypes = {
  csv: 'text/csv; charset=utf-8',
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
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function applyScheduledRuntimeProfile(payload, sourceSession, uiSelection) {
  const runtimePolicy = scheduledRuntimePolicy(payload);
  if (runtimePolicy === 'follow_default') return { ...payload, ...scheduledRuntimeIntent(payload) };
  const defaultProfile = runtimeProfileFromUiSelection(uiSelection);
  const inheritedProfile = defaultProfile.tool
    ? defaultProfile
    : normalizeRuntimeProfile(sourceSession);
  const requestedProfile = normalizeRuntimeProfile(payload);
  const selectedProfile = resolveRuntimeProfile(inheritedProfile, requestedProfile);
  const profile = completeRuntimeProfile(
    selectedProfile,
    await getModelsForTool(selectedProfile.tool),
  );
  return { ...payload, ...profile, runtimePolicy };
}

function resolveTaskCreatorIdentity(authSession, sourceSession) {
  const sourceIdentityId = trimString(sourceSession?.initiatedByIdentityId);
  if (authSession?.authKind === 'service') return sourceIdentityId;
  return trimString(authSession?.identityId) || sourceIdentityId;
}

async function resolveDerivedSessionCreatorIdentity(authSession, sourceSession, sourceRunId = '') {
  const sourceIdentityId = trimString(sourceSession?.initiatedByIdentityId);
  if (authSession?.authKind !== 'service') {
    return {
      identityId: trimString(authSession?.identityId) || sourceIdentityId,
      personId: trimString(authSession?.personId),
    };
  }
  const runIdentityId = await getSessionRunInitiatorIdentity(sourceSession?.id, sourceRunId);
  const identityId = runIdentityId || sourceIdentityId;
  const people = identityId ? await listPeopleForClient() : [];
  const person = people.find((entry) => entry.identities?.some((identity) => identity.id === identityId));
  return {
    identityId,
    personId: trimString(person?.id) || trimString(authSession?.personId),
  };
}

async function prepareScheduledTask(payload, { authSession = null } = {}) {
  const sourceSessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : String(payload.sourceSessionId || '').trim();
  const sourceSession = sourceSessionId ? await getSession(sourceSessionId) : null;
  if (!sourceSession) throw new Error('Source session not found');
  if (sourceSession.archived) throw new Error('Source session is archived');
  let input = await applyScheduledRuntimeProfile(payload, sourceSession, await loadUiRuntimeSelection());
  if (!Object.hasOwn(payload, 'conversation') && !Object.hasOwn(payload, 'sourceDelivery')
      && !Object.hasOwn(payload.sessionTemplate || {}, 'conversation')
      && String(payload.deliverTo || '').trim().toLowerCase() === 'session_source') {
    const sourcePlan = buildSourceDeliveryPlan(await getSessionSourceContext(sourceSessionId, {
      requestId: typeof payload.sourceRequestId === 'string' ? payload.sourceRequestId.trim() : '',
    }));
    const conversation = payload.sourceRequestId ? sourcePlan : sourceSession.conversation || sourcePlan;
    if (!conversation) throw new Error('Source Session has no external conversation');
    input = { ...input, conversation };
  }
  return {
    ...input,
    sourceSessionId,
    createdByIdentityId: resolveTaskCreatorIdentity(authSession, sourceSession),
    sessionTemplate: buildScheduledSessionTemplate(input, sourceSession),
  };
}

async function prepareScheduledRuntimePatch(current, payload) {
  const patch = patchScheduledRuntime(current, payload);
  if (!Object.keys(patch).length) return payload;
  const source = await getSession(current.sourceSessionId);
  const resolved = await applyScheduledRuntimeProfile(patch, source, await loadUiRuntimeSelection());
  return { ...payload, ...resolved };
}

async function prepareAutomationTask(payload = {}, authSession = null) {
  const kind = trimString(payload.kind).toLowerCase();
  if (!['one_time', 'recurring'].includes(kind)) {
    throw new Error('kind must be one_time or recurring');
  }
  const target = payload.target && typeof payload.target === 'object' ? payload.target : {};
  const targetMode = trimString(target.mode).toLowerCase();
  if (!['fixed_session', 'new_session'].includes(targetMode)) {
    throw new Error('target.mode must be fixed_session or new_session');
  }
  const sourceSessionId = trimString(target.sessionId || target.sourceSessionId);
  if (!sourceSessionId) throw new Error('A target Session is required');
  const sourceSession = await getSession(sourceSessionId);
  if (!sourceSession) throw new Error('Target Session not found');
  if (sourceSession.archived) throw new Error('Target Session is archived');

  const resultDelivery = payload.resultDelivery && typeof payload.resultDelivery === 'object'
    ? payload.resultDelivery
    : payload.notification && typeof payload.notification === 'object'
      ? payload.notification
    : { mode: 'remotelab' };
  const resultDeliveryMode = trimString(resultDelivery.mode).toLowerCase() || 'remotelab';
  if (!['remotelab', 'source_conversation'].includes(resultDeliveryMode)) {
    throw new Error('resultDelivery.mode must be remotelab or source_conversation');
  }

  const schedule = payload.schedule && typeof payload.schedule === 'object' ? payload.schedule : {};

  const title = trimString(payload.title);
  const input = {
    ...payload,
    kind,
    sessionId: sourceSessionId,
    sourceSessionId,
    text: trimString(payload.prompt || payload.text),
    ...(kind === 'recurring' ? {
      ...(schedule.type ? { cadence: schedule } : {}),
      ...(Object.hasOwn(schedule, 'cron') ? { cron: schedule.cron } : {}),
      ...(Object.hasOwn(schedule, 'timezone') ? { timezone: schedule.timezone } : {}),
      ...(Object.hasOwn(schedule, 'everySeconds') ? { everySeconds: schedule.everySeconds } : {}),
    } : {}),
    ...(targetMode === 'fixed_session' ? {
      sessionTemplate: {
        folder: sourceSession.folder,
        tool: trimString(payload.tool) || sourceSession.tool,
        name: title || sourceSession.name || 'Automated task',
        group: sourceSession.group || 'Automated tasks',
        description: `Fixed Session execution for ${title || 'automated task'}`,
        systemPrompt: sourceSession.systemPrompt,
        internalRole: sourceSession.internalRole || 'scheduled_execution',
        reuse: 'fixed_session',
        sessionId: sourceSession.id,
      },
    } : {}),
  };
  delete input.conversation;
  delete input.sourceDelivery;
  delete input.sourceRequestId;
  delete input.deliverTo;
  if (targetMode === 'new_session') delete input.sessionTemplate;
  if (resultDeliveryMode === 'source_conversation') input.deliverTo = 'session_source';
  const prepared = await prepareScheduledTask(input, { authSession });
  return { ...prepared, kind };
}

export async function handleControlRoutes({
  req,
  res,
  parsedUrl,
  pathname,
  authSession,
  triggerId,
  scheduleId,
  sourceDeliveryRoute,
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
  if (pathname === '/api/people' && req.method === 'GET') {
    writeJson(res, 200, { people: await listPeopleForClient() });
    return true;
  }

  if (pathname === '/api/people/reconcile-external-identity' && req.method === 'POST') {
    if (authSession?.authKind !== 'service') {
      writeJson(res, 403, { error: 'Service authentication required' });
      return true;
    }
    try {
      const payload = JSON.parse(await readBody(req, 32768) || '{}');
      const resolved = await resolveOrCreateExternalIdentity({
        kind: payload.kind,
        realm: payload.realm,
        subjectId: payload.subjectId,
        stableSubjectId: payload.stableSubjectId,
        displayName: payload.displayName,
        englishName: payload.englishName,
        handleHint: payload.handleHint,
        createIfMissing: false,
      });
      if (resolved?.sourcePersonId && resolved?.targetPersonId) {
        await mergeSessionPersonViewOwnership(resolved.sourcePersonId, resolved.targetPersonId);
      }
      if (resolved) broadcastAll({ type: 'people_updated' });
      writeJson(res, 200, { matched: Boolean(resolved), resolution: resolved });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to reconcile external identity' });
    }
    return true;
  }

  if (pathname === '/api/people' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req, 32768) || '{}');
      const created = await createPerson(payload);
      writeJson(res, 201, { ...created, people: await listPeopleForClient() });
      broadcastAll({ type: 'people_updated' });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to create person' });
    }
    return true;
  }

  const personMatch = /^\/api\/people\/([^/]+)$/.exec(pathname);
  if (personMatch && req.method === 'PATCH') {
    try {
      const payload = JSON.parse(await readBody(req, 32768) || '{}');
      const updated = await updatePerson(personMatch[1], payload);
      if (!updated) {
        writeJson(res, 404, { error: 'Person not found' });
        return true;
      }
      writeJson(res, 200, { people: await listPeopleForClient() });
      broadcastAll({ type: 'people_updated' });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to update person' });
    }
    return true;
  }

  const personCredentialCollectionMatch = /^\/api\/people\/([^/]+)\/credentials$/.exec(pathname);
  if (personCredentialCollectionMatch && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req, 32768) || '{}');
      const created = await addPersonCredential(personCredentialCollectionMatch[1], payload);
      if (!created) {
        writeJson(res, 404, { error: 'Person not found' });
        return true;
      }
      writeJson(res, 201, { ...created, people: await listPeopleForClient() });
      broadcastAll({ type: 'people_updated' });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to add credential' });
    }
    return true;
  }

  const personCredentialMatch = /^\/api\/people\/([^/]+)\/credentials\/([^/]+)$/.exec(pathname);
  if (personCredentialMatch && req.method === 'DELETE') {
    const removed = await removePersonCredential(personCredentialMatch[1], personCredentialMatch[2]);
    if (!removed) {
      writeJson(res, 404, { error: 'Credential not found' });
      return true;
    }
    writeJson(res, 200, { people: await listPeopleForClient() });
    broadcastAll({ type: 'people_updated' });
    return true;
  }

  const personIdentityMatch = /^\/api\/people\/([^/]+)\/identities$/.exec(pathname);
  if (personIdentityMatch && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req, 32768) || '{}');
      const identityId = trimString(payload.identityId);
      if (!identityId) {
        writeJson(res, 400, { error: 'identityId is required' });
        return true;
      }
      const moved = await moveIdentityToPerson(identityId, personIdentityMatch[1]);
      if (!moved) {
        writeJson(res, 404, { error: 'Person or identity not found' });
        return true;
      }
      await mergeSessionPersonViewOwnership(moved.sourcePersonId, moved.targetPersonId);
      writeJson(res, 200, { people: await listPeopleForClient() });
      broadcastAll({ type: 'people_updated' });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to move identity' });
    }
    return true;
  }

  if (pathname === '/api/bootstrap/sessions/restore' && req.method === 'POST') {
    try {
      const result = await backfillBootstrapSessions();
      writeJson(res, 200, {
        ok: true,
        created: result.created,
        updated: result.updated,
        welcomeSessionId: result.welcomeSession?.id || '',
        welcomeSession: result.welcomeSession ? createClientSessionDetail(result.welcomeSession) : null,
      });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to restore starter sessions' });
    }
    return true;
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    try {
      const settings = await loadInstanceSettings({
        includeSecrets: true,
      });
      writeJson(res, 200, {
        settings: buildClientInstanceSettings(settings, { authSession }),
      });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to load settings' });
    }
    return true;
  }

  if (pathname === '/api/settings' && req.method === 'PATCH') {
    let payload = {};
    try {
      const body = await readBody(req, 65536);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const patch = payload?.settings && typeof payload.settings === 'object'
        ? payload.settings
        : payload;
      const settings = await updateInstanceSettings(patch);
      writeJson(res, 200, {
        settings: buildClientInstanceSettings(settings, { authSession }),
      });
      broadcastAll({
        type: 'instance_settings_updated',
        updatedAt: settings?.updatedAt || '',
      });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to save settings' });
    }
    return true;
  }

  if (pathname === '/api/automation-tasks' && req.method === 'GET') {
    try {
      writeJson(res, 200, { tasks: await listAutomationTasks() });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to load automation tasks' });
    }
    return true;
  }

  if (pathname === '/api/automation-tasks' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 131072);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const task = await createAutomationTask(await prepareAutomationTask(payload, authSession));
      writeJson(res, 201, { task });
      broadcastAll({ type: 'automation_tasks_updated', taskId: task.id });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to create automation task' });
    }
    return true;
  }

  const automationTaskMatch = /^\/api\/automation-tasks\/((?:trg|sch)_[a-f0-9]{24})(?:\/(pause|resume|cancel))?$/.exec(pathname);
  if (automationTaskMatch && req.method === 'GET' && !automationTaskMatch[2]) {
    const task = await getAutomationTask(automationTaskMatch[1]);
    if (!task) writeJson(res, 404, { error: 'Automation task not found' });
    else writeJson(res, 200, { task });
    return true;
  }
  if (automationTaskMatch && req.method === 'PATCH' && !automationTaskMatch[2]) {
    try {
      const payload = JSON.parse(await readBody(req, 32768));
      const id = automationTaskMatch[1];
      const recurring = id.startsWith('sch_');
      const current = await (recurring ? getRecurringSchedule(id) : getTrigger(id));
      if (!current) { writeJson(res, 404, { error: 'Automation task not found' }); return true; }
      if (Object.keys(payload).some(key => !['runtimePolicy', 'tool', 'model', 'effort', 'thinking'].includes(key))) {
        throw new Error('Only runtime settings can be edited here');
      }
      const patch = await prepareScheduledRuntimePatch(current, payload);
      await (recurring ? updateRecurringSchedule(id, patch) : updateTrigger(id, patch));
      writeJson(res, 200, { task: await getAutomationTask(id) });
      broadcastAll({ type: 'automation_tasks_updated', taskId: id });
    } catch (error) { writeJson(res, 400, { error: error.message }); }
    return true;
  }
  if (automationTaskMatch && req.method === 'POST' && automationTaskMatch[2]) {
    try {
      const result = await applyAutomationTaskAction(automationTaskMatch[1], automationTaskMatch[2]);
      if (!result) {
        writeJson(res, 404, { error: 'Automation task not found' });
        return true;
      }
      writeJson(res, 200, result);
      broadcastAll({ type: 'automation_tasks_updated', taskId: result.task.id });
    } catch (error) {
      writeJson(res, 409, { error: error.message || 'Failed to update automation task' });
    }
    return true;
  }

  if (pathname === '/api/triggers' && req.method === 'GET') {
    const sessionId = typeof parsedUrl?.query?.sessionId === 'string'
      ? parsedUrl.query.sessionId
      : '';
    const scheduleIdFilter = typeof parsedUrl?.query?.scheduleId === 'string'
      ? parsedUrl.query.scheduleId
      : '';
    const triggers = await listTriggers({ sessionId, scheduleId: scheduleIdFilter });
    writeJson(res, 200, { triggers });
    return true;
  }

  if (pathname === '/api/session-conversations/resolve' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req, 32768));
      const session = await findSessionConversation(payload.conversation);
      writeJson(res, 200, { sessionId: session?.id || null, conversation: session?.conversation || null });
    } catch (error) { writeJson(res, 400, { error: error.message }); }
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
      const trigger = await createTrigger(await prepareScheduledTask(payload, { authSession }));
      writeJson(res, 201, { trigger });
      broadcastAll({ type: 'automation_tasks_updated', taskId: trigger.id });
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
      const current = await getTrigger(triggerId);
      const trigger = current ? await updateTrigger(triggerId, await prepareScheduledRuntimePatch(current, payload || {})) : null;
      if (!trigger) {
        writeJson(res, 404, { error: 'Trigger not found' });
        return true;
      }
      writeJson(res, 200, { trigger });
      broadcastAll({ type: 'automation_tasks_updated', taskId: trigger.id });
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
    broadcastAll({ type: 'automation_tasks_updated', taskId: trigger.id });
    return true;
  }

  if (pathname === '/api/schedules' && req.method === 'GET') {
    const sessionId = typeof parsedUrl?.query?.sessionId === 'string' ? parsedUrl.query.sessionId : '';
    writeJson(res, 200, { schedules: await listRecurringSchedules({ sessionId }) });
    return true;
  }

  if (pathname === '/api/schedules' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 131072);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const schedule = await createRecurringSchedule(await prepareScheduledTask(payload, { authSession }));
      writeJson(res, 201, { schedule });
      broadcastAll({ type: 'automation_tasks_updated', taskId: schedule.id });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to create schedule' });
    }
    return true;
  }

  if (scheduleId && req.method === 'GET') {
    const schedule = await getRecurringSchedule(scheduleId);
    if (!schedule) writeJson(res, 404, { error: 'Schedule not found' });
    else writeJson(res, 200, { schedule });
    return true;
  }

  if (scheduleId && req.method === 'PATCH') {
    let payload = {};
    try {
      const body = await readBody(req, 131072);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      if (Object.prototype.hasOwnProperty.call(payload, 'sessionId')) {
        throw new Error('The source session is immutable; create a new schedule instead');
      }
      const current = await getRecurringSchedule(scheduleId);
      const schedule = current ? await updateRecurringSchedule(scheduleId, await prepareScheduledRuntimePatch(current, payload)) : null;
      if (!schedule) {
        writeJson(res, 404, { error: 'Schedule not found' });
        return true;
      }
      let cancellation = null;
      if (payload.enabled === false || ['paused', 'cancelled'].includes(trimString(payload.status).toLowerCase())) {
        cancellation = await cancelScheduleTriggers(scheduleId, { includeActive: payload.includeActive === true });
      }
      writeJson(res, 200, { schedule, cancellation });
      broadcastAll({ type: 'automation_tasks_updated', taskId: schedule.id });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to update schedule' });
    }
    return true;
  }

  if (scheduleId && req.method === 'DELETE') {
    const schedule = await deleteRecurringSchedule(scheduleId);
    if (!schedule) {
      writeJson(res, 404, { error: 'Schedule not found' });
      return true;
    }
    const cancellation = await cancelScheduleTriggers(scheduleId, { includeActive: false });
    writeJson(res, 200, { ok: true, schedule, cancellation });
    broadcastAll({ type: 'automation_tasks_updated', taskId: schedule.id });
    return true;
  }

  if (pathname === '/api/source-deliveries' && req.method === 'POST') {
    try { writeJson(res, 202, { delivery: await enqueueSourceDelivery(JSON.parse(await readBody(req, 1024 * 1024))) }); }
    catch (error) { writeJson(res, 400, { error: error.message }); }
    return true;
  }

  if (pathname === '/api/source-deliveries' && req.method === 'GET') {
    const filters = {
      connector: typeof parsedUrl?.query?.connector === 'string' ? parsedUrl.query.connector : '',
      sourceRouteId: typeof parsedUrl?.query?.sourceRouteId === 'string' ? parsedUrl.query.sourceRouteId : '',
      state: typeof parsedUrl?.query?.state === 'string' ? parsedUrl.query.state : '',
      sessionId: typeof parsedUrl?.query?.sessionId === 'string' ? parsedUrl.query.sessionId : '',
    };
    writeJson(res, 200, {
      deliveries: await listSourceDeliveries(filters),
      ...(parsedUrl?.query?.includeActivity === 'true' ? { activity: await listSourceDeliveryActivity(filters) } : {}),
    });
    return true;
  }

  if (pathname === '/api/source-deliveries/claim' && req.method === 'POST') {
    let payload = {};
    const abortController = new AbortController();
    const abortWait = () => abortController.abort();
    res.once('close', abortWait);
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
      const claim = payload.waitMs
        ? await claimSourceDeliveryWithWait({ ...payload, signal: abortController.signal })
        : await claimSourceDelivery(payload);
      res.off('close', abortWait);
      if (abortController.signal.aborted || res.destroyed) return true;
      writeJson(res, 200, { claim });
    } catch (error) {
      res.off('close', abortWait);
      if (abortController.signal.aborted || res.destroyed) return true;
      writeJson(res, 400, { error: error.message || 'Failed to claim source delivery' });
    }
    return true;
  }

  if (sourceDeliveryRoute && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
      const delivery = sourceDeliveryRoute.action === 'resolve' ? await resolveSourceDelivery(sourceDeliveryRoute.deliveryId, payload) : sourceDeliveryRoute.action === 'complete'
        ? await completeSourceDelivery(sourceDeliveryRoute.deliveryId, payload.leaseId, payload)
        : await failSourceDelivery(sourceDeliveryRoute.deliveryId, payload.leaseId, payload.error || 'Delivery failed', payload);
      if (!delivery) writeJson(res, 404, { error: 'Source delivery not found' });
      else writeJson(res, 200, { delivery });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to update source delivery' });
    }
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
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;

    try {
      const intent = await createFileAssetUploadIntent({
        sessionId,
        originalName: typeof payload?.originalName === 'string' ? payload.originalName : '',
        mimeType: typeof payload?.mimeType === 'string' ? payload.mimeType : '',
        sizeBytes: payload?.sizeBytes,
        createdBy: authSession?.personId || 'authenticated',
        forceLocal: !FILE_ASSET_STORAGE_ENABLED,
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
    if (!await requireSessionAccess(res, authSession, asset.sessionId)) return true;
    const clientAsset = await getFileAssetForClient(asset.id, {
      includeDirectUrl: asset.status === 'ready',
    });
    writeJson(res, 200, { asset: clientAsset });
    return true;
  }

  if (fileAssetRoute?.action === 'upload' && (req.method === 'PUT' || req.method === 'POST')) {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, asset.sessionId)) return true;

    try {
      await ingestFileAssetUpload(asset.id, req);
      res.writeHead(200, buildHeaders({
        ETag: `"${asset.id}"`,
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end();
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to upload asset body' });
    }
    return true;
  }

  if (fileAssetRoute?.action === 'finalize' && req.method === 'POST') {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, asset.sessionId)) return true;

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
    if (!await requireSessionAccess(res, authSession, asset.sessionId)) return true;
    const downloadRequested = String(parsedUrl?.query?.download || '') === '1';

    try {
      if (asset.storage?.provider === 'local') {
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

  if (pathname === '/api/usage/summary' && req.method === 'GET') {
    const identityKind = typeof parsedUrl?.query?.identityKind === 'string'
      ? parsedUrl.query.identityKind.trim()
      : '';
    const identityId = typeof parsedUrl?.query?.identityId === 'string'
      ? parsedUrl.query.identityId.trim()
      : '';
    const sessionId = typeof parsedUrl?.query?.sessionId === 'string'
      ? parsedUrl.query.sessionId.trim()
      : '';
    const tool = typeof parsedUrl?.query?.tool === 'string'
      ? parsedUrl.query.tool.trim()
      : '';
    const model = typeof parsedUrl?.query?.model === 'string'
      ? parsedUrl.query.model.trim()
      : '';
    const summary = await queryUsageLedger({
      days: parsePositiveInteger(parsedUrl?.query?.days, 7),
      top: parsePositiveInteger(parsedUrl?.query?.top, 10),
      identityKind,
      identityId,
      sessionId,
      tool,
      model,
    });
    writeJsonCached(req, res, summary);
    return true;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'PATCH') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'sessions' || !sessionId) {
      writeJson(res, 400, { error: 'Invalid session path' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
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
    const hasConversationPatch = Object.hasOwn(patch || {}, 'conversation');
    if (hasConversationPatch) {
      try { requireConversation(patch.conversation); }
      catch (error) { writeJson(res, 400, { error: error.message }); return true; }
    }
    const hasArchivedPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'archived');
    const hasPinnedPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'pinned');
    const hasToolPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'tool');
    const hasModelPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'model');
    const hasEffortPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'effort');
    const hasThinkingPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'thinking');
    const hasFeishuRuntimePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'feishuRuntimeSelection');
    if (hasFeishuRuntimePatch) {
      try { patch.feishuRuntimeSelection = normalizeExternalRuntimeOverride(patch.feishuRuntimeSelection); }
      catch (error) { writeJson(res, 400, { error: error.message }); return true; }
    }
    const hasSpacePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'space');
    const hasGroupPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'group');
    const hasDescriptionPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'description');
    const hasSystemPromptPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'systemPrompt');
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
    if (hasSpacePatch && patch.space !== null && typeof patch.space !== 'string') {
      writeJson(res, 400, { error: 'space must be a string or null' });
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
    if (hasSystemPromptPatch && patch.systemPrompt !== null && typeof patch.systemPrompt !== 'string') {
      writeJson(res, 400, { error: 'systemPrompt must be a string or null' });
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
    if (hasToolPatch || hasModelPatch || hasEffortPatch || hasThinkingPatch || hasFeishuRuntimePatch) {
      const targetSession = await getSession(sessionId);
      if (isQuickSession(targetSession)) {
        writeJson(res, 409, {
          error: 'Quick Session 的 Harness、模型和 Effort 在创建时固定；请新建 Standard Session。',
          code: 'QUICK_SESSION_RUNTIME_IMMUTABLE',
        });
        return true;
      }
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
    if (hasConversationPatch) {
      try { session = await updateSessionConversation(sessionId, patch.conversation); }
      catch (error) { writeJson(res, 400, { error: error.message }); return true; }
    }
    if (typeof patch.name === 'string' && patch.name.trim()) {
      session = await renameSession(sessionId, patch.name.trim(), {
        viewPersonId: authSession?.personId || '',
      });
    }
    if (hasArchivedPatch) {
      session = await setSessionArchived(sessionId, patch.archived) || session;
    }
    if (hasPinnedPatch) {
      session = await setSessionPinned(sessionId, patch.pinned) || session;
    }
    if (hasSpacePatch || hasGroupPatch || hasDescriptionPatch || hasSidebarOrderPatch) {
      session = await updateSessionGrouping(sessionId, {
        ...(hasSpacePatch ? { space: patch.space ?? '' } : {}),
        ...(hasGroupPatch ? { group: patch.group ?? '' } : {}),
        ...(hasDescriptionPatch ? { description: patch.description ?? '' } : {}),
        ...(hasSidebarOrderPatch ? { sidebarOrder: patch.sidebarOrder ?? null } : {}),
      }, { personId: authSession?.personId || '' }) || session;
    }
    if (hasActiveAgreementsPatch) {
      session = await updateSessionAgreements(sessionId, {
        activeAgreements: patch.activeAgreements ?? [],
      }) || session;
    }
    if (hasSystemPromptPatch) {
      session = await updateSessionSystemPrompt(sessionId, patch.systemPrompt || '') || session;
    }
    if (hasWorkflowStatePatch || hasWorkflowPriorityPatch) {
      session = await updateSessionWorkflowClassification(sessionId, {
        ...(hasWorkflowStatePatch ? { workflowState: patch.workflowState || '' } : {}),
        ...(hasWorkflowPriorityPatch ? { workflowPriority: patch.workflowPriority || '' } : {}),
      }) || session;
    }
    if (hasToolPatch || hasModelPatch || hasEffortPatch || hasThinkingPatch || hasFeishuRuntimePatch) {
      session = await updateSessionRuntimePreferences(sessionId, {
        ...(hasFeishuRuntimePatch ? { feishuRuntimeSelection: patch.feishuRuntimeSelection } : {}),
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
      session = await getSessionForClient(sessionId, { viewPersonId: authSession?.personId || '' });
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
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      writeJson(res, 410, { error: 'Voice transcript cleanup has been removed. Send messages directly.' });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'compact' && req.method === 'POST') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      writeJson(res, 410, { error: 'RemoteLab context compaction has been retired; the selected Harness owns context compaction.' });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'drop-tools' && req.method === 'POST') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      writeJson(res, 410, { error: 'RemoteLab tool-result dropping has been retired; the selected Harness owns its active context.' });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'fork') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      let payload = {};
      try {
        const body = await readBody(req, 10240);
        payload = body ? JSON.parse(body) : {};
      } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      const source = await getSessionForClient(sessionId, { viewPersonId: authSession?.personId || '' });
      if (!source) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      const forkOptions = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const initiator = await resolveDerivedSessionCreatorIdentity(authSession, source);
      const session = await forkSession(sessionId, {
        ...forkOptions,
        initiatedByIdentityId: initiator.identityId,
        viewPersonId: initiator.personId,
      });
      if (!session) {
        writeJson(res, 409, { error: 'Unable to fork session' });
        return true;
      }
      writeJson(res, 201, { session: createClientSessionDetail(session) });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'delegate') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      const source = await getSessionForClient(sessionId, { viewPersonId: authSession?.personId || '' });
      if (!source) {
        writeJson(res, 404, { error: 'Session not found' });
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
      if (Object.prototype.hasOwnProperty.call(payload, 'sourceRunId') && typeof payload.sourceRunId !== 'string') {
        writeJson(res, 400, { error: 'sourceRunId must be a string when provided' });
        return true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'context') && typeof payload.context !== 'string') {
        writeJson(res, 400, { error: 'context must be a string when provided' });
        return true;
      }

      try {
        const sourceRunId = typeof payload?.sourceRunId === 'string' ? payload.sourceRunId.trim() : '';
        const initiator = await resolveDerivedSessionCreatorIdentity(authSession, source, sourceRunId);
        const outcome = await delegateSession(sessionId, {
          task,
          context: typeof payload?.context === 'string' ? payload.context.trim() : '',
          sourceRunId,
          name: typeof payload?.name === 'string' ? payload.name.trim() : '',
          tool: typeof payload?.tool === 'string' ? payload.tool.trim() : '',
          internal: payload?.internal === true,
          initiatedByIdentityId: initiator.identityId,
          viewPersonId: initiator.personId,
        });
        if (!outcome?.session) {
          writeJson(res, 409, { error: 'Unable to delegate session' });
          return true;
        }
        writeJson(res, 201, {
          session: createClientSessionDetail(outcome.session),
          run: outcome.run || null,
          sessionUrl: outcome.sessionUrl,
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

    const session = await getSessionForClient(id, { viewPersonId: authSession?.personId || '' });
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
    const refresh = ['1', 'true'].includes(String(parsedUrl.query?.refresh || '').toLowerCase());
    const result = await getModelsForTool(toolId, { refresh });
    writeJsonCached(req, res, result);
    return true;
  }

  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = await getAvailableToolsAsync();
    writeJsonCached(req, res, { tools });
    return true;
  }

  if (pathname === '/api/tools' && req.method === 'POST') {
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
      const scopedUserSurface = isScopedInstanceUserSurface();
      const resolvedQuery = resolveUserVisiblePathInput(query);
      const parentDir = dirname(resolvedQuery);
      const prefix = basename(resolvedQuery);
      if (
        (!scopedUserSurface || isUserVisiblePathAllowed(parentDir))
        && await isDirectoryPath(parentDir)
      ) {
        for (const entry of await readdir(parentDir)) {
          if (!prefix.startsWith('.') && entry.startsWith('.')) continue;
          const fullPath = join(parentDir, entry);
          if (scopedUserSurface && !isUserVisiblePathAllowed(fullPath)) continue;
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
      const scopedUserSurface = isScopedInstanceUserSurface();
      const resolvedPath = resolveUserVisiblePathInput(pathQuery);
      if (scopedUserSurface && !isUserVisiblePathAllowed(resolvedPath)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path is outside this instance workspace' }));
        return true;
      }
      const children = [];
      let parent = null;
      if (await isDirectoryPath(resolvedPath)) {
        const parentPath = dirname(resolvedPath);
        parent = parentPath !== resolvedPath && (!scopedUserSurface || isUserVisiblePathAllowed(parentPath))
          ? parentPath
          : null;
        for (const entry of await readdir(resolvedPath)) {
          if (entry.startsWith('.')) continue;
          const fullPath = join(resolvedPath, entry);
          try {
            if (scopedUserSurface && !isUserVisiblePathAllowed(fullPath)) continue;
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

  // POST /api/notifications — broadcast a system notification to connected clients
  if (pathname === '/api/notifications' && req.method === 'POST') {
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
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const level = ['info', 'warn', 'error'].includes(payload.level) ? payload.level : 'info';
    if (!message) {
      writeJson(res, 400, { error: 'Missing message' });
      return true;
    }
    broadcastAll({ type: 'system_notification', message, level });
    writeJson(res, 200, { ok: true });
    return true;
  }

  // GET /api/mailbox/status — recent mailbox failures & stats
  if (pathname === '/api/mailbox/status' && req.method === 'GET') {
    try {
      const mailboxRoot = join(CONFIG_DIR, 'agent-mailbox');
      const approvedDir = join(mailboxRoot, 'approved');
      let files = [];
      try { files = await readdir(approvedDir); } catch {}
      const failures = [];
      for (const file of files.slice(-50)) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(approvedDir, file), 'utf8');
          const item = JSON.parse(raw);
          const status = typeof item?.status === 'string' ? item.status : '';
          if (status.includes('failed')) {
            failures.push({
              id: item.id,
              status,
              subject: item?.message?.subject || '',
              from: item?.message?.fromAddress || '',
              lastError: typeof item?.automation?.lastError === 'string'
                ? item.automation.lastError.slice(0, 500)
                : '',
              updatedAt: item?.automation?.updatedAt || item?.createdAt || '',
            });
          }
        } catch {}
      }
      writeJson(res, 200, { ok: true, failures, total: files.length });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to read mailbox status' });
    }
    return true;
  }

  return false;
}
