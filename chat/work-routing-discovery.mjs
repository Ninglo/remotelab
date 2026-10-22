// Small registered-group catalog + bounded metadata search. Semantic ownership
// remains with the Harness; discovery is never permission to send or resume.
import { routingPilotGroups } from '../lib/group-routing-pilot.mjs';
import { loadProjectMemoryRuntime } from './project-memory-runtime.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { candidateWorkFromSessions } from './work-awareness-relevance.mjs';
import { getHistorySnapshot } from './history.mjs';
import { getRun } from './runs.mjs';
import { buildSessionNavigationHref } from '../lib/session-navigation.mjs';

const iso = value => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
};
export async function routingDiscovery(session, personId, { query = '', sessions, history = getHistorySnapshot, run = getRun } = {}) {
  const started = performance.now();
  const groups = await routingPilotGroups(session.conversation, personId);
  let config;
  try { config = (await loadProjectMemoryRuntime()).config; } catch { /* Names may be unavailable. */ }
  const catalog = groups.map(g => {
    const registered = config?.groups.find(p => p.sourceRouteId === g.route && p.chatId === g.chatId);
    return { ...g, name: registered?.chatName || g.name,
      projects: (registered?.projectIds || []).map(id => ({ id, name: config.projects.find(p => p.id === id)?.name || id })) };
  });
  if (!query.trim() || !groups.length) return { catalog, candidates: [],
    observation: { metadataReads: 0, transcriptReads: 0, elapsedMs: Math.round(performance.now() - started) } };
  const available = (sessions || await loadSessionsMeta()).filter(s => !s.groupFeed && !s.internalRole
    && ['thread', 'topic'].includes(s.conversation?.target?.conversationKind)
    && s.conversation?.target?.tenantKey === session.conversation?.target?.tenantKey
    && groups.some(g => g.route === s.conversation?.sourceRouteId && g.chatId === s.conversation?.target?.chatId));
  const found = candidateWorkFromSessions(available, { sessionId: session.id, query, limit: 3 });
  const candidates = await Promise.all(found.map(async c => {
    const s = available.find(s => s.id === c.sessionId);
    const group = catalog.find(g => g.route === s.conversation.sourceRouteId && g.chatId === s.conversation.target.chatId);
    let snapshot;
    try { snapshot = await history(s.id, { metadataOnly: true }); } catch { /* Unknown remains unknown. */ }
    const works = [...(s.workAwareness?.works || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const open = works.find(w => ['active', 'blocked', 'paused'].includes(w.status));
    const latest = works[0];
    const lastUserMessageAt = iso(snapshot?.lastUserMessageAt);
    let execution;
    if (s.activeRunId) try { execution = await run(s.activeRunId); } catch { /* Unknown remains unknown. */ }
    const status = !snapshot || (s.activeRunId && !execution) ? 'unknown'
      : ['accepted', 'queued', 'running'].includes(execution?.state) ? execution.state
        : open?.status || (latest?.status === 'completed'
          && (!lastUserMessageAt || lastUserMessageAt <= iso(latest.updatedAt)) ? 'completed' : 'idle');
    return { sessionId: s.id, name: c.sessionName, goal: c.goal.slice(0, 300), group,
      status, matchedWorkStatus: c.status, archived: !!s.archived, createdAt: iso(s.created),
      lastUserMessageAt, lastWorkUpdateAt: iso(latest?.updatedAt),
      transfer: s.archived ? 'unavailable-archived' : 'explicit-instruction-or-confirmed-draft',
      handoff: s.archived ? null : { mode: 'handoff', targetSessionId: s.id,
        authorization: 'An explicit human instruction naming this destination and content can supply authorization.sourceRequestId + quote; otherwise request the draft question.' },
      sessionUrl: buildSessionNavigationHref(s.id),
      boundary: 'Candidate only. Read the original task and latest state; idle or recent does not authorize resuming it.' };
  }));
  return { catalog, candidates, observation: { metadataReads: found.length, transcriptReads: 0,
    elapsedMs: Math.round(performance.now() - started) } };
}

export function buildMisroutePrompt(sourceContext) {
  return [
    '## 新输入与当前工作的关系',
    '收到新输入时，由当前 Harness 判断它与正在推进的目标、操作对象是否一致。补充、纠正、追问和明确改目标直接接续；不能仅因出现新名词、另一项目或 Session 就判为误发。对象与目标明显不一致且是独立交付时，及时保留疑似误发内容，不据此修改当前任务；无关的已授权工作继续。不要另起分类模型或常驻扫描。',
    '先用已注入的小目录；仍缺去向时按具体对象查一次 work discover --query <事项> --json，最多三个候选，再只读候选的原任务和最新状态。Web 未绑定登记群时用 work directory --query <事项> --json。不要全历史扫描；旧、完成或暂停话题仅作参考，除非人明确要求接续。目标不明时用原生提问只问具体去向；沉默不是同意。',
    ...(sourceContext?.connector === 'feishu' ? [
      '登记范围内任务转交用 work route 的 mode:handoff（跨群不能用 continue，也不能用只同步参考的 sync 代替交办）。人已经明确要求转交这些原消息/附件到已确定的目标时，传 {sourceRequestId,mode:"handoff",targetSessionId,task,reason,requestIds,authorization:{sourceRequestId,quote:"当前已接受人类指令中明确内容和去向的原话"}}，不再要求重复批准。authorization 只引用本次实际接受的指令；不能把疑似误发、Agent 判断、引用他人指令或含糊目标写成授权。',
      '只有识别误发或提出候选时，省略 authorization 创建草稿，把返回的完整 question 原样交原生提问工具，由本人选定。自动分流开关不替代显式授权；登记群、Bot、租户和作者边界仍由入口校验，不自行扩权。以目标受理回执为准，失败留原话题；用原 proposalId 恢复，不换入口重复投递。',
    ] : ['发现其他话题不等于获准向其发送。沿当前渠道已有授权入口交接，无法确认目标或范围时先问人；不要通过通用消息 API 绕过确认。']),
  ].join('\n');
}
