import { findIdentity, findPerson, loadAuthDocument, updateAuthDocument } from '../lib/auth-config.mjs';

const DAY = 86400000;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function owner(document, actor) {
  const person = findIdentity(document, actor?.identityId)?.person;
  if (!person || person.id !== actor.personId || actor.authKind === 'service') fail('需要已核实的本人身份。', 403);
  return person;
}
function settings(person) {
  const value = person?.preferences?.parallelDisplayTrial;
  if (!value) return { version: 1, revision: 0, enabled: false, personId: person?.id };
  if (value.version !== 1 || value.personId !== person.id || !Number.isSafeInteger(value.revision)
      || !Number.isFinite(Date.parse(value.startsAt)) || !Number.isFinite(Date.parse(value.endsAt))) {
    fail('并行展示试用配置无法读取。', 500);
  }
  return value;
}
export function parallelDisplayActive(value, now = Date.now()) {
  return value?.version === 1 && value.enabled === true
    && now >= Date.parse(value.startsAt) && now < Date.parse(value.endsAt);
}
export async function loadParallelDisplayTrial(actor) {
  const value = settings(owner(await loadAuthDocument({ persistMigration: false }), actor));
  return { ...value, active: parallelDisplayActive(value) };
}
export async function changeParallelDisplayTrial(input, actor) {
  if (input.confirm !== true || typeof input.enabled !== 'boolean') fail('请明确开启或关闭并行展示试用。');
  const days = input.durationDays ?? 7;
  if (!Number.isSafeInteger(days) || days < 1 || days > 31) fail('试用周期须为 1 至 31 天。');
  const result = await updateAuthDocument(document => {
    const person = owner(document, actor), old = settings(person);
    if (old.revision !== input.expectedRevision) fail('设置已变化，请重新读取。', 409);
    const now = Date.now();
    const next = { version: 1, revision: old.revision + 1, personId: person.id, enabled: input.enabled,
      startsAt: input.enabled ? new Date(now).toISOString() : old.startsAt || new Date(now).toISOString(),
      endsAt: input.enabled ? new Date(now + days * DAY).toISOString() : old.endsAt || new Date(now).toISOString(),
      source: { sessionId: actor.sessionId, requestId: actor.requestId, identityId: actor.identityId },
      audit: [...(old.audit || []), { revision: old.revision + 1, enabled: input.enabled,
        at: new Date(now).toISOString(), sourceRequestId: actor.requestId, identityId: actor.identityId }].slice(-32) };
    person.preferences = { ...person.preferences, parallelDisplayTrial: next };
    person.updatedAt = new Date(now).toISOString();
    return { ...next, active: parallelDisplayActive(next) };
  });
  return result.result;
}
export async function captureParallelDisplayTrial(personId, now = Date.now()) {
  const person = findPerson(await loadAuthDocument({ persistMigration: false }), personId);
  if (!person) return null;
  const value = settings(person);
  if (!parallelDisplayActive(value, now)) return null;
  const { audit, active, ...snapshot } = value;
  return snapshot;
}
// A plan's original author and trial revision own the presentation. A new
// speaker, expired window or explicit off cannot inherit the previous choice.
export async function activePlanDisplay(plan, now = Date.now()) {
  const snapshot = plan?.displayTrial;
  if (!snapshot || snapshot.personId !== plan.actor?.personId || !parallelDisplayActive(snapshot, now)) return null;
  const current = await captureParallelDisplayTrial(snapshot.personId, now);
  return current?.revision === snapshot.revision ? snapshot : null;
}
export function branchDisplayName(plan, branch) {
  const index = plan.branches.findIndex(b => b.id === branch.id);
  if (index < 0) throw new Error('Unknown branch presentation identity');
  return `分支 ${index + 1}｜${branch.name.replace(/[\r\n]/g, ' ')}`;
}
export function parallelDisplayPrompt(trial, plan = null, branch = null) {
  if (!trial) return '';
  const mapping = plan ? plan.branches.map(b => `${branchDisplayName(plan, b)}（${b.id}）`).join('；') : '';
  return [
    '个人并行文字展示试用：仅本次已核本人交办的并行工作适用。',
    `截止 ${trial.endsAt}；到期后的新输入和新投递恢复原展示，已投递文字保留。`,
    branch ? `本分支固定名称为「${branchDisplayName(plan, branch)}」。进展以「**${branchDisplayName(plan, branch)}进展**」开头，结果用同名“结果”标题。`
      : '仅试用期内新建、带有 displayTrial 的并行方案使用主副标题；创建分支前、无分支的普通工作不加。整体进展以「**主对话进展**」开头；涉及分支的内容另列「**分支 N｜名称进展**」。最终交付用“主对话结果”，分别保留需要说明的分支结论。',
    mapping ? `固定编号：${mapping}。不得按完成顺序改号。` : '编号按方案保存的分支顺序固定，多个方案同时存在时带上任务名，不能混用编号。',
    '一次只投递有新信息的部分，不重复未变化的分支，不为标题凑进度。分支结果未经验收写“待主对话验收”，失败、取消和缺口如实表达。',
    '保持现有 progress/reply 标签、进展卡折叠选择、发消息时机与投递位置；不新增周期消息、卡片、分支或通知。分支问题保留原生提问。普通问答和其他人的输入保持原样。',
  ].join('\n');
}
