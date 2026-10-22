import { personalRoutingCardAction, personalRoutingCardView } from './personal-routing-card.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { groupProject, projectTopicRows } from './project-group-cards.mjs';
import { loadProjectMemoryRuntime } from '../../chat/project-memory-runtime.mjs';
import { groupReadingView } from '../../lib/project-reading.mjs';
import { effectiveFeishuGroup } from './group-settings.mjs';
import { join } from 'node:path';
import { createRecordStore, serialQueue } from '../../lib/durable-records.mjs';
import { completeRuntimeProfile, reasoningForRuntimeProfile } from '../../lib/runtime-profile.mjs';
import { prepareFeishuRuntimeCommandPlan, applyFeishuRuntimeCommandPlan } from './runtime-commands.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const trim = value => typeof value === 'string' ? value.trim() : '';

// One durable group prompt, reused by the real intake path and the Feishu UI.
// Runtime choices remain in the existing Session API, not a second settings copy.
export function createGroupConfigurationController(runtime, { request, resolveDefault, participation, authorize } = {}) {
  const records = createRecordStore(join(runtime.config.storageDir, 'group-configuration'));
  const queues = new Map();
  const keyFor = chatId => hash([runtime.config.sourceRouteId || 'default', chatId]);
  const exclusive = (chatId, fn) => {
    if (!queues.has(chatId)) queues.set(chatId, serialQueue());
    return queues.get(chatId)(fn);
  };
  const json = async (path, options) => {
    const result = await request(path, options);
    if (!result.response?.ok) throw new Error(result.json?.error || `配置读取失败（${result.response?.status}）`);
    return result.json;
  };
  async function reload(chatId) {
    const saved = await records.get(keyFor(chatId));
    if (saved) {
      runtime.config.groups ||= {};
      runtime.config.groups[chatId] = { ...runtime.config.groups[chatId],
        ...(Object.hasOwn(saved, 'systemPrompt') ? { systemPrompt: saved.systemPrompt } : {}),
        ...(Object.hasOwn(saved, 'selfReview') ? { selfReview: saved.selfReview === true,
          selfReviewRevision: saved.version } : {}) };
    }
    return saved;
  }
  async function view(record) {
    const chatId = record.source.chatId;
    const saved = await reload(chatId);
    let session = null;
    const disconnected = runtime.projectCardsConnected === false && runtime.projectCardSessions;
    if (disconnected) session = runtime.projectCardSessions.get(record.sessionId) || null;
    else if (record.sessionId) {
      const result = await request(`/api/sessions/${encodeURIComponent(record.sessionId)}`);
      if (result.response?.status !== 404) {
        if (!result.response?.ok) throw new Error(result.json?.error || '主讨论暂时无法读取，请稍后刷新。');
        session = result.json.session;
      }
    }
    const selected = session?.feishuRuntimeSelection || session || await resolveDefault();
    const tool = selected.tool || 'codex';
    runtime.projectCardCatalogs ||= new Map();
    const catalog = disconnected ? (runtime.projectCardCatalogs.get(tool) || { models: [] })
      : await json(`/api/models?tool=${encodeURIComponent(tool)}`);
    if (!disconnected) runtime.projectCardCatalogs.set(tool, catalog);
    const selection = completeRuntimeProfile(selected, catalog);
    const systemPrompt = runtime.config.groups?.[chatId]?.systemPrompt || '';
    const group = effectiveFeishuGroup(runtime.config, chatId);
    let project = null, reading = null;
    try {
      const { config } = await loadProjectMemoryRuntime();
      if (config?.readingPolicy) reading = groupReadingView(config, chatId, runtime.config.sourceRouteId);
      project = await groupProject(runtime, chatId);
      if (project?.briefPath) {
        const body = await readFile(project.briefPath, 'utf8');
        project.briefUpdated = body.match(/^更新时间[：:]\s*(.+)$/m)?.[1] || '';
      }
    } catch { project = { error: '登记的项目说明暂时无法读取，请核对原来源。' }; }
    const topics = projectTopicRows(runtime.projectCardSessions || new Map(), chatId, runtime.config.sourceRouteId);
    const boardPage = Math.min(runtime.groupBoardPages?.get(chatId) || 0, Math.max(0, Math.ceil(topics.length / 10) - 1));
    return { routingTrial: await personalRoutingCardView({ connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId, target: record.source }), project, reading, topics, boardPage, boardConnected: runtime.projectCardsConnected === true,
      participationControls: group.participationMode === 'ambient' && group.participationControls === true,
      responseMode: group.responseMode, selection, catalog, reasoning: reasoningForRuntimeProfile(catalog, selection.model), systemPrompt,
      selfReview: group.selfReview === true,
      sessionAvailable: Boolean(session), effectiveSystemPrompt: session?.systemPrompt || '',
      revision: hash([record.epoch, record.sessionId || '', selection, systemPrompt, group.selfReview === true, saved?.version || 0]),
      ...(session?.activeRunId ? { runningSelection: { tool: session.tool, model: session.model, effort: session.effort } } : {}),
      promptVersion: saved?.version || 0, updatedBy: saved?.updatedByName || (saved?.updatedBy ? '群成员' : '') };
  }
  async function action(raw) {
    const event = raw.event || raw;
    let value = event.action?.value;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    if (value?.namespace !== 'group-configuration') return null;
    const record = /^[a-f0-9]{24}$/.test(value.key || '') ? await participation().record(value.key) : null;
    const chatId = event.context?.open_chat_id || event.context?.chat_id;
    const messageId = event.context?.open_message_id || event.context?.message_id;
    const actor = event.operator?.operator_id?.open_id || event.operator?.open_id;
    const summary = { ...record?.source, chatId, messageId, chatType: 'group', chatMode: 'group', conversationKind: 'main',
      sender: { senderType: 'user', openId: actor }, eventId: raw.header?.event_id || event.event_id };
    if (!record || record.source.topicId || !actor || actor === runtime.botIdentity?.openId
        || record.source.chatId !== chatId || record.cardMessageId !== messageId || !await authorize(summary)) {
      return { toast: { type: 'error', content: '配置卡片已失效或无权操作。' } };
    }
    if (['parallel-on', 'parallel-off', 'parallel-status', 'routing-on', 'routing-off', 'routing-status'].includes(value.action)) {
      return personalRoutingCardAction(runtime, record, actor, value.action, summary.eventId);
    }
    if (!['refresh', 'board-page', 'model', 'effort', 'prompt', 'self-review-on', 'self-review-off'].includes(value.action)) return { toast: { type: 'error', content: '未知配置操作。' } };
    // Callback returns promptly; each group has one serial mutation queue.
    void exclusive(chatId, async () => {
      const latestRecord = await participation().state(summary);
      const current = await view(latestRecord);
      if (!['refresh', 'board-page'].includes(value.action) && value.revision !== current.revision) {
        await participation().publish(latestRecord);
        throw new Error('配置已被其他操作修改；已刷新卡片，请重新编辑。');
      }
      if (value.action === 'board-page') {
        if (!Number.isInteger(value.page) || value.page < 0 || value.page > 1000) throw new Error('无效页码');
        runtime.groupBoardPages ||= new Map(); runtime.groupBoardPages.set(chatId, value.page);
      }
      const fields = event.action?.form_value || {};
      if (value.action === 'self-review-on' || value.action === 'self-review-off') {
        const selfReview = value.action === 'self-review-on';
        await records.mutate(keyFor(chatId), previous => ({ ...previous, chatId, selfReview,
          version: (previous?.version || 0) + 1, updatedBy: actor,
          updatedByName: trim(event.operator?.name), updatedAt: new Date().toISOString(),
          history: [...(previous?.history || []), { action: value.action, eventId: summary.eventId,
            previousValue: current.selfReview, selfReview, actor, time: new Date().toISOString() }].slice(-20) }));
        await reload(chatId);
      } else if (value.action === 'model' || value.action === 'effort') {
        const chosen = trim(fields[value.action]);
        if (!chosen) throw new Error('请选择一个值后保存。');
        const plan = await prepareFeishuRuntimeCommandPlan(runtime, summary, [{ name: value.action, value: chosen }],
          { request, resolveDefault });
        if (plan.error) throw new Error(plan.text);
        if (plan.sessionId !== latestRecord.sessionId) throw new Error('主讨论绑定已变化，请刷新卡片。');
        await applyFeishuRuntimeCommandPlan(plan, { request });
      } else if (value.action === 'prompt') {
        if (!event.action?.form_value || typeof event.action.form_value !== 'object') throw new Error('请通过 prompt 表单提交修改。');
        if (!Number.isInteger(value.chunks) || value.chunks < 1 || value.chunks > 16) throw new Error('无效的 prompt 表单。');
        const parts = Array.from({ length: value.chunks }, (_, index) => fields[`prompt_${index}`] ?? '');
        if (parts.some(part => typeof part !== 'string' || part.length > 1000)) throw new Error('每段 prompt 最多 1000 字。');
        const systemPrompt = parts.join('');
        const saved = await reload(chatId);
        await records.mutate(keyFor(chatId), previous => ({ ...previous, chatId, systemPrompt,
          version: (saved?.version || 0) + 1, updatedBy: actor,
          updatedByName: trim(event.operator?.name), updatedAt: new Date().toISOString(),
          history: [...(previous?.history || []), { version: saved?.version || 0, systemPrompt: current.systemPrompt,
            replacedBy: actor, replacedAt: new Date().toISOString() }].slice(-20) }));
        await reload(chatId);
      }
      await participation().publish(await participation().state(summary));
    }).catch(async error => {
      console.warn(`[feishu-group-configuration] ${error.message}`);
      // A failed async callback must be visible on the same card, without an
      // extra group message or a false success toast.
      runtime.groupConfigurationErrors ||= new Map();
      runtime.groupConfigurationErrors.set(chatId, error.message);
      try { await participation().publish(await participation().state(summary)); } catch (publishError) {
        console.warn(`[feishu-group-configuration] error display failed: ${publishError.message}`);
      }
    });
    runtime.groupConfigurationErrors?.delete(chatId);
    return { toast: { type: 'info', content: '正在处理，保存后卡片显示生效值。' } };
  }
  async function restore() {
    for (const record of await records.active()) await reload(record.chatId);
  }
  return { reload, view: async record => ({ ...await view(record), error: runtime.groupConfigurationErrors?.get(record.source.chatId) }),
    action, restore, idle: async () => { await Promise.all([...queues.values()].map(queue => queue.idle())); await records.idle(); } };
}
