import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

export const isLimitedInterviewQuestion = text => /(?:候选人.{0,80}(?:进度|面试|问题)|面试.{0,40}(?:进度|问过|问题)|我的候选人|我负责的候选人)/u.test(text);
export const INTERVIEW_NO_ACCESS = '未核验到你当前有效的候选人查询权限，无法通过此入口查询。请联系 HR 核对。';

// Operator-owned mappings bind an authenticated actor across application ID
// namespaces. They do not grant backend role or candidate-record permissions.
export async function limitedInterviewReply(config, input, { fetchImpl = fetch, now = Date.now() } = {}) {
  const options = input.options || {}, source = options.sourceContext || {};
  const actor = (config.actors || []).find(actor => options.feishuConnectorAuthenticated === true
    && source.connector === 'feishu' && source.sender?.senderType === 'user'
    && actor.route === source.sourceRouteId && actor.tenant === source.tenantKey && actor.openId === source.sender.openId);
  if (!actor) return INTERVIEW_NO_ACCESS;
  if (!['p2p', 'private'].includes(source.chatType)) return '候选人信息仅限本人在已核验的私聊中查询。';
  if (!source.messageId || !config.endpoint?.startsWith('https://')) throw new Error('Invalid controlled interview configuration');
  const credentials = JSON.parse(await readFile(config.credentialsPath, 'utf8'));
  if (!credentials.apiKey || !credentials.signingKey) throw new Error('Missing controlled interview credential');
  const payload = { version: 1, appId: config.appId, tenantKey: config.tenant,
    senderOpenId: actor.targetOpenId, messageId: source.messageId, issuedAt: now,
    query: { action: 'limited', question: String(input.text).slice(0, 4000) } };
  const body = JSON.stringify(payload);
  const response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}`,
      'X-Interview-Signature': createHmac('sha256', credentials.signingKey).update(body).digest('hex') },
    body, signal: AbortSignal.timeout(30_000) });
  if ([401, 403].includes(response.status)) return INTERVIEW_NO_ACCESS;
  if (!response.ok) throw new Error('Controlled interview query unavailable');
  const packet = await response.json(), result = packet.data || packet;
  if (result.limitedVersion !== 1 || !Array.isArray(result.candidates) || result.candidates.length > 100) throw new Error('Unsupported limited query response');
  if (result.denied) return INTERVIEW_NO_ACCESS;
  if (result.needsSelector) return '请提供你当前负责的候选人姓名或 ID。';
  const stages = new Set(['未开始', '待面试', '一面', '二面', '三面', '四面', '终面', '面试中', '面试完成', '暂无可提供的面试阶段记录']);
  const rows = result.candidates.map(row => {
    if (typeof row.name !== 'string' || row.name.length > 80 || /[\r\n]/u.test(row.name)
        || !stages.has(row.progress) || row.questionStatus !== 'no_separate_record'
        || !Array.isArray(row.questions) || row.questions.length) throw new Error('Invalid limited query fields');
    // No free-form server answer or extra field is published.
    return `${row.name}：${row.progress}。暂无可单独提供的已记录面试问题，不从面评推测。`;
  });
  return rows.join('\n') || INTERVIEW_NO_ACCESS;
}
