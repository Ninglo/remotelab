import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

// Instance-local opt-ins keep the feature off for every other Person. The
// caller's identity and the Session's original initiator must both match.
export async function loadWorkboardOptIns(path = join(CONFIG_DIR, 'workboard-opt-ins.json')) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed?.people) ? parsed.people : [];
  } catch {
    return [];
  }
}

export function isWorkboardOptedIn(session, turn, people) {
  const personId = trim(turn?.viewPersonId);
  const identityId = trim(turn?.initiatedByIdentityId);
  if (!personId || !identityId || identityId !== trim(session?.initiatedByIdentityId)
      || session?.groupFeed === true) return false;
  const person = (Array.isArray(people) ? people : []).find(item => trim(item?.personId) === personId
    && Array.isArray(item?.identityIds) && item.identityIds.includes(identityId));
  if (!person) return false;
  const conversation = session?.conversation;
  if (!conversation) return trim(session?.sourceId) === 'chat';
  const target = conversation.target;
  return conversation.connector === 'feishu'
    && target?.chatType === 'p2p'
    && target?.conversationKind === 'main'
    && (Array.isArray(person.feishuPrivateChats) ? person.feishuPrivateChats : []).some(chat =>
      trim(chat?.sourceRouteId) === trim(conversation.sourceRouteId)
      && trim(chat?.chatId) === trim(target?.chatId));
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
  return sameInitiator && session?.groupFeed !== true && privateConversation
    && (manualSessionPilot || configured);
}
