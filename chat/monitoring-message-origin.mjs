// Read-only origin classification. Delivery placement is never input origin.
import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const recordKey = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 24);
export const sourceKey = (route, messageId) => JSON.stringify([route || 'default', messageId]);
const pick = (value, fields) => Object.fromEntries(fields.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
export function projectMessageSource(s = {}) {
  s ||= {};
  return { ...pick(s, ['connector', 'sourceRouteId', 'tenantKey', 'chatId', 'chatType', 'chatMode', 'groupMessageType',
    'conversationKind', 'messageId', 'threadId', 'rootId', 'topicId', 'startThread', 'createTime', 'sourceKind']),
    senderType: s.senderType || s.sender?.senderType };
}
export function classifyMessageOrigin(s, raw = false) {
  const basis = raw ? 'inbox' : 'request';
  if (!s || s.sourceKind) return { kind: 'unknown', basis };
  if (s.connector && s.connector !== 'feishu') return { kind: 'ordinary', basis };
  if (['p2p', 'private'].includes(s.chatType)) return { kind: 'ordinary', basis };
  if (!['group', 'topic'].includes(s.chatType)) return { kind: 'unknown', basis };
  if (!raw && s.startThread === true) return { kind: 'unknown', basis };
  if (s.chatType === 'topic' || s.chatMode === 'topic' || s.groupMessageType === 'topic'
      || s.threadId || s.topicId) return { kind: 'ordinary', basis };
  // A normal timeline reply/quote can carry rootId without a provider thread_id.
  // Only the actual topic metadata above establishes a threaded origin.
  if (raw || ['main', 'group'].includes(s.conversationKind)) return { kind: 'group-mainline', basis };
  return { kind: 'unknown', basis };
}
export function projectInbox(r) {
  const receipt = r.receipt || {}, submission = r.submission || {};
  return { id: r.id, source: projectMessageSource(r.summary), complete: r.complete === true,
    receivedAt: r.participationSnapshot?.receivedAt,
    mode: submission.payload?.sourceContext?.feishuParticipationMode || r.participationSnapshot?.mode || 'unknown',
    sessionId: receipt.workSessionId || submission.sessionId || receipt.sessionId,
    originSessionId: receipt.sessionId || submission.sessionId,
    workSessionId: receipt.workSessionId,
    requestId: submission.payload?.requestId || receipt.requestId,
    runId: receipt.runId,
    intake: receipt.failed ? 'failed' : receipt.observedOnly ? 'observed' : receipt.ignored ? 'skipped'
      : receipt.participationControl || Object.hasOwn(receipt, 'message_id') ? 'control'
      : receipt.requestId || receipt.runId ? 'accepted' : 'unknown',
    reason: receipt.reason,
  };
}
// Configs are projected before caching: credentials and prompt bodies never enter this cache.
export async function monitoringConnectorSources(configDir, read, storageOverrides = {}) {
  const configs = [join(configDir, 'feishu-connector', 'config.json')];
  for (const d of await readdir(join(configDir, 'feishu-connectors'), { withFileTypes: true }).catch(e => {
    if (e.code === 'ENOENT') return []; throw e;
  })) if (d.isDirectory()) configs.push(join(configDir, 'feishu-connectors', d.name, 'config.json'));
  const sources = [], stores = new Set();
  for (const path of configs) {
    const config = await read(path, c => ({ storageDir: c.storageDir, sourceRouteId: c.sourceRouteId || c.botId || 'default',
      defaultGroupParticipation: c.defaultGroupParticipation, responsePolicy: { group: c.responsePolicy?.group },
      groups: Object.fromEntries(Object.entries(c.groups || {}).map(([id, g]) => [id, pick(g,
        ['participationMode', 'participationControls', 'responseMode'])])) }));
    if (!config) continue;
    const configured = config.storageDir || dirname(path);
    const storageDir = await realpath(storageOverrides[configured] || configured).catch(() => storageOverrides[configured] || configured);
    if (stores.has(storageDir)) continue;
    stores.add(storageDir); sources.push({ ...config, storageDir });
  }
  return sources;
}
export function createMessageOriginLookup(sources, read) {
  const pending = new Map();
  return async source => {
    const route = source?.sourceRouteId || 'default', id = source?.messageId;
    if (!id || source?.connector !== 'feishu') return classifyMessageOrigin(source);
    const key = sourceKey(route, id);
    if (!pending.has(key)) pending.set(key, (async () => {
      const connector = sources.find(c => c.sourceRouteId === route);
      const file = recordKey(id) + '.json';
      const inbox = connector && (await read(join(connector.storageDir, 'inbox', 'active', file), projectInbox)
        || await read(join(connector.storageDir, 'inbox', 'archive', file), projectInbox));
      return inbox?.source?.messageId === id ? classifyMessageOrigin(inbox.source, true) : classifyMessageOrigin(source);
    })());
    return pending.get(key);
  };
}
