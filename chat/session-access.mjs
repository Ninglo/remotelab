import { findIdentity, getCachedAuthDocument, SYSTEM_IDENTITY_ID } from '../lib/auth-config.mjs';
import { findSessionMeta } from './session-meta-store.mjs';

// The service credential is an execution/connector capability, never a human role.
export function isSessionAdministrator(actor, document = getCachedAuthDocument()) {
  return Boolean(actor && (actor.authKind === 'service'
    || document?.administratorPersonIds?.includes(actor.personId)));
}

export function sessionCreatorIdentity(session) {
  if (!session) return '';
  // Explicit unknown/system ownership must never fall through to attribution.
  if (Object.hasOwn(session, 'creatorIdentityId')) return session.creatorIdentityId;
  if (session.groupFeed) return '';
  return session.initiatedByIdentityId || '';
}

export function canReadSession(actor, session, document = getCachedAuthDocument()) {
  if (!actor || !session) return false;
  if (isSessionAdministrator(actor, document)) return true;
  const identityId = sessionCreatorIdentity(session);
  return Boolean(identityId && identityId !== SYSTEM_IDENTITY_ID && actor.personId
    && findIdentity(document, identityId)?.person.id === actor.personId);
}

export function sessionAccessFilter(actor, document = getCachedAuthDocument()) {
  return session => canReadSession(actor, session, document);
}

export async function canAccessSession(actor, id) {
  if (!actor || !id) return false;
  return isSessionAdministrator(actor) || canReadSession(actor, await findSessionMeta(id));
}

export function canReadAutomation(actor, task, document = getCachedAuthDocument()) {
  return canReadSession(actor, task && { creatorIdentityId: task.createdByIdentityId || '' }, document);
}

// Global operational surfaces may contain transcripts, cross-Session links or
// credentials. Ordinary browsers enter only scoped routes; new APIs opt in here
// after enforcing the same policy. This also closes credential/identity takeover.
export function memberRouteAllowed(method, path, personId) {
  if (/^\/api\/sessions(?:\/|$)/.test(path) || /^\/api\/(?:runs|assets|images|media)(?:\/|$)/.test(path)) return true;
  if (/^\/api\/(?:automation-tasks|triggers|schedules)(?:\/|$)/.test(path)) return true;
  if (/^\/api\/people\/[^/]+(?:\/credentials(?:\/[^/]+)?)?$/.test(path)) return path.split('/')[3] === personId;
  if (path === '/api/monitoring/organization-work') return method === 'GET';
  if (path === '/api/people') return method === 'GET';
  if (['/api/settings', '/api/auto-routing', '/api/tools'].includes(path)) return method === 'GET';
  if (['/api/auth/me', '/api/models', '/api/runtime-presets', '/api/push/vapid-public-key', '/api/push/subscribe',
    '/api/message-reply-settings', '/api/personal-memory-settings', '/api/voice-review/settings', '/api/voice-review',
    '/api/voice-shortcut/recording-diagnostic', '/api/feishu-web-topics/grant', '/api/feishu-web-workspace/grant',
    '/api/feishu-web-settings/grant', '/api/feishu-web-settings/native-grant'].includes(path)) return true;
  if (['/api/usage/events', '/api/usage/settings'].includes(path)) return method === 'POST';
  return ['/', '/upload-fallback'].includes(path) || path.startsWith('/static/') || path.startsWith('/page/feishu-');
}
