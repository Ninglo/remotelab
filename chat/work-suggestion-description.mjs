import { requests } from './requests.mjs';
import { findIdentity, getCachedAuthDocument, loadAuthDocument } from '../lib/auth-config.mjs';

const text = (value, limit = 600) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const data = session => session?.workAwareness || {};

function messageTime(value) {
  if (!value) return '';
  const number = Number(value);
  const stamp = Number.isFinite(number) ? (number < 10_000_000_000 ? number * 1000 : number) : Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : '';
}

function location(context, web = false) {
  if (context?.connector === 'feishu') {
    const kind = context.chatType === 'group' || ['group', 'thread'].includes(context.conversationKind) ? '群聊'
      : context.chatType === 'p2p' || context.conversationKind === 'direct' ? '私聊' : '对话';
    return ['飞书' + kind, text(context.chatName, 120), context.threadId ? '话题' : ''].filter(Boolean).join(' · ');
  }
  return context?.connector ? text(context.connector, 60) + '消息' : web ? 'Web 对话' : 'RemoteLab 对话（入口未核实）';
}

export function workSessionLocation(session) {
  const binding = session?.conversation;
  const target = binding?.target || binding;
  const observed = session?.sourceContext;
  const matches = (!binding?.connector || observed?.connector === binding.connector)
    && (!target?.chatId || observed?.chatId === target.chatId);
  return location({ ...(matches ? observed : {}), ...binding, ...target });
}

async function createSourceReader(sessions, readRequest) {
  const cache = new Map();
  const auth = getCachedAuthDocument() || await loadAuthDocument({ persistMigration: false }).catch(() => null);
  return async (sessionId, requestId) => {
    const session = sessions.find(entry => entry.id === sessionId);
    const key = JSON.stringify([sessionId, requestId]);
    if (!cache.has(key)) cache.set(key, requestId ? readRequest(sessionId, requestId).catch(() => null) : Promise.resolve(null));
    const record = await cache.get(key);
    const identity = findIdentity(auth, record?.options?.initiatedByIdentityId);
    const source = record?.options?.sourceContext;
    return { sessionId, sessionName: text(session?.name, 120) || '未命名对话', requestId: requestId || '',
      location: location(source, identity?.identity?.kind === 'web'),
      actorName: text(identity?.person?.name, 120), messageTime: messageTime(source?.createTime),
      receivedAt: record?.acceptedAt || '', verified: Boolean(record),
      excerpt: text(record?.text?.replace(/^\[群参与状态：[\s\S]*?\]\s*/, '').replace(/^【飞书群消息[^】]*】\s*/, '')) };
  };
}

export async function describeRelatedWorkSource(work, sessions, readRequest = requests.byRequest) {
  const describe = await createSourceReader(sessions, readRequest);
  const sourceInfo = await describe(work.sessionId, work.source?.requestId);
  if (!sourceInfo.verified) sourceInfo.location = workSessionLocation(sessions.find(entry => entry.id === work.sessionId));
  return sourceInfo;
}

export async function describeSuggestionSources(suggestion, sessions, readRequest = requests.byRequest) {
  const describe = await createSourceReader(sessions, readRequest);
  const source = sessions.find(entry => entry.id === suggestion.sourceSessionId);
  const sourceIntent = data(source).intents?.find(entry => entry.id === suggestion.sourceIntentId);
  const target = sessions.find(entry => entry.id === suggestion.targetSessionId);
  const refs = suggestion.explanation?.sourceRefs || suggestion.sourceRefs || [];
  const [sourceInfo, references] = await Promise.all([
    describe(suggestion.sourceSessionId, suggestion.sourceRequestId || sourceIntent?.requestId),
    Promise.all(refs.map(ref => describe(ref.sessionId, ref.requestId))),
  ]);
  return { sourceInfo, targetInfo: target ? { sessionId: target.id, sessionName: text(target.name, 120) || '未命名对话',
    location: workSessionLocation(target), archived: target.archived === true } : null,
    references, draftedAt: suggestion.createdAt || (!suggestion.decisions?.length ? suggestion.updatedAt : '') };
}

export async function normalizeSuggestionExplanation(explanation, sourceRefs = []) {
  if (!explanation || typeof explanation !== 'object') throw new Error('Explain the finding, relevance and next action in plain language');
  const result = {};
  for (const field of ['summary', 'relevance', 'nextAction']) {
    const value = typeof explanation[field] === 'string' ? explanation[field].trim() : '';
    if (value.length < 6 || value.length > 300) throw new Error(field + ' needs a short, complete sentence (6–300 characters)');
    result[field] = value;
  }
  if (!Array.isArray(sourceRefs) || sourceRefs.length > 8) throw new Error('Use up to eight exact source message references');
  result.sourceRefs = await Promise.all(sourceRefs.map(async ref => {
    if (!text(ref?.sessionId, 120) || !text(ref?.requestId, 200)
      || !await requests.byRequest(ref.sessionId, ref.requestId)) throw new Error('Referenced source message was not found');
    return { sessionId: ref.sessionId, requestId: ref.requestId };
  }));
  return result;
}
