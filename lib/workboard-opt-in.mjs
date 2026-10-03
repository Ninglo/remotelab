import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { loadAuthDocument, SYSTEM_PERSON_ID } from './auth-config.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

// Default activation is instance-local. Resolve current registered identities on
// every admission, including people first discovered after the rollout. Explicit
// opt-ins retain their original exact-chat contract when the default is off.
export function resolveWorkboardPeople(policy, registeredPeople = []) {
  const explicit = Array.isArray(policy?.people) ? policy.people : [];
  if (policy?.defaultEnabled !== true) return explicit.filter(person => person?.enabled !== false);
  const excluded = new Set(policy.excludedPersonIds || []);
  return registeredPeople.filter(person => person?.id && person.id !== SYSTEM_PERSON_ID
    && !excluded.has(person.id) && explicit.find(entry => entry.personId === person.id)?.enabled !== false)
    .map(person => ({ personId: person.id, instanceDefault: true,
      identityIds: (person.identities || []).map(identity => identity.id),
      identities: (person.identities || []).map(({ id, kind, realm, subjectId }) => ({ id, kind, realm, subjectId })) }));
}

export async function loadWorkboardOptIns(path = join(CONFIG_DIR, 'workboard-opt-ins.json'), readPeople = async () =>
  (await loadAuthDocument({ persistMigration: false })).people) {
  try {
    const policy = JSON.parse(await readFile(path, 'utf8'));
    return resolveWorkboardPeople(policy, policy?.defaultEnabled === true ? await readPeople() : []);
  } catch {
    return [];
  }
}

function matchesFeishuSource(session, turn) {
  const { conversation } = session;
  const target = conversation.target;
  const source = turn?.sourceContext;
  const delivery = turn?.sourceDelivery;
  return turn?.feishuConnectorAuthenticated === true
    && trim(source?.connector) === 'feishu'
    && trim(source?.chatType) === trim(target?.chatType)
    && Boolean(trim(target?.chatId))
    && trim(source?.chatId) === trim(target.chatId)
    && Boolean(trim(conversation.sourceRouteId))
    && trim(source?.sourceRouteId) === trim(conversation.sourceRouteId)
    && (!trim(target?.tenantKey) || trim(source?.tenantKey) === trim(target.tenantKey))
    && Boolean(trim(source?.messageId))
    && trim(delivery?.connector) === 'feishu'
    && trim(delivery?.sourceRouteId) === trim(conversation.sourceRouteId)
    && trim(delivery?.target?.chatId) === trim(target.chatId);
}

export function isWorkboardOptedIn(session, turn, people) {
  const personId = trim(turn?.viewPersonId);
  const identityId = trim(turn?.initiatedByIdentityId);
  if (!personId || !identityId || session?.groupFeed === true) return false;
  const person = (Array.isArray(people) ? people : []).find(item => trim(item?.personId) === personId
    && Array.isArray(item?.identityIds) && item.identityIds.includes(identityId));
  if (!person) return false;
  const conversation = session?.conversation;
  if (!conversation) return trim(session?.sourceId) === 'chat'
    && (person.instanceDefault === true
      ? person.identities.some(identity => identity.id === identityId && identity.kind === 'web')
      : identityId === trim(session?.initiatedByIdentityId));
  const target = conversation.target;
  if (conversation.connector !== 'feishu') return false;
  if (person.instanceDefault === true) {
    const identity = person.identities.find(identity => identity.id === identityId);
    return ['p2p', 'group'].includes(target?.chatType)
      && (target.chatType === 'p2p' ? target.conversationKind === 'main' : ['main', 'thread'].includes(target.conversationKind))
      && matchesFeishuSource(session, turn)
      && identity?.kind === 'feishu'
      && identity.realm === conversation.sourceRouteId
      && identity.subjectId === trim(turn.sourceContext?.sender?.openId);
  }
  if (target?.chatType === 'p2p') return identityId === trim(session?.initiatedByIdentityId)
    && target?.conversationKind === 'main'
    && (Array.isArray(person.feishuPrivateChats) ? person.feishuPrivateChats : []).some(chat =>
      trim(chat?.sourceRouteId) === trim(conversation.sourceRouteId)
      && trim(chat?.chatId) === trim(target?.chatId));
  return target?.chatType === 'group' && ['main', 'thread'].includes(target?.conversationKind)
    && matchesFeishuSource(session, turn)
    && (Array.isArray(person.feishuGroupSenders) ? person.feishuGroupSenders : []).some(sender =>
      trim(sender?.sourceRouteId) === trim(conversation.sourceRouteId)
      && trim(sender?.openId) === trim(turn.sourceContext?.sender?.openId));
}

export function isWorkboardTurnEnabled(session, turn, people) {
  const sameInitiator = Boolean(turn?.initiatedByIdentityId)
    && session?.initiatedByIdentityId === turn.initiatedByIdentityId;
  const conversation = session?.conversation;
  const privateConversation = !conversation || (conversation.connector === 'feishu'
    && conversation.target?.chatType === 'p2p'
    && conversation.target?.conversationKind === 'main');
  const configured = isWorkboardOptedIn(session, turn, people);
  const manualSessionPilot = session?.workboardPilot === true && !session?.workboardOptInPersonId;
  return session?.groupFeed !== true
    && (configured || (sameInitiator && privateConversation && manualSessionPilot));
}

// A durable admission receipt binds publication to this actual inbound turn,
// rather than whichever Person last touched shared Session metadata.
export function workboardAdmission(options) {
  const source = options?.sourceContext;
  if (options?.workboardEnabled !== true || options?.feishuConnectorAuthenticated !== true
      || source?.connector !== 'feishu') return null;
  return { personId: options.viewPersonId, identityId: options.initiatedByIdentityId,
    sourceRouteId: source.sourceRouteId, senderOpenId: source.sender?.openId };
}
