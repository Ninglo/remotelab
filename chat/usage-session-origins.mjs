import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readRecord } from '../lib/durable-records.mjs';

// Origin is an immutable Request fact, not the first message left inside a
// filtered analytics window. Read only metadata; never copy dialogue to usage.
export function usageOriginFromRequest(request, hash) {
  const options = request?.options || {}, source = options.sourceContext || {};
  const timestamp = Date.parse(request?.acceptedAt);
  if (!Number.isFinite(timestamp) || options.internalOperation || options.deliveryOnly
      || options.recordUserMessage === false || options.automationTitle || options.scheduleId || options.triggerId
      || (options.usageActorKind && options.usageActorKind !== 'human')) return null;
  const person = options.usagePersonId || options.viewPersonId;
  if (!person || person === 'person_system' || !options.initiatedByIdentityId) return null;
  let surface;
  if (source.connector === 'feishu' && !['app', 'bot'].includes(source.sender?.senderType)
      && options.feishuConnectorAuthenticated !== false) surface = 'feishu';
  else if (options.usageActorKind === 'human' && options.usageSurface === 'web') surface = 'web';
  else return null;
  const target = source.target || source, chat = target.chatId || source.chatId;
  const conversationKey = surface === 'feishu' && chat ? hash(JSON.stringify([source.sourceRouteId || 'default', chat,
    target.rootId || source.rootId || target.topicId || source.topicId || target.threadId || source.threadId || 'main'])) : '';
  return { sessionId: request.sessionId, surface, timestamp, conversationKey };
}

export async function readUsageSessionOrigins(sessionIds, { requestsDirectory, hash, maxSessions = 2000 }) {
  const ids = [...new Set(sessionIds)].filter(id => typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(id));
  const origins = [], errors = [], limited = ids.slice(0, maxSessions);
  for (let offset = 0; offset < limited.length; offset += 16) {
    await Promise.all(limited.slice(offset, offset + 16).map(async sessionId => {
      try {
        const address = createHash('sha256').update(JSON.stringify([sessionId, 'first'])).digest('hex').slice(0, 24);
        const index = await readRecord(join(requestsDirectory, 'lookup', 'first-user-request', address + '.json'));
        if (!/^[a-f0-9]{24}$/.test(index?.key || '')) return;
        const request = await readRecord(join(requestsDirectory, 'active', index.key + '.json'))
          || await readRecord(join(requestsDirectory, 'archive', index.key + '.json'));
        if (request?.schema !== 1 || request.sessionId !== sessionId || request.key !== index.key) return;
        const origin = usageOriginFromRequest(request, hash);
        if (origin) origins.push(origin);
      } catch { errors.push(sessionId); }
    }));
  }
  return { origins, truncated: ids.length > limited.length, errors: errors.length };
}
