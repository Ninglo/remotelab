import { buildExternalTriggerId, buildFeishuTopicId } from './index.mjs';
import { findFeishuThreadSessionBinding } from './session-flow.mjs';
import { resolveFeishuSessionMode } from './session-policy.mjs';
import { describeFeishuMuteSetting } from './conversation-settings.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';
const HELP = [
  '配置分为两级：Default 只影响新 Session，当前 Session 配置只影响当前 Session。',
  '/status — 查看当前范围的 Harness、模型和 Effort',
  '/default [harness|model|effort] [值] — 查看或修改新 Session 的 Default',
  '/harness [名称] — 查看或修改当前 Session 的 Harness',
  '/model [模型 ID] — 查看或修改当前 Session 的模型',
  '/effort [级别] — 查看或修改当前 Session 的 Effort',
  '/follow — 兼容别名：把当前 Session 重置为当前 Default',
  '/mute — 静默当前话题或聊天；明确 @ 可单次唤醒',
  '/unmute — 恢复当前话题或聊天的正常响应',
  '/fork — 群聊消息任意位置含此标记即新建任务话题，其余正文作为任务',
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

function describe(selection, _mode, scoped) {
  return [
    scoped ? '作用范围：当前 Session' : '作用范围：新 Session Default',
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

function sessionSelection(session, fallback) {
  if (!session) return null;
  const saved = session.feishuRuntimeSelection || session;
  return {
    tool: trim(saved.tool) || trim(fallback?.tool),
    model: trim(saved.model),
    effort: trim(saved.effort),
    thinking: saved.thinking === true,
  };
}

function defaultSelectionPayload(selection, catalog) {
  const reasoning = reasoningFor(catalog, selection.model);
  return {
    selectedTool: selection.tool,
    selectedModel: selection.model || '',
    selectedEffort: reasoning.kind === 'enum' ? (selection.effort || '') : '',
    reasoningKind: reasoning.kind,
  };
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
    const selected = sessionSelection(session, defaults) || defaults;
    // Switching away from a broken provider must not depend on its catalog.
    const catalog = ['default', 'harness', 'follow'].includes(type) ? null
      : await requestJson(request, `/api/models?tool=${encodeURIComponent(selected.tool)}`);
    let selection = catalog ? completeSelection(selected, catalog) : selected;
    if (type === 'status') return `${describe(selection, 'session', !!session)}\n${await describeFeishuMuteSetting(runtime, summary)}`;
    if (type === 'default') {
      if (!text) return describe(completeSelection(defaults, await requestJson(request, `/api/models?tool=${encodeURIComponent(defaults.tool)}`)), 'default', false);
      const [field, ...valueParts] = text.split(/\s+/);
      const value = trim(valueParts.join(' '));
      if (!['harness', 'model', 'effort'].includes(field) || !value) {
        return '用法：/default harness <名称>、/default model <模型 ID> 或 /default effort <级别>';
      }
      let defaultCatalog = await requestJson(request, `/api/models?tool=${encodeURIComponent(defaults.tool)}`);
      selection = completeSelection(defaults, defaultCatalog);
      if (field === 'harness') {
        const { tools = [] } = await requestJson(request, '/api/tools');
        if (!tools.some(tool => tool.id === value && tool.available)) return `Harness 不可用：${value}。用 /default harness 查看可用选项。`;
        defaultCatalog = await requestJson(request, `/api/models?tool=${encodeURIComponent(value)}`);
        selection = completeSelection({ tool: value }, defaultCatalog);
      } else if (field === 'model') {
        if (!defaultCatalog.models?.some(model => model.id === value)) return `当前 Default Harness 下模型不可用：${value}。\n${modelList(defaultCatalog)}`;
        selection = completeSelection({ ...selection, model: value, ...(value !== selection.model ? { effort: '', thinking: false } : {}) }, defaultCatalog);
      } else {
        const reasoning = reasoningFor(defaultCatalog, selection.model);
        if (reasoning.kind !== 'enum' || !reasoning.levels.includes(value)) return `当前 Default 模型不支持此思考强度：${value}。`;
        selection.effort = value;
      }
      plan = {
        scope: 'default',
        selection,
        defaultPayload: defaultSelectionPayload(selection, defaultCatalog),
        text: `已更新新 Session 的 Default。\n${describe(selection, 'default', false)}`,
      };
      await savePlan(plan);
    } else {
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
      plan = { scope: 'session', sessionId: session.id, selection,
        text: `${type === 'follow' ? '已将当前 Session 重置为 Default 当前值。' : '已更新当前 Session 配置。'}\n${describe(selection, 'session', true)}\n已接收的任务保持原配置。` };
      await savePlan(plan);
    }
  }
  if (plan.scope === 'default') {
    const result = await requestJson(request, '/api/runtime-selection', {
      method: 'POST', body: plan.defaultPayload || {
        selectedTool: plan.selection.tool,
        selectedModel: plan.selection.model || '',
        selectedEffort: plan.selection.effort || '',
        reasoningKind: plan.selection.effort ? 'enum' : 'none',
      },
    });
    if (!result.selection || result.selection.selectedTool !== plan.selection.tool) {
      throw new Error('RemoteLab did not persist the requested Default runtime selection');
    }
    return plan.text;
  }
  const { session } = await requestJson(request, `/api/sessions/${encodeURIComponent(plan.sessionId)}`, {
    method: 'PATCH', body: {
      tool: plan.selection.tool,
      model: plan.selection.model || '',
      effort: plan.selection.effort || '',
      thinking: plan.selection.thinking === true,
    },
  });
  const persisted = session?.feishuRuntimeSelection || session;
  if (persisted?.tool !== plan.selection.tool
    || (persisted?.model || '') !== (plan.selection.model || '')
    || (persisted?.effort || '') !== (plan.selection.effort || '')) {
    throw new Error('RemoteLab did not persist the requested Session runtime selection');
  }
  return plan.text;
}
