import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { canonicalJson, readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { loadAuthDocument, findIdentity } from '../lib/auth-config.mjs';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { requests } from './requests.mjs';
import { createSession, getSession } from './session-manager.mjs';
import { findSessionByExternalTriggerId } from './session-meta-store.mjs';
import { updateSessionConversation } from './session-conversations.mjs';
import { createTrigger, getTrigger, updateTrigger, cancelScheduleTriggers, stopTriggerExecution } from './triggers.mjs';
import { createRecurringSchedule, getRecurringSchedule, updateRecurringSchedule, normalizeRecurringCadence } from './recurring-schedules.mjs';
import { getAutomationTask } from './automation-tasks.mjs';
import { enqueueSourceDelivery } from './source-deliveries.mjs';
import { appendEvent } from './history.mjs';

// Confirmation is a receipt for an existing native task, not a second scheduler.
// The core is the sole writer; connectors submit verified provider callbacks.
const queue = createKeyedTaskQueue();
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 24);
const trim = value => typeof value === 'string' ? value.trim() : '';
const now = () => new Date().toISOString();
const pathFor = key => {
  if (!/^[a-f0-9]{24}$/.test(key)) throw Error('Invalid automation confirmation key');
  return join(CONFIG_DIR, 'automation-confirmations', `${key}.json`);
};
const save = record => writeDurableJson(pathFor(record.key), record);
const rawTask = record => record.taskId.startsWith('sch_') ? getRecurringSchedule(record.taskId) : getTrigger(record.taskId);
const updateTask = (record, patch, options) => record.taskId.startsWith('sch_')
  ? updateRecurringSchedule(record.taskId, patch, options) : updateTrigger(record.taskId, patch, options);
const definitionHash = task => hash([task.title, task.text, task.scheduledAt || '', task.cadence || null,
  task.lifetime || null, task.gate || null, task.wakeOn || null, task.automationPolicy || null, task.alerts || null,
  task.sessionTemplate, task.runtimePolicy, task.tool, task.model, task.effort, task.thinking]);

export function automationTopicUrl(target) {
  const topic = target?.threadId || target?.rootId || target?.messageId;
  return topic ? `https://applink.feishu.cn/client/thread/open?open_chat_id=${encodeURIComponent(target.chatId)}&open_thread_id=${encodeURIComponent(topic)}` : '';
}

export async function readAutomationConfirmation(key) {
  const record = await readRecord(pathFor(key));
  if (!record) throw Error('找不到这条自动化。');
  const task = record.taskId ? await getAutomationTask(record.taskId) : null;
  return { ...record, task };
}

async function publish(record, surface) {
  const entry = surface === 'entry';
  const plan = entry ? record.entryPlan : record.sourcePlan;
  if (!plan) return null;
  return enqueueSourceDelivery({ sessionId: entry ? record.executionSessionId : record.sourceSessionId,
    responseId: `automation-card:${record.key}:${surface}:${record.revision}`,
    sourceDelivery: plan, text: `${record.definition.title} · 自动化`,
    automationControl: { key: record.key, surface } });
}

function taskDefinition(input) {
  const definition = {
    kind: trim(input.kind), title: trim(input.title), text: trim(input.text),
    output: trim(input.output), cost: trim(input.cost) || '暂无实测', details: trim(input.details),
    ...(input.kind === 'recurring' ? (input.cron
      ? { cron: trim(input.cron), timezone: trim(input.timezone) || 'Asia/Shanghai' }
      : { everySeconds: input.everySeconds }) : { scheduledAt: trim(input.scheduledAt) }),
  };
  if (!['recurring', 'one_time'].includes(definition.kind) || !definition.title || !definition.text || !definition.output) {
    throw Error('kind、title、text 和 output 必填。');
  }
  if (definition.text.length > 16000 || definition.details.length > 6000 || definition.title.length > 100
    || definition.output.length > 500 || definition.cost.length > 300
    || Buffer.byteLength(JSON.stringify(definition), 'utf8') > 20000) throw Error('任务说明过长，请保留执行需要的内容，完整资料使用原文链接。');
  if (definition.kind === 'recurring') normalizeRecurringCadence(definition, { strict: true });
  else if (!Number.isFinite(Date.parse(definition.scheduledAt))) throw Error('执行时间无效。');
  return definition;
}

export async function proposeAutomationConfirmation(input) {
  const sourceSessionId = trim(input.sourceSessionId), sourceRequestId = trim(input.sourceRequestId);
  if (!trim(input.key) || input.key.length > 200) throw Error('请提供同一任务重试时不变的 key。');
  const definition = taskDefinition(input);
  const source = await requests.byRequest(sourceSessionId, sourceRequestId);
  const plan = source?.deliveryPlan || source?.options?.sourceDelivery;
  const identityId = source?.options?.initiatedByIdentityId;
  const auth = await loadAuthDocument({ persistMigration: false });
  const owner = findIdentity(auth, identityId);
  if (!source?.options?.feishuConnectorAuthenticated || source.options.internalOperation
    || source.options.deliveryOnly || plan?.connector !== 'feishu' || !plan.target?.chatId
    || !plan.target?.tenantKey || plan.target?.commentId || owner?.identity?.kind !== 'feishu'
    || owner.identity.realm !== plan.sourceRouteId) throw Error('需要原交办人的已核飞书输入和消息目标。');
  const session = await getSession(sourceSessionId);
  if (!session || session.archived) throw Error('原交办会话不可用。');
  const key = hash([sourceSessionId, sourceRequestId, input.key]);
  return queue(key, async () => {
    let record = await readRecord(pathFor(key));
    if (record && canonicalJson(record.definition) !== canonicalJson(definition)) throw Error('这张确认卡的定义已固定；修改后请用新 key 发新卡，并取消旧任务。');
    if (!record) {
      if (definition.kind === 'one_time' && Date.parse(definition.scheduledAt) <= Date.now()) throw Error('执行时间必须在未来。');
      record = { key, revision: 1, phase: 'pending', definition, sourceSessionId, sourceRequestId,
        sourcePlan: plan, identityId, personId: owner.person.id, ownerOpenId: owner.identity.subjectId,
        createdAt: now(), cards: [], taskId: `${definition.kind === 'recurring' ? 'sch' : 'trg'}_${key}` };
      await save(record);
    }
    if (!record.executionSessionId) {
      const externalTriggerId = `automation-fixed:${key}`;
      const existing = await findSessionByExternalTriggerId(externalTriggerId);
      const dedicated = existing || await createSession(session.folder, session.tool, definition.title, {
        externalTriggerId, initiatedByIdentityId: record.identityId, viewPersonId: record.personId,
        model: session.model, effort: session.effort, thinking: session.thinking,
        group: '自动化任务', internalRole: 'scheduled_execution', sessionCollection: 'automations',
        description: `自动化 ${record.taskId}；来源 ${sourceSessionId}`,
        systemPrompt: `这条固定会话承接同一自动化的执行、纠正和故障修复。\n任务：${definition.title}\n${definition.text}\n输出：${definition.output}\n${definition.details}\n原交办：${automationTopicUrl(plan.target)}\n任务 ID：${record.taskId}\n来源会话：${sourceSessionId}；来源输入：${sourceRequestId}\n未来规则的纠正须写回任务定义或现行资料；不要只作口头承诺。上下文由 Harness 原生压缩，旧日志按需读取。`,
      });
      record.executionSessionId = dedicated.id;
      await save(record);
    }
    if (!await rawTask(record)) {
      const template = { folder: session.folder, tool: session.tool, reuse: 'fixed_session',
        sessionId: record.executionSessionId, sessionCollection: 'automations' };
      const create = definition.kind === 'recurring' ? createRecurringSchedule : createTrigger;
      const task = await create({ ...definition, sourceSessionId, createdByIdentityId: record.identityId,
        sessionTemplate: template, tool: session.tool, model: session.model, effort: session.effort, thinking: session.thinking },
      { id: record.taskId, paused: true });
      record.definitionHash = definitionHash(task);
      await save(record);
    } else if (!record.definitionHash) {
      record.definitionHash = definitionHash(await rawTask(record));
      await save(record);
    }
    await publish(record, 'source');
    return readAutomationConfirmation(key);
  });
}

function requireCardActor(record, action) {
  if (action.sourceRouteId !== record.sourcePlan.sourceRouteId || action.tenantKey !== record.sourcePlan.target.tenantKey
    || action.openId !== record.ownerOpenId || !record.cards.some(c => c.messageId === action.messageId && c.chatId === action.chatId)) {
    throw Error('请由这条自动化的交办人在原卡片操作。');
  }
}

export async function actOnAutomationConfirmation(key, action) {
  return queue(key, async () => {
    const record = await readRecord(pathFor(key));
    if (!record) throw Error('找不到这条自动化。');
    requireCardActor(record, action);
    if (!['confirm', 'stop', 'refresh', 'details'].includes(action.action)) throw Error('未知操作。');
    let task = await rawTask(record);
    if (!task) throw Error('自动化任务已不存在。');
    if (action.action === 'confirm') {
      if (['stopping', 'stopped'].includes(record.phase) || task.status === 'cancelled') throw Error('任务已停止，不能从旧卡片重新启用。');
      if (record.phase === 'pending') {
        if (definitionHash(task) !== record.definitionHash || task.status !== 'paused') throw Error('任务内容或状态已经修改，请重新确认最新任务。');
        if (record.definition.kind === 'one_time' && Date.parse(task.scheduledAt) <= Date.now()) throw Error('原执行时间已过，请修改时间后重新确认。');
        record.phase = 'confirming'; record.confirmedAt = now(); record.revision++;
        record.confirmation = { eventId: trim(action.eventId), messageId: action.messageId, identityId: record.identityId };
        const target = record.sourcePlan.target;
        record.entryPlan = { connector: 'feishu', sourceRouteId: record.sourcePlan.sourceRouteId,
          target: { chatId: target.chatId, tenantKey: target.tenantKey, chatType: target.chatType || 'group',
            conversationKind: 'thread', chatMode: target.chatMode || 'group', replyInThread: true } };
        await save(record); // Consent precedes all activation; replay cannot invent it.
        await appendEvent(record.executionSessionId, { type: 'automation_confirmation', content: '交办人在卡片确认启用。',
          taskId: record.taskId, identityId: record.identityId, sourceRequestId: record.sourceRequestId, ...record.confirmation });
      }
      if (record.phase === 'confirming') await publish(record, 'entry');
    } else if (action.action === 'stop') {
      if (record.phase !== 'stopped') { record.phase = 'stopping'; record.revision++; await save(record); }
      // Retry reconciles partial cancellation, including after a process restart.
      if (record.taskId.startsWith('sch_')) {
        await updateTask(record, { status: 'cancelled' });
        record.cancellation = await cancelScheduleTriggers(record.taskId, { includeActive: true });
      } else record.cancellation = await stopTriggerExecution(record.taskId);
      record.phase = 'stopped'; record.stoppedAt = now(); record.revision++;
      await save(record);
    } else {
      if (action.action === 'details') record.expanded = action.expanded === true;
      record.revision++;
    }
    await save(record);
    await publish(record, 'source');
    if (record.entryTarget) await publish(record, 'entry');
    return readAutomationConfirmation(key);
  });
}

// Called only after the connector read back a real card. Entry receipt/binding
// must exist before the paused task becomes eligible for its first trigger.
export async function recordAutomationCardReceipt(key, receipt) {
  return queue(key, async () => {
    const record = await readRecord(pathFor(key));
    if (!record || receipt.sourceRouteId !== record.sourcePlan.sourceRouteId
      || receipt.chatId !== record.sourcePlan.target.chatId || !trim(receipt.messageId)
      || !['source', 'entry'].includes(receipt.surface)) throw Error('卡片回执不匹配。');
    if (!record.cards.some(c => c.messageId === receipt.messageId)) record.cards.push({
      messageId: receipt.messageId, chatId: receipt.chatId, surface: receipt.surface });
    if (receipt.surface === 'entry') {
      if (!record.confirmedAt) throw Error('任务尚未确认。');
      record.entryTarget ||= { ...record.entryPlan.target, messageId: receipt.messageId,
        rootId: receipt.messageId, threadId: receipt.threadId || receipt.messageId, replyInThread: true };
      record.entryPlan = { ...record.entryPlan, target: record.entryTarget };
      await updateSessionConversation(record.executionSessionId, record.entryPlan);
      if (record.phase === 'confirming') {
        const task = await rawTask(record);
        if (task.status === 'cancelled') { record.phase = 'stopped'; }
        else {
          const activating = { ...task.sessionTemplate, conversation: record.entryPlan };
          const validateCurrent = current => {
            const { conversation, ...withoutConversation } = current.sessionTemplate;
            const original = definitionHash(current) === record.definitionHash && current.status === 'paused';
            const applied = canonicalJson(conversation) === canonicalJson(record.entryPlan)
              && definitionHash({ ...current, sessionTemplate: withoutConversation }) === record.definitionHash
              && ['active', 'pending', 'delivering', 'delivered', 'completed'].includes(current.status);
            if (!original && !applied) throw Error('确认后的任务定义发生变化，尚未启用，请重新确认。');
          };
          validateCurrent(task);
          if (task.status === 'paused') {
            if (record.taskId.startsWith('sch_')) await updateTask(record,
              { sessionTemplate: activating, status: 'active' }, { validateCurrent });
            else await updateTask(record, { status: 'pending' },
              { validateCurrent, confirmedConversation: record.entryPlan });
          }
          record.phase = 'active'; record.activatedAt = now();
        }
        record.revision++;
      }
    }
    await save(record);
    if (receipt.surface === 'entry') await publish(record, 'source');
    return readAutomationConfirmation(key);
  });
}
