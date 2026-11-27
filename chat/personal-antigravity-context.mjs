import { buildSessionNavigationHref } from '../lib/session-navigation.mjs';
import { runtimeHrPolicy } from '../lib/hr-policy.mjs';
import { findIdentity, getAuthReadSnapshot } from '../lib/auth-config.mjs';
import { personalWorkspace } from './feishu-personal-workspace.mjs';
import { loadReferenceContentFilter } from './request-access-guard.mjs';
import { canReferenceOwnSession } from './session-access.mjs';
import { rankIndexReferences, searchSessionLogs } from './session-log-search.mjs';
import { findSessionMeta, loadSessionsMeta } from './session-meta-store.mjs';

export const indexContextKinds = ['history', 'project-memory', 'work-summary'];

export async function createPersonalAntigravityContextLookup(record, signal) {
  const actor = { personId: record.options.viewPersonId, identityId: record.options.initiatedByIdentityId };
  const source = record.options.sourceContext;
  if (record.options.restrictedRecruiting
      || (source?.connector === 'feishu' && (record.options.feishuConnectorAuthenticated !== true
        || !['p2p', 'private'].includes(source.chatType)))) return null;
  const delivery = record.deliveryPlan || record.options.sourceDelivery;
  if (delivery && (delivery.connector !== 'feishu'
      || !['p2p', 'private'].includes(delivery.target?.chatType)
      || source?.chatId !== delivery.target.chatId
      || source?.sourceRouteId !== delivery.sourceRouteId)) return null;

  function canRead(session, document) {
    return !signal?.aborted
      && !runtimeHrPolicy()?.restrictedRuntime
      && findIdentity(document, actor.identityId)?.person.id === actor.personId
      && canReferenceOwnSession(actor, session, document);
  }

  const canReadDestination = async () => {
    const destination = await findSessionMeta(record.sessionId);
    return canRead(destination, getAuthReadSnapshot());
  };
  if (!await canReadDestination()) return null;

  return async (kind, query) => {
    if (!await canReadDestination()) return { references: [], incomplete: true };
    const allowContent = await loadReferenceContentFilter();
    const search = kind === 'history'
      ? searchSessionLogs(query, { authSession: actor, scope: 'personal-context', sessionId: record.sessionId,
        excludeRequestId: record.requestId, allowContent })
      : personalWorkspace.referenceSources(actor, kind);
    const result = await search;
    const sessions = await loadSessionsMeta();
    const document = getAuthReadSnapshot();
    if (!canRead(sessions.find(session => session.id === record.sessionId), document)) {
      return { references: [], incomplete: true };
    }

    const allowedSessions = new Set(sessions.filter(session => canReferenceOwnSession(actor, session, document))
      .map(session => session.id));
    const references = kind === 'history'
      ? result.sessions.filter(session => allowedSessions.has(session.id)).flatMap(session =>
        session.matches.map(match => ({
          kind, title: session.title, url: session.sessionUrl || buildSessionNavigationHref(session.id),
          excerpt: match.excerpt, timestamp: match.timestamp, role: match.role,
        }))).slice(0, 4)
      : rankIndexReferences(result.records.filter(source => allowedSessions.has(source.sourceSessionId)),
        query, { allowContent, limit: 4 }).map(({ title, url, excerpt }) => ({ kind, title, url, excerpt }));
    return { references, incomplete: Boolean(result.incomplete) };
  };
}
