import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

export function isHrCollaborationQuery(text) {
  return /岗位|职位|招聘需求|招聘优先级|招聘待办|\bJD\b|SOP|操作说明/iu.test(String(text || ''))
    && !/候选人|简历|录入|入库|排期|改期|安排|提交|更新|新建|修改|追加|删除|继续办理/u.test(String(text || ''));
}

export async function hrCollaborationReply(config, actor, input, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!config?.endpoint?.startsWith('https://') || !actor) throw new Error('HR collaboration unavailable');
  const credentials = JSON.parse(await readFile(config.credentialsPath, 'utf8'));
  const body = JSON.stringify({ version: 1, appId: config.appId, tenantKey: config.tenant,
    senderOpenId: actor.openId || actor.id, subjectId: actor.id,
    messageId: input.options?.requestId || input.options?.sourceContext?.messageId,
    issuedAt: now, query: { action: 'jobs', question: String(input.text || '查询在招岗位').slice(0, 4000) } });
  const response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}`,
      'X-Interview-Signature': createHmac('sha256', credentials.signingKey).update(body).digest('hex') },
    body, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HR collaboration query failed (${response.status})`);
  const packet = await response.json(), result = packet.data || packet;
  if (result.jobsVersion !== 1 || !Array.isArray(result.jobs) || result.jobs.length > 200) throw new Error('Invalid job response');
  if (/SOP|流程|怎么|如何|帮助|操作说明/iu.test(String(input.text || '')) && typeof result.guide === 'string') return result.guide.slice(0,6000);
  const field = value => typeof value === 'string' ? value.slice(0, 6000) : '';
  const lines = value => Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, 40).map(field).join('；') : '';
  return result.jobs.map(job => [field(job.role), `负责人：${field(job.owner)}`,
    `状态：${job.active ? '招聘中' : '已关闭'}`, `优先级：${field(job.priority)}`,
    field(job.intro), lines(job.duties), lines(job.requirements), lines(job.bonus),
    [field(job.location), field(job.typeLabel)].filter(Boolean).join(' · '), `待办：${field(job.todo)}`]
    .filter(Boolean).join('\n')).join('\n\n') || '目前没有已发布的在招岗位。';
}
