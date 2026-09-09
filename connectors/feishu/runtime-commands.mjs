import { buildExternalTriggerId, buildFeishuTopicId } from './index.mjs';
import { findFeishuThreadSessionBinding } from './session-flow.mjs';
import { resolveFeishuSessionMode } from './session-policy.mjs';
import { describeFeishuMuteSetting } from './conversation-settings.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';
const HELP = [
  '默认 Follow Web UI。选择 Harness、模型或思考强度后，当前会话固定使用这组配置；/follow 恢复跟随。',
  '/status — 查看下一条消息使用的配置',
  '/harness [名称] — 列出或选择可用 Harness',
  '/model [模型 ID] — 列出或选择当前 Harness 的模型',
  '/effort [级别] — 查看或选择模型支持的思考强度',
  '/follow — 恢复 Follow Web UI',
  '/mute — 静默当前话题或聊天；明确 @ 可单次唤醒',
  '/unmute — 恢复当前话题或聊天的正常响应',
  '/fork <任务文本> — 在群聊中新建任务话题',
  '/continue <任务文本> — 在群聊中继续会话',
  '/help — 查看命令',
  '配置命令在任务话题或私聊中修改当前会话。在群主时间线查看配置不会创建任务。',
].join('\n');

async function requestJson(request, path, options) {
  const result = await request(path, options);
  if (!result.response?.ok) throw new Error(result.json?.error || `RemoteLab request failed (${result.response?.status || 'unknown'})`);
  return result.json;
}

async function findCommandSession(runtime, summary, request) {
  const binding = await findFeishuThreadSessionBinding(runtime, summary);
  if (binding?.sessionId) {
    return (await requestJson(request, `/api/sessions/${encodeURIComponent(binding.sessionId)}`)).session;
  }
  // Only a stable private/continue conversation can be found without a binding.
  // Never infer the task from quoted messages or the most recently active task.
  if (buildFeishuTopicId(summary)
    || (['group', 'topic'].includes(summary.chatType) && resolveFeishuSessionMode(runtime.config, summary) !== 'continue')) return null;
  const { sessions = [] } = await requestJson(request, '/api/sessions');
  return sessions.find(session => !session.archived && session.externalTriggerId === buildExternalTriggerId(summary)) || null;
}

function reasoningFor(catalog, model) {
  return catalog.models?.find(item => item.id === model)?.reasoning || catalog.reasoning || { kind: 'none' };
}

function completeSelection(selection, catalog) {
  const model = trim(selection.model) || trim(catalog.defaultModel);
  const reasoning = reasoningFor(catalog, model);
  return { tool: selection.tool, model,
    effort: reasoning.kind === 'enum' ? trim(selection.effort) || trim(reasoning.default) : '',
    thinking: selection.thinking === true };
}

function describe(selection, mode, scoped) {
  return [
    scoped ? '作用范围：当前会话（下一条消息）' : '作用范围：新会话默认配置',
    `模式：${mode === 'ui' ? 'Follow Web UI' : '固定配置'}`,
    `Harness：${selection.tool}`,
    `Model：${selection.model || 'Harness 默认'}`,
    `Effort：${selection.effort || '不适用'}`,
  ].join('\n');
}

function modelList(catalog) {
  const models = catalog.models || [];
  return models.length ? models.slice(0, 40).map(model => `/model ${model.id}`).join('\n')
    + (models.length > 40 ? `\n共 ${models.length} 个模型，以上显示前 40 个；也可以直接输入完整模型 ID。` : '')
    : '当前 Harness 未提供可选模型。';
}

export async function handleFeishuRuntimeCommand(runtime, summary, command, {
  request, resolveDefault, prepared = null, savePlan = async () => {},
}) {
  let plan = prepared;
  if (!plan) {
    const { type, text } = command;
    if (type === 'help') return text ? '用法：/help' : HELP;
    if (['status', 'follow'].includes(type) && text) return `用法：/${type}`;
    const session = await findCommandSession(runtime, summary, request);
    const defaults = await resolveDefault();
    const override = session?.feishuRuntimeSelection;
    const selected = override || defaults;
    // Switching away from a broken provider must not depend on its catalog.
    const catalog = ['harness', 'follow'].includes(type) ? null
      : await requestJson(request, `/api/models?tool=${encodeURIComponent(selected.tool)}`);
    let selection = catalog ? completeSelection(selected, catalog) : selected;
    if (type === 'status') return `${describe(selection, override ? 'pinned' : defaults.mode, !!session)}\n${await describeFeishuMuteSetting(runtime, summary)}`;
    if (type === 'harness' && !text) {
      const { tools = [] } = await requestJson(request, '/api/tools');
      return `当前 Harness：${selection.tool}\n${tools.filter(tool => tool.available).map(tool => `/harness ${tool.id}`).join('\n')}`;
    }
    if (type === 'model' && !text) return `当前 Model：${selection.model || 'Harness 默认'}\n${modelList(catalog)}`;
    if (type === 'effort' && !text) {
      const reasoning = reasoningFor(catalog, selection.model);
      return reasoning.kind === 'enum'
        ? `当前 Effort：${selection.effort}\n${reasoning.levels.map(level => `/effort ${level}`).join('\n')}`
        : '当前模型不支持选择思考强度。';
    }
    if (!session || session.archived) return '请在已有任务话题或私聊会话中执行此命令；可先用 /fork <任务文本> 在群聊中创建任务。';
    if (type === 'follow') {
      const defaultCatalog = await requestJson(request, `/api/models?tool=${encodeURIComponent(defaults.tool)}`);
      selection = completeSelection(defaults, defaultCatalog);
    } else if (type === 'harness') {
      const { tools = [] } = await requestJson(request, '/api/tools');
      if (!tools.some(tool => tool.id === text && tool.available)) return `Harness 不可用：${text}。用 /harness 查看可用选项。`;
      const nextCatalog = await requestJson(request, `/api/models?tool=${encodeURIComponent(text)}`);
      selection = completeSelection(text === selected.tool ? selected : { tool: text }, nextCatalog);
    } else if (type === 'model') {
      if (!catalog.models?.some(model => model.id === text)) return `当前 Harness 下模型不可用：${text}。\n${modelList(catalog)}`;
      selection = completeSelection({ ...selection, model: text, ...(text !== selection.model ? { effort: '', thinking: false } : {}) }, catalog);
    } else if (type === 'effort') {
      const reasoning = reasoningFor(catalog, selection.model);
      if (reasoning.kind !== 'enum' || !reasoning.levels.includes(text)) return `当前模型不支持此思考强度：${text}。用 /effort 查看可用选项。`;
      selection.effort = text;
    }
    plan = { sessionId: session.id, selection: type === 'follow' ? null : selection,
      text: `${type === 'follow' ? '已恢复默认跟随设置。' : '已固定当前会话配置。'}\n${describe(selection, type === 'follow' ? defaults.mode : 'pinned', true)}\n已接收的任务保持原配置。` };
    await savePlan(plan);
  }
  const { session } = await requestJson(request, `/api/sessions/${encodeURIComponent(plan.sessionId)}`, {
    method: 'PATCH', body: { feishuRuntimeSelection: plan.selection },
  });
  if (JSON.stringify(session?.feishuRuntimeSelection || null) !== JSON.stringify(plan.selection)) {
    throw new Error('RemoteLab did not persist the requested Feishu runtime selection');
  }
  return plan.text;
}
