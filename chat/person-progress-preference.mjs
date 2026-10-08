import { findIdentity, loadAuthDocument, SYSTEM_PERSON_ID } from '../lib/auth-config.mjs';
import { resolveSourcePerson } from './related-person-context.mjs';

// Service-authenticated connector events may identify their operator through the
// existing route-scoped mapping. A human HTTP caller can only act as themselves.
export async function resolveProgressActor(authSession, sourceContext, conversation) {
  const document = await loadAuthDocument({ persistMigration: false });
  let actor;
  if (authSession?.authKind === 'service') {
    const target = conversation?.target;
    if (sourceContext?.connector !== 'feishu' || conversation?.connector !== 'feishu'
        || sourceContext.sourceRouteId !== conversation.sourceRouteId
        || sourceContext.chatId !== target?.chatId
        || (target.tenantKey && sourceContext.tenantKey !== target.tenantKey)) return null;
    actor = resolveSourcePerson(sourceContext.sender, sourceContext, document);
  } else {
    actor = findIdentity(document, authSession?.identityId);
    if (actor?.person.id !== authSession?.personId) return null;
  }
  return actor?.person.id && actor.person.id !== SYSTEM_PERSON_ID ? actor : null;
}

export async function progressDefaultForTurn(options, conversation) {
  const actor = await resolveProgressActor(options.feishuConnectorAuthenticated === true
    ? { authKind: 'service' }
    : { personId: options.viewPersonId, identityId: options.initiatedByIdentityId },
  options.sourceContext, conversation);
  // The request identity was established at HTTP admission. Require both paths
  // to agree; no Session initiator, display-name or primary-account fallback.
  if (!actor || actor.person.id !== options.viewPersonId
      || actor.identity.id !== options.initiatedByIdentityId) return null;
  const mode = actor.person.preferences?.feishuProgressMode;
  return ['messages', 'card'].includes(mode)
    ? { mode, personId: actor.person.id, identityId: actor.identity.id } : null;
}
