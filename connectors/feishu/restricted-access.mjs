import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import { executeRecruitingWorkflow } from './recruiting-workflow.mjs';
import { createRecordStore } from '../../lib/durable-records.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

export function normalizeRoleAccess(value) {
  if (!value || !trim(value.appId) || !trim(value.tenantKey)
      || !Array.isArray(value.hrOpenIds) || !value.hrOpenIds.length
      || !Array.isArray(value.interviewerOpenIds)
      || (value.collaboratorOpenIds !== undefined && !Array.isArray(value.collaboratorOpenIds))
      || (value.recruitingInternOpenIds !== undefined && !Array.isArray(value.recruitingInternOpenIds))
      || !trim(value.endpoint).startsWith('https://') || !trim(value.credentialsPath).startsWith('/')) {
    throw new Error('roles policy requires app, tenant, exact role IDs, HTTPS endpoint and credentialsPath');
  }
  const collaboratorOpenIds = value.collaboratorOpenIds || [];
  const recruitingInternOpenIds = value.recruitingInternOpenIds || [];
  const ids = [...value.hrOpenIds, ...collaboratorOpenIds, ...value.interviewerOpenIds, ...recruitingInternOpenIds];
  if (ids.some(id => !/^ou_[a-zA-Z0-9]+$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('roles policy has invalid or overlapping identities');
  }
  if (value.recruitingWorkflowCommand !== undefined && (!Array.isArray(value.recruitingWorkflowCommand)
      || !value.recruitingWorkflowCommand.length || !value.recruitingWorkflowCommand[0].startsWith('/')
      || value.recruitingWorkflowCommand.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0'))))
    throw new Error('Invalid fixed recruiting workflow command');
  return { ...(value.recruitingWorkflowCommand ? {recruitingWorkflowCommand:[...value.recruitingWorkflowCommand]} : {}), appId: value.appId, tenantKey: value.tenantKey,
    hrOpenIds: [...value.hrOpenIds], collaboratorOpenIds: [...collaboratorOpenIds],
    interviewerOpenIds: [...value.interviewerOpenIds], recruitingInternOpenIds: [...recruitingInternOpenIds],
    endpoint: value.endpoint, credentialsPath: value.credentialsPath };
}

// Only authenticated provider event fields enter here; never message text, names,
// aliases, user-supplied role fields, or a Session's previous speaker.
export function feishuAccessRole(policy, summary) {
  if (policy?.mode !== 'roles') return 'legacy';
  const config = policy.roles;
  const sender = summary?.sender;
  if (!config || summary?.appId !== config.appId || summary?.tenantKey !== config.tenantKey
      || sender?.senderType !== 'user' || sender?.tenantKey !== config.tenantKey) return 'deny';
  if (config.hrOpenIds.includes(sender.openId)) return 'hr';
  if (config.collaboratorOpenIds?.includes(sender.openId)) return 'collaborator';
  if (config.recruitingInternOpenIds?.includes(sender.openId)) return 'recruiting_intern';
  if (config.interviewerOpenIds.includes(sender.openId)) return 'interviewer';
  return 'deny';
}

// Card actions arrive on the app's authenticated Feishu connection, but card
// render targets are delivery addresses, not complete sender identities. Build
// the role check from the callback operator and tenant, and reject conflicting
// values supplied by any card-specific summary.
export function summarizeFeishuCardAction(config, raw, summary) {
  const event = raw?.event || raw;
  const appId = trim(config?.appId);
  const operator = event?.operator;
  const sender = { senderType: 'user' };
  for (const [field, key] of [['openId', 'open_id'], ['userId', 'user_id'], ['unionId', 'union_id']]) {
    const values = [operator?.operator_id?.[key], operator?.[key]].map(trim).filter(Boolean);
    if (values.some(value => value !== values[0])
        || summary?.sender?.[field] && summary.sender[field] !== values[0]) return null;
    sender[field] = values[0] || '';
  }
  const tenants = [operator?.tenant_key, event?.tenant_key, raw?.header?.tenant_key]
    .map(trim).filter(Boolean);
  if (!appId || !sender.openId || !tenants.length || tenants.some(value => value !== tenants[0])
      || !summary?.sender?.openId || summary.sender.openId !== sender.openId
      || summary.sender.senderType && summary.sender.senderType !== 'user'
      || summary.sender.tenantKey && summary.sender.tenantKey !== tenants[0]
      || summary.tenantKey && summary.tenantKey !== tenants[0]
      || summary.appId && summary.appId !== appId
      || raw?.header?.app_id && raw.header.app_id !== appId) return null;
  return { ...summary, appId, tenantKey: tenants[0],
    sender: { ...sender, tenantKey: tenants[0] } };
}

export function requireFullFeishuAccess(policy, summary) {
  if (!['legacy', 'hr', 'collaborator'].includes(feishuAccessRole(policy, summary))) {
    throw new Error('Restricted sender cannot enter the general RemoteLab executor');
  }
}

export function parseInterviewQuery(text) {
  // Copying a numbered instruction from Feishu can retain its list marker.
  const value = trim(text).replace(/^\d{1,2}[.．、)]\s+/u, '');
  if (['名单', '我的候选人', '我负责的候选人', '我负责哪些候选人', '我负责哪些候选人？'].includes(value)) {
    return { action: 'list' };
  }
  const question = /^提问\s+([^|｜\r\n]{1,80})\s*[|｜]\s*([^\r\n]{1,1000})$/.exec(value);
  if (question) {
    const selector = question[1].trim();
    return { action: 'ask', question: question[2].trim(),
      ...(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector)
        ? { candidateId: selector } : { candidateName: selector }) };
  }
  const match = /^(查询|简历|准备)\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(value);
  if (!match) return value ? { action: 'chat', question: value } : null;
  const selector = match[2].trim();
  return { action: ({ 查询: 'detail', 简历: 'resume', 准备: 'prepare' })[match[1]],
    ...(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector)
      ? { candidateId: selector } : { candidateName: selector }) };
}

export const INTERVIEW_QUERY_UNAVAILABLE = '面试查询服务暂时不可用，请稍后重试；无需重新授权。';

export function restrictedInterviewOptions(runtime) {
  return { sourceRouteId: runtime.config.sourceRouteId, store: runtime.interviewConversationStore ||= createRecordStore(
    join(runtime.config.storageDir, 'interview-conversations')) };
}

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const validIds = ids => Array.isArray(ids) && ids.length <= 100 && ids.every(uuid) && new Set(ids).size === ids.length;
const recordKey = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);

// The backend may resolve natural language only into this closed, signed query
// protocol. It cannot nominate another URL, identity, role or executor command.
function resolvedQuery(result, original) {
  const q = result.nextQuery;
  if (!q || !['answer', 'resume'].includes(q.action) || !validIds(q.candidateIds) || !q.candidateIds.length
      || Object.keys(q).some(key => !['action','candidateIds','question','context'].includes(key))
      || (q.action === 'answer' && q.question !== original.question)
      || (q.action === 'resume' && (q.question || q.context))) throw new Error('Invalid interview query resolution');
  return { action: q.action, candidateIds: q.candidateIds,
    ...(q.action === 'answer' ? {question: original.question, ...(original.context ? {context:original.context} : {})} : {}) };
}

export async function queryRestrictedInterview(policy, summary, { fetchImpl = fetch, now = Date.now, store, sourceRouteId, readOnly = false, workflowImpl = executeRecruitingWorkflow } = {}) {
  const role = feishuAccessRole(policy, summary);
  if (!['interviewer', 'recruiting_intern'].includes(role)) throw new Error('Restricted recruiting identity required');
  if (!['p2p', 'private'].includes(summary.chatType) || summary.eventType !== 'im.message.receive_v1') {
    return null;
  }
  // Normalized rich text and plain text share the restricted backend; arbitrary
  // wording never enters the general executor or grants object access.
  if (!['text', 'post'].includes(summary.messageType)
      && !(role === 'recruiting_intern' && summary.messageType === 'file' && policy.roles.recruitingWorkflowCommand)) return null;
  const { evaluateRequestAccess } = await import('../../chat/request-access-guard.mjs');
  const denied = await evaluateRequestAccess({ sessionId: 'interviewer:' + summary.chatId,
    text: summary.messageText, options: { requestId: 'feishu:' + summary.messageId,
      restrictedRecruiting: role === 'recruiting_intern', feishuConnectorAuthenticated: true, usageSurface: 'feishu-restricted-interview',
      sourceContext: { connector: 'feishu', sourceRouteId,
        tenantKey: summary.tenantKey, messageId: summary.messageId, chatType: summary.chatType, sender: summary.sender } } });
  if (denied?.blocked) return denied.reply;
  if (role === 'recruiting_intern' && policy.roles.recruitingWorkflowCommand) {
    const result = await workflowImpl(policy.roles.recruitingWorkflowCommand, summary, {readOnly});
    if (result.handled) return result.text;
  }
  let query = parseInterviewQuery(summary.messageText);
  if (!query) return null;
  if ((query.question?.length || 0) > 4000) return '问题较长，请分成几条发送，每条不超过4000字。';
  const subject = [policy.roles.appId, policy.roles.tenantKey, summary.sender.openId, summary.chatId || ''];
  const messageKey = recordKey([...subject, summary.messageId]);
  const contextKey = recordKey([...subject, 'context']);
  if (store) {
    const context = await store.get(contextKey);
    const snapshot = await store.mutate(messageKey, previous => previous || {
      query: {...query, ...(query.action === 'chat' && context?.expiresAt > now()
        ? {context:{candidateIds:context.candidateIds,question:context.question}} : {})},
      createdAt: now(),
    });
    query = snapshot.resolvedQuery || snapshot.query;
  }
  const credentials = JSON.parse(await readFile(policy.roles.credentialsPath, 'utf8'));
  if (!credentials.apiKey || !credentials.signingKey) throw new Error('Restricted query credentials unavailable');
  const request = async selected => {
    const payload = { version: 1, appId: policy.roles.appId, tenantKey: policy.roles.tenantKey,
      senderOpenId: summary.sender.openId, messageId: summary.messageId, issuedAt: now(), query: selected };
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', credentials.signingKey).update(body).digest('hex');
    const response = await fetchImpl(policy.roles.endpoint, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}`,
        'X-Interview-Signature': signature }, body, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Restricted interview query failed (${response.status})`);
    const packet = await response.json();
    return packet.data || packet;
  };
  let result = await request(query);
  if (query.action === 'chat' && result.nextQuery) {
    query = resolvedQuery(result, query);
    if (store) await store.mutate(messageKey, previous => ({...previous, resolvedQuery:query}));
    result = await request(query);
  }
  // The backend owns object access and topic scope. A silent rejection must
  // never turn into command help, a fallback answer or an empty queued message.
  if (result.reply === false) return null;
  if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 24_000) {
    throw new Error('Invalid restricted query response');
  }
  if (store && validIds(result.candidateIds)) {
    const snapshot = await store.get(messageKey);
    // A delayed delivery/retry cannot replace context from a newer message.
    await store.mutate(contextKey, previous => (previous?.createdAt || 0) > snapshot.createdAt ? previous : {
      createdAt:snapshot.createdAt, expiresAt:now()+24*60*60_000,
      candidateIds:result.candidateIds, question:snapshot.query.question || summary.messageText.slice(0,4000),
    });
    await store.archive(messageKey);
  }
  return result.text;
}
