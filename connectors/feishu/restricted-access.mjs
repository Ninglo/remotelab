import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const trim = value => typeof value === 'string' ? value.trim() : '';

export function normalizeRoleAccess(value) {
  if (!value || !trim(value.appId) || !trim(value.tenantKey)
      || !Array.isArray(value.hrOpenIds) || !value.hrOpenIds.length
      || !Array.isArray(value.interviewerOpenIds)
      || !trim(value.endpoint).startsWith('https://') || !trim(value.credentialsPath).startsWith('/')) {
    throw new Error('roles policy requires app, tenant, exact role IDs, HTTPS endpoint and credentialsPath');
  }
  const ids = [...value.hrOpenIds, ...value.interviewerOpenIds];
  if (ids.some(id => !/^ou_[a-zA-Z0-9]+$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('roles policy has invalid or overlapping identities');
  }
  return { appId: value.appId, tenantKey: value.tenantKey,
    hrOpenIds: [...value.hrOpenIds], interviewerOpenIds: [...value.interviewerOpenIds],
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
  if (config.interviewerOpenIds.includes(sender.openId)) return 'interviewer';
  return 'deny';
}

export function requireFullFeishuAccess(policy, summary) {
  if (!['legacy', 'hr'].includes(feishuAccessRole(policy, summary))) {
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
  const match = /^(查询|简历|准备)\s+([^\r\n]{1,80})$/.exec(value);
  if (!match) return null;
  const selector = match[2].trim();
  return { action: ({ 查询: 'detail', 简历: 'resume', 准备: 'prepare' })[match[1]],
    ...(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector)
      ? { candidateId: selector } : { candidateName: selector }) };
}

export async function queryRestrictedInterview(policy, summary, { fetchImpl = fetch, now = Date.now } = {}) {
  if (feishuAccessRole(policy, summary) !== 'interviewer') throw new Error('Interviewer identity required');
  if (!['p2p', 'private'].includes(summary.chatType) || summary.eventType !== 'im.message.receive_v1') {
    return null;
  }
  // messageText is already extracted by the provider event normalizer. Rich
  // text uses the same bounded command parser and signed identity as plain text;
  // no attachments, linked documents or forwarded speakers enter the query.
  if (!['text', 'post'].includes(summary.messageType)) return null;
  const query = parseInterviewQuery(summary.messageText);
  if (!query) return null;
  const credentials = JSON.parse(await readFile(policy.roles.credentialsPath, 'utf8'));
  if (!credentials.apiKey || !credentials.signingKey) throw new Error('Restricted query credentials unavailable');
  const payload = { version: 1, appId: policy.roles.appId, tenantKey: policy.roles.tenantKey,
    senderOpenId: summary.sender.openId, messageId: summary.messageId, issuedAt: now(), query };
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', credentials.signingKey).update(body).digest('hex');
  const response = await fetchImpl(policy.roles.endpoint, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}`,
      'X-Interview-Signature': signature }, body, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Restricted interview query failed (${response.status})`);
  const packet = await response.json();
  const result = packet.data || packet;
  // The backend owns object access and topic scope. A silent rejection must
  // never turn into command help, a fallback answer or an empty queued message.
  if (result.reply === false) return null;
  if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 24_000) {
    throw new Error('Invalid restricted query response');
  }
  return result.text;
}
