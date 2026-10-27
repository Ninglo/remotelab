import { randomUUID } from 'node:crypto';
import { getNextCronOccurrence } from '../../chat/recurring-schedules.mjs';

export const labels = { active: '已启用', paused: '已暂停', ended: '已到期', queued: '等待执行',
  running: '执行中', repairing: 'Agent 修复中', needs_human: '需要你处理', completed: '已完成',
  delivery_failed: '结果发送失败', stopped: '已停止', admitting: '正在启动' };
const text = value => typeof value === 'string' ? value.trim() : '';
function date(value) {
  if (!value) return '';
  if (!Number.isFinite(Date.parse(value))) throw new Error('日期无效');
  return new Date(value).toISOString();
}
export function definition(input, actor = {}) {
  const purpose = text(input.purpose);
  if (!purpose) throw new Error('请写明任务目的');
  const recipient = input.recipient?.kind === 'agent'
    ? { kind: 'agent', sessionId: text(input.recipient.sessionId), label: text(input.recipient.label) }
    : { kind: 'human', label: text(input.recipient?.label) || actor.personName || '本页与任务会话' };
  if (recipient.kind === 'agent' && !recipient.sessionId) throw new Error('请选择接收结果的 Agent 会话');
  const schedule = { kind: ['manual', 'once', 'cron'].includes(input.schedule?.kind) ? input.schedule.kind : 'manual',
    at: date(input.schedule?.at), cron: text(input.schedule?.cron), timezone: text(input.schedule?.timezone) || 'Asia/Shanghai' };
  if (schedule.kind === 'once' && !schedule.at) throw new Error('请填写执行日期');
  if (schedule.kind === 'cron') getNextCronOccurrence(schedule.cron, schedule.timezone);
  const startsAt = date(input.startsAt), endsAt = date(input.endsAt);
  if (startsAt && endsAt && startsAt >= endsAt) throw new Error('结束日期需要晚于开始日期');
  const noProgressMinutes = Number(input.monitoring?.noProgressMinutes || 0);
  if (!Number.isFinite(noProgressMinutes) || noProgressMinutes < 0) throw new Error('停滞预警时间无效');
  return { title: text(input.title) || purpose.slice(0, 40), purpose,
    input: text(input.input) || '本次交办内容及其中指定的材料',
    output: text(input.output) || '完成任务目的，将结果写回任务页面', recipient,
    cost: text(input.cost) || '首次运行暂无实测；用量随任务复杂度变化，执行后可查看实际记录。',
    owner: text(input.owner) || actor.personName || '任务创建者', scope: text(input.scope) || '仅本次试用任务及其工作目录',
    startsAt, endsAt, schedule,
    sop: text(input.sop) || '按目的处理输入，核对要求的输出；遇到失败先定位并修复。只能在本任务范围内操作。',
    monitoring: { noProgressMinutes, warning: text(input.monitoring?.warning) || '启动失败、执行报错、未生成约定结果时触发处理；Agent 无法解决或缺少必要输入时通知负责人。' },
    runtime: { tool: 'codex', model: text(input.runtime?.model) || 'gpt-6-sol', effort: 'medium' } };
}
export function nextDue(d, after) {
  const start = Math.max(after, Date.parse(d.startsAt) || 0);
  if (d.schedule.kind === 'manual') return '';
  if (d.schedule.kind === 'once') return d.schedule.at;
  return getNextCronOccurrence(d.schedule.cron, d.schedule.timezone, start);
}
export function newTask(input, actor, now = Date.now()) {
  const d = definition(input, actor), at = new Date(now).toISOString();
  d.startsAt ||= at;
  return { id: `trial_${randomUUID().replaceAll('-', '')}`, revision: 1, definition: d, actor,
    state: 'active', createdAt: at, updatedAt: at, nextAt: nextDue(d, now), cycles: [], events: [{ at, text: '创建试用任务，监管已绑定' }] };
}
export function newCycle(task, now = Date.now()) {
  return { id: randomUUID(), definition: structuredClone(task.definition), revision: task.revision,
    createdAt: new Date(now).toISOString(), status: 'queued', attempts: [], result: null, deliveries: {} };
}
export function canStart(task, now = Date.now()) {
  if (task.state !== 'active') return false;
  if (Date.parse(task.definition.startsAt) > now) return false;
  if (task.definition.endsAt && Date.parse(task.definition.endsAt) <= now) return false;
  // A newer occurrence cannot erase an unresolved occurrence.
  return !task.cycles.some(c => (!['completed', 'stopped'].includes(c.status) || (c.status === 'completed' && c.deliveries.result?.state !== 'delivered')));
}
export function taskPrompt(task, cycle, receiptPath, workspace) {
  const d = cycle.definition, repair = cycle.attempts.length > 1;
  return `执行一项已授权的独立试用任务。\n目的：${d.purpose}\n输入：${d.input}\n输出：${d.output}\n生效范围：${d.scope}\n负责人：${d.owner}\nSOP：${d.sop}\n监管与预警：${d.monitoring.warning}\n预估成本（仅告知，不是限制）：${d.cost}\n工作目录：${workspace}\n`
    + (repair ? `本次是故障修复。原错误：${cycle.error}。先核对已有结果，只补失败步骤；没有新诊断不要重复相同动作。原材料和历史保留。\n` : '')
    + `只执行任务明确授权的动作。若缺输入、权限或必须由人决定，写明具体所需动作。结果由系统按所选接收方交付，不要自行外发。\n`
    + `完成后用文件工具写 ${receiptPath}，JSON：{"status":"completed|needs_human|failed","summary":"实际结果","output":"交付正文","humanAction":"需要人的具体动作（仅需要时）","evidence":["真实产物路径或来源"]}。回执按真实结果填写，不以进程退出代替任务完成。该文件是本任务的结果交接，不是额外审批。最后用中文简述结果。`;
}
