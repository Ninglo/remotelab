import { watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createKeyedTaskQueue } from '../../chat/fs-utils.mjs';
import { CHAT_RECURRING_SCHEDULES_FILE, CHAT_TRIGGERS_FILE } from '../../lib/config.mjs';
import { createRecordStore } from '../../lib/durable-records.mjs';
import { buildFeishuTopicId } from './index.mjs';
import { buildProjectCard } from './project-card.mjs';
import { loadProjectSources, projectDigest, projectMemoryCorrection, projectPages,
  projectRequest, readProjectTask, readProjectView } from './project-sources.mjs';

const ACTIONS = new Set(['home', 'memory', 'tasks', 'audit', 'task', 'material', 'edit-help', 'pause', 'resume']);
const trim = value => typeof value === 'string' ? value.trim() : '';
const warn = error => console.warn(`[feishu-project] ${error.message}`);

export function parseProjectAction(raw) {
  const event = raw?.event || raw;
  let value = event?.action?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (value?.namespace !== 'project') return null;
  return { ...value, chatId: trim(event.context?.open_chat_id || event.context?.chat_id),
    messageId: trim(event.context?.open_message_id || event.context?.message_id),
    actor: trim(event.operator?.operator_id?.open_id || event.operator?.open_id),
    userId: trim(event.operator?.operator_id?.user_id || event.operator?.user_id),
    tenantKey: trim(event.tenant_key || raw?.header?.tenant_key) };
}

export function createProjectSurface(runtime, { request = runtime.requestRemoteLab,
  authorize = async () => false, watchFiles = true } = {}) {
  const root = join(runtime.config.storageDir, 'project-surfaces');
  const cards = createRecordStore(join(root, 'cards'));
  const actions = createRecordStore(join(root, 'actions'));
  const exclusive = createKeyedTaskQueue();
  const watchers = new Map();
  const activeRefreshes = new Set();
  let refreshTimer;
  let stopped = false;

  const keyFor = summary => projectDigest(`${summary.chatId}:${buildFeishuTopicId(summary) || 'main'}`);
  const getView = async record => {
    const view = await readProjectView(runtime, record.source.chatId, request);
    observe(view.source.memory.path);
    for (const material of view.source.materials) observe(material.path);
    for (const task of view.tasks) task.promptPages = projectPages(task.prompt || '未提供执行规则。');
    return view;
  };
  const auditFor = async projectId => (await actions.active()).filter(item => item.projectId === projectId)
    .sort((a, b) => a.at.localeCompare(b.at));

  async function publish(record, view, force = false) {
    const audit = await auditFor(view.source.link.projectId);
    // A fresh read time alone is not a content change.
    const digest = projectDigest({ tab: record.tab, page: record.page, alias: record.alias,
      notice: record.notice, source: view.source, memory: view.memory, tasks: view.tasks, materials: view.materials, audit });
    if (!force && record.messageId && digest === record.digest) return record;
    const card = buildProjectCard(record, view, audit);
    let messageId = record.messageId;
    if (messageId) {
      const result = await runtime.appClient.im.v1.message.patch({
        path: { message_id: messageId }, data: { content: JSON.stringify(card) },
      });
      if (result?.code && result.code !== 0) throw new Error('项目卡片更新失败，输入 /project 可重试。');
    } else {
      // Durable source + stable UUID allows the inbox to retry the same send.
      // A send with an uncertain outcome is never redirected to another source.
      const result = await runtime.appClient.im.v1.message.reply({
        path: { message_id: record.source.messageId }, data: { msg_type: 'interactive',
          content: JSON.stringify(card), reply_in_thread: !!record.source.threadId,
          uuid: `project-${record.key}` },
      });
      messageId = result?.data?.message_id;
      if (result?.code || !messageId) throw new Error('项目卡片发送未获回执，请重试原命令。');
    }
    return cards.mutate(record.key, current => ({ ...current, messageId, digest,
      projectId: view.source.link.projectId, readAt: view.readAt }));
  }

  async function command(summary, query = '') {
    const value = trim(query);
    const correction = value.match(/^memory\s+([\s\S]+)$/)?.[1];
    if (correction && !/^\d+$/.test(correction)) {
      return { taskText: await projectMemoryCorrection(runtime, summary, correction) };
    }
    const match = value.match(/^(home|memory|tasks|audit)?(?:\s+(\d+))?$/);
    const material = value.match(/^material ([a-z][a-z0-9-]{0,39})(?: (\d+))?$/);
    if (!material && (!match || (match[2] && match[1] !== 'memory'))) return {
      text: '用法：/project；/project memory [页码]；/project tasks；/project audit；/project material 材料短名 [页码]。\n补充或纠正记忆：/project memory 修改说明。',
    };
    // Read/validate registration before creating any delivery state.
    const source = await loadProjectSources(runtime, summary.chatId);
    if (material && !source.materials.some(item => item.alias === material[1])) return { text: '该材料没有登记到此项目。' };
    const key = keyFor(summary);
    return exclusive(key, async () => {
      const record = await cards.mutate(key, current => ({ ...current,
        source: current?.source || { chatId: summary.chatId, messageId: summary.messageId,
          threadId: buildFeishuTopicId(summary) },
        controlEpoch: current?.controlEpoch || 0,
        tab: material ? 'material' : match[1] || 'home', alias: material?.[1] || '',
        page: Math.max(0, Number((material ? material[2] : match[2]) || 1) - 1) }));
      const receipt = await publish(record, await getView(record), true);
      return { cardMessageId: receipt.messageId };
    });
  }

  async function validate(action) {
    if (!action || !ACTIONS.has(action.action) || !/^[a-f0-9]{24}$/.test(action.cardKey || '')
      || !action.actor || !action.messageId) throw new Error('项目操作无效。');
    const record = await cards.get(action.cardKey);
    if (!record?.messageId || action.chatId !== record.source.chatId
      || action.messageId !== record.messageId) throw new Error('请在项目原卡片中操作。');
    if (!await authorize({ chatId: action.chatId, tenantKey: action.tenantKey,
      sender: { senderType: 'user', openId: action.actor, userId: action.userId, tenantKey: action.tenantKey } })) {
      throw new Error('当前账号无法修改此项目入口。');
    }
    const source = await loadProjectSources(runtime, action.chatId);
    if (source.bindingVersion !== action.bindingVersion) throw new Error('项目关联已变更，请先用 /project 刷新。');
    if (['pause', 'resume', 'task'].includes(action.action)
      && !source.tasks.some(task => task.alias === action.alias)) throw new Error('该任务没有登记到此项目。');
    if (action.action === 'material' && !source.materials.some(item => item.alias === action.alias)) {
      throw new Error('该材料没有登记到此项目。');
    }
    if (['pause', 'resume'].includes(action.action)
      && (!/^[a-f0-9]{24}$/.test(action.taskVersion || '')
        || !Number.isInteger(action.controlEpoch))) throw new Error('任务操作版本缺失，请刷新。');
    if (action.page !== undefined && (!Number.isSafeInteger(action.page) || action.page < 0)) throw new Error('页码无效。');
    return { record, source };
  }

  async function actionFeedback(raw) {
    const action = parseProjectAction(raw);
    if (!action) return null;
    try {
      await validate(action);
      return { accepted: true, toast: { type: 'info', content: '正在核对并更新项目原卡。' } };
    } catch (error) { return { accepted: false, toast: { type: 'error',
      content: /^[\u3400-\u9fff]/.test(error.message) ? error.message : '项目来源暂时不可核实，请刷新后重试。' } }; }
  }

  async function control(record, source, action) {
    const operationKey = projectDigest(`${record.key}:${action.actor}:${action.action}:${action.alias}:`
      + `${action.controlEpoch}:${action.taskVersion}:${action.bindingVersion}`);
    const prior = await actions.get(operationKey);
    if (prior) return { ...record, notice: `该操作已有记录：${prior.result}。可查看“修改记录”。` };
    if (record.controlEpoch !== action.controlEpoch) return { ...record, notice: '卡片已被其他操作更新，已重新读取；请按当前状态操作。' };
    const registration = source.tasks.find(task => task.alias === action.alias);
    const current = await readProjectTask(request, registration);
    if (current.version !== action.taskVersion || !current.actions.includes(action.action)) {
      return { ...record, notice: '任务配置已发生变化，本次没有修改；已显示当前状态。' };
    }
    const desired = action.action === 'pause' ? 'paused' : 'active';
    const audit = { projectId: source.link.projectId, cardKey: record.key,
      at: new Date().toISOString(), actor: action.actor, label: `${action.alias} ${action.action === 'pause' ? '暂停' : '恢复'}；作用范围：${registration.scope}`,
      taskId: current.id, beforeVersion: current.version, desired,
      result: '已登记，等待执行与读回', status: 'pending' };
    await actions.mutate(operationKey, () => audit);
    let result;
    let status;
    try {
      await projectRequest(request, `/api/automation-tasks/${current.id}/${action.action}`, { method: 'POST', body: {} });
      const observed = await readProjectTask(request, registration);
      if (observed.state !== desired) throw new Error('读回状态与目标不一致');
      result = `已读回${desired === 'paused' ? '暂停' : '开启'}状态；正在执行的工作不受影响`;
      status = 'verified';
    } catch {
      result = '未取得一致的执行与读回结果；请刷新核对，不能当作已生效';
      status = 'uncertain';
    }
    await actions.mutate(operationKey, currentAudit => ({ ...currentAudit, result, status }));
    return { ...record, controlEpoch: record.controlEpoch + 1, tab: 'tasks', notice: `${audit.label}\n${result}` };
  }

  async function handleAction(raw) {
    const action = parseProjectAction(raw);
    if (!action) return null;
    return exclusive(action.cardKey, async () => {
      const { record, source } = await validate(action);
      const next = ['pause', 'resume'].includes(action.action)
        ? await control(record, source, action)
        : { ...record, tab: action.action, page: action.page || 0, alias: action.alias || '', notice: '' };
      await cards.mutate(record.key, () => next);
      return publish(await cards.get(record.key), await getView(record));
    });
  }

  function refresh() {
    if (stopped) return Promise.resolve();
    const work = refreshRecords();
    activeRefreshes.add(work);
    return work.finally(() => activeRefreshes.delete(work));
  }

  async function refreshRecords() {
    const records = await cards.active();
    await Promise.allSettled(records.filter(record => record.messageId).map(record => exclusive(record.key, async () => {
      const current = await cards.get(record.key);
      try { await publish(current, await getView(current)); }
      catch (error) {
        // Never leave a last-known-good card looking current after a source or
        // binding disappears. Keep the original delivery; do not send a copy.
        await runtime.appClient.im.v1.message.patch({ path: { message_id: current.messageId }, data: {
          content: JSON.stringify({ schema: '2.0', config: { update_multi: true },
            header: { title: { tag: 'plain_text', content: '项目入口当前不可核实' } },
            body: { elements: [{ tag: 'div', text: { tag: 'plain_text',
              content: '来源登记或运行状态不可读取。请修复来源后输入 /project；此卡片暂停提供操作。' } }] } }),
        } });
        await cards.mutate(current.key, record => ({ ...record, digest: '' }));
        warn(error);
      }
    })));
  }

  function observe(path) {
    if (stopped || !watchFiles || watchers.has(path)) return;
    const observer = watch(dirname(path), { persistent: false }, (_, filename) => {
      if (filename && String(filename) !== basename(path)) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { if (!stopped) void refresh().catch(warn); }, 150);
    });
    observer.on('error', warn);
    watchers.set(path, observer);
  }

  async function restore() {
    if (!runtime.config.projectSurfacesPath) return;
    observe(runtime.config.projectSurfacesPath);
    observe(CHAT_RECURRING_SCHEDULES_FILE);
    observe(CHAT_TRIGGERS_FILE);
    for (const link of runtime.config.projectLinks || []) {
      try { observe((await loadProjectSources(runtime, link.discussionChatId)).memory.path); }
      catch (error) { warn(error); }
    }
    // Interrupted actions are inspected without replaying a configuration write.
    for (const pending of (await actions.active()).filter(action => action.status === 'pending')) {
      try {
        const { task } = await projectRequest(request, `/api/automation-tasks/${pending.taskId}`);
        await actions.mutate(pending.key, current => ({ ...current,
          status: task?.state === pending.desired ? 'verified' : 'uncertain',
          result: task?.state === pending.desired ? '重启后读回目标状态；未重复执行操作'
            : '重启后未读回目标状态；未重复执行，请核对当前状态' }));
      } catch (error) { warn(error); }
    }
    await refresh();
  }

  return { command, actionFeedback, handleAction, refresh, restore,
    async stop() {
      stopped = true;
      clearTimeout(refreshTimer);
      for (const observer of watchers.values()) observer.close();
      await Promise.allSettled([...activeRefreshes]);
      await Promise.all([cards.idle(), actions.idle()]);
    } };
}
