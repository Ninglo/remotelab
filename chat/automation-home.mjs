import { createHash } from 'node:crypto';
import { readAutomationHome, mutateAutomationHome, automationDefinition } from './automation-home-store.mjs';
import { loadAuthDocument, findIdentity } from '../lib/auth-config.mjs';
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actor = auth => ({ identityId: auth?.identityId || '', personId: auth?.personId || '', name: auth?.personName || '' });
export async function automationRecord(id) {
  if (id.startsWith('sch_')) return (await import('./recurring-schedules.mjs')).getRecurringSchedule(id);
  return (await import('./triggers.mjs')).getTrigger(id);
}
function homePrompt(record, author, establishedAt, brief) {
  return `这是自动化任务的固定主Session，由来源Session fork，继承历史只作背景，不扩展授权。\n任务ID：${record.id}\n原任务创建身份（不推断最初提出人）：${author.name || author.identityId || '原记录未明确'}\n原任务创建时间：${record.createdAt || '未记录'}\n本主Session建立时间：${establishedAt}\n来源Session：${record.sourceSessionId}\n目标与执行定义：\n${record.text}\n\n维护说明：${brief}\n\n当前有效定义与历史版本：GET /api/automation-tasks/${record.id}/home。查询直接读此接口及执行记录，不给后台执行Session排队发消息。原来源和本Session不承接定时长任务；后台保持原执行策略。\n任何新意见先形成具体修改，记录提出人、来源和确认人；经有权人的明确确认才修改原任务，不另建同义任务。普通修改下一轮生效，已经接受的运行保留当轮快照；撤销本轮授权须单独停止当前Run并回读。\n停止后保留所有历史；区分停止后续触发与当前运行已结束。失败只补失败步骤，先核对原业务回执，避免重复写入或发送。不能自行猜测授权、收件人或业务成功；不确定的外部写入先查回执，无法核实就报告需人工处理。\n每轮模型完成不等于业务完成。页面运行记录来自原Trigger/Run，业务结果和交付以原产物及发送回执为准。`;
}
export async function ensureAutomationHome(id, { auth = {}, brief = '' } = {}) {
  const record = await automationRecord(id);
  if (!record) throw new Error('Automation task not found');
  if (record.sessionTemplate?.sessionCollection !== 'automations') throw new Error('Only explicitly selected automations can have a home');
  if (record.sessionTemplate?.reuse === 'fixed_session') throw new Error('A home requires independent execution; migrate its runtime separately first');
  const { listTriggers } = await import('./triggers.mjs');
  const allTriggers = await listTriggers();
  const triggers = allTriggers.filter(item => (item.scheduleId || item.id) === id);
  const sourceIds = new Set(allTriggers.map(item => item.sourceSessionId));
  const safeSessions = [...new Set(triggers.map(item => item.executionSessionId).filter(Boolean))].filter(sessionId =>
    !sourceIds.has(sessionId) && !allTriggers.some(item => item.executionSessionId === sessionId && (item.scheduleId || item.id) !== id));
  const home = await mutateAutomationHome(id, async existing => {
    if (existing) return existing;
    const { forkSession } = await import('./session-manager.mjs');
    const identified = findIdentity(await loadAuthDocument(), record.createdByIdentityId);
    const author = { identityId: record.createdByIdentityId || '', name: identified?.person?.name || identified?.identity?.displayName || '' };
    const at = now();
    const maintenance = String(brief || '沿用原任务正文、业务规则和交付回执；不擅自改变时间、输出目标或发送对象。').slice(0, 8000);
    const session = await forkSession(record.sourceSessionId, { name: record.title || '自动化任务',
      group: '自动化任务', description: '自动化固定入口：任务定义、历次运行、变更与停止记录',
      externalTriggerId: `automation-home:${id}`, automationTaskId: id, internalRole: 'automation_home',
      sessionCollection: 'automations', initiatedByIdentityId: record.createdByIdentityId,
      viewPersonId: auth.personId, sourceId: 'remotelab', sourceName: 'RemoteLab', sourceContext: null,
      systemPrompt: homePrompt(record, author, at, maintenance) });
    if (!session) throw new Error('Source Session cannot currently be forked; retry after its current context boundary is available');
    return { version: 1, taskId: id, sessionId: session.id, sourceSessionId: record.sourceSessionId, author,
      taskCreatedAt: record.createdAt || '', establishedAt: at, brief: maintenance,
      definitions: [{ revision: 1, at, definition: automationDefinition(record), note: '建立主Session时的定义；不是历史各轮的追溯版本' }],
      events: [{ type: 'established', at, actor: actor(auth), state: record.status, note: '从原来源fork；此前运行沿用原记录，未重跑' }], runs: {} };
  });
  // Repeat safely after a partial migration: neither fork nor business execution repeats.
  const { bindSessionAutomation } = await import('./session-manager.mjs');
  for (const sessionId of safeSessions) {
    await bindSessionAutomation(sessionId, { taskId: id, homeSessionId: home.sessionId });
  }
  return home;
}
export async function recordAutomationHomeChange(record, before, auth, operation = '', details = {}) {
  if (!record?.id) return;
  if (!await readAutomationHome(record.id)) return;
  await mutateAutomationHome(record.id, home => {
    const definition = automationDefinition(record), previous = home.definitions.at(-1);
    const changed = hash(previous.definition) !== hash(definition);
    const state = operation === 'delete' ? 'deleted' : record.status || (record.enabled ? 'active' : 'paused');
    const last = home.events.at(-1);
    if (!changed && last.state === state && !operation) return home;
    const at = now();
    if (changed) home.definitions.push({ revision: previous.revision + 1, at, definition, actor: actor(auth) });
    home.events.push({ type: operation || (changed ? 'definition_changed' : 'state_changed'), at,
      actor: actor(auth), state, previousState: before?.status || '', revision: home.definitions.at(-1).revision,
      reportedSource: { sessionId: details.sourceSessionId || '', requestId: details.sourceRequestId || '', verified: false },
      reason: String(details.reason || ''), includeActive: details.includeActive === true,
      cancellation: details.cancellation || null });
    return home;
  });
}
export async function prepareAutomationHomeRun(trigger, session) {
  const id = trigger.scheduleId || trigger.id, home = await readAutomationHome(id);
  if (!home) return '';
  const { bindSessionAutomation } = await import('./session-manager.mjs');
  await bindSessionAutomation(session.id, { taskId: id, homeSessionId: home.sessionId });
  const saved = await mutateAutomationHome(id, current => {
    if (!current.runs[trigger.id]?.taskTextHash) {
      current.runs[trigger.id] = { at: now(), revision: hash([trigger.text, trigger.sessionTemplate]) === hash([current.definitions.at(-1).definition.text, current.definitions.at(-1).definition.sessionTemplate]) ? current.definitions.at(-1).revision : null,
        triggerId: trigger.id, sessionId: session.id, taskTextHash: hash(trigger.text),
        definition: automationDefinition(trigger), trigger: { ...trigger, text: undefined, sessionTemplate: undefined } };
    }
    return current;
  });
  const run = saved.runs[trigger.id];
  return `\n\n[自动化运行关联]\n任务：${id}\n固定主Session：${home.sessionId}\n主记录定义版本：${run.revision ?? '历史触发快照，与当前定义不同'}；本轮实际输入快照以触发记录 ${trigger.id} 为准。\n原任务创建：${home.taskCreatedAt || '未记录'}；原任务创建身份（不推断最初提出人）：${home.author.name || home.author.identityId || '未记录'}。\n目标、授权和输出沿本轮任务正文；历史记录按需读取 /api/automation-tasks/${id}/home。不要唤起主Session或原讨论的模型。失败先查回执，只补失败步骤，不重复发送；无法确认写入结果则报告待核实。`;
}
export async function readAutomationHomeView(id) {
  const home = await readAutomationHome(id); if (!home) return null;
  const { getAutomationTask, projectExecution } = await import('./automation-tasks.mjs');
  const { listTriggers, getTrigger } = await import('./triggers.mjs');
  const task = await getAutomationTask(id);
  const occurrences = id.startsWith('sch_') ? await listTriggers({ scheduleId: id }) : [await getTrigger(id)].filter(Boolean);
  await mutateAutomationHome(id, current => {
    if (task?.state === 'completed' && current.events.at(-1)?.state !== 'completed') current.events.push({
      type: 'state_observed', state: 'completed', at: now(), actor: { name: 'Scheduler' },
      note: 'Observed completion from durable task/run state; this timestamp is observation time.' });
    for (const trigger of occurrences) current.runs[trigger.id] = { ...current.runs[trigger.id],
      triggerId: trigger.id, sessionId: trigger.executionSessionId || '',
      trigger: { ...trigger, text: undefined, sessionTemplate: undefined } };
    return current;
  });
  const byId = new Map(occurrences.map(item => [item.id, item]));
  for (const run of Object.values(home.runs)) if (!byId.has(run.triggerId)) byId.set(run.triggerId, run.trigger);
  const executions = await Promise.all([...byId.values()].map(trigger => projectExecution(trigger)));
  executions.sort((a,b) => String(b.scheduledAt).localeCompare(String(a.scheduledAt)));
  return { ...home, task, executions: executions.map(run => ({ ...run, definitionRevision: home.runs[run.id]?.revision || null })),
    activeExecutions: executions.filter(run => ['running','starting','queued'].includes(run.state)),
    boundary: '模型运行状态不等于业务交付；旧记录没有的定义版本或操作作者不追溯编造。' };
}
