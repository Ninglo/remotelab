import { buildExternalTriggerId, buildFeishuTopicId } from './index.mjs';
import { findFeishuThreadSessionBinding } from './session-flow.mjs';
import { resolveFeishuSessionMode } from './session-policy.mjs';
import { describeFeishuMuteSetting } from './conversation-settings.mjs';
import { isQuickSession } from '../../lib/quick-session-profile.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';
const CONFIG_COMMANDS = new Set(['default', 'harness', 'model', 'effort', 'follow']);
const HELP = [
  '任务命令可把正文写在同行：/fork [修饰参数] 正文、/continue [修饰参数] 正文、/quick 正文。',
  '/fork 和 /continue 的修饰参数：--harness <名称>、--model <模型 ID>、--effort <级别>；仍兼容旧的多行命令块。',
  '短名：/f fork、/c continue、/m model、/q quick。',
  '/status — 查看当前范围的 Harness、模型和 Effort',
  '/default [harness|model|effort] [值] — 查看或修改新 Session 的 Default',
  '/harness [名称] — 查看或修改当前任务使用的 Harness',
  '/model [模型 ID] — 查看或修改当前任务使用的模型',
  '/effort [级别] — 查看或修改当前任务的 Effort',
  '/follow — 把当前 Session 重置为当前 Default',
  '/mute — 静默当前话题或聊天；明确 @ 可单次唤醒',
  '/unmute — 恢复当前话题或聊天的正常响应',
  '/fork [修饰参数] 正文 — 新建任务',
  '/quick 正文 — 新建 Quick Session；整个会话固定为快速问答模式',
  '/continue [修饰参数] 正文 — 继续当前任务',
  '/help — 查看命令',
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

function describe(selection, scoped) {
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

function normalizeCommands(commands) {
  return (Array.isArray(commands) ? commands : []).map(command => ({
    name: trim(command?.name || command?.type).toLowerCase(),
    field: trim(command?.field),
    value: trim(command?.value || command?.text),
  }));
}

function validateCommandSet(commands) {
  const seen = new Set();
  let hasQuery = false;
  let hasMutation = false;
  for (const command of commands) {
    if (!command.name) return '命令名称不能为空。';
    if (['help', 'status'].includes(command.name)) hasQuery = true;
    if (CONFIG_COMMANDS.has(command.name) || ['mute', 'unmute'].includes(command.name)) hasMutation = true;
    const key = command.name === 'default' ? `default:${command.field}` : command.name;
    if (seen.has(key)) return `命令重复：/${command.name}。同一字段一条消息只能设置一次。`;
    seen.add(key);
  }
  if (hasQuery && hasMutation) return '/help 或 /status 不能和配置变更放在同一个命令块中。';
  if (commands.some(command => command.name === 'fork') && commands.some(command => command.name === 'continue')) {
    return '/fork 和 /continue 不能同时使用。';
  }
  if (commands.some(command => command.name === 'quick')
    && commands.some(command => ['fork', 'continue', 'default', 'harness', 'model', 'effort', 'follow'].includes(command.name))) {
    return '/quick 需要单独使用，不能和任务或运行时配置命令组合。';
  }
  if (commands.some(command => command.name === 'follow')
    && commands.some(command => ['harness', 'model', 'effort'].includes(command.name))) {
    return '/follow 不能和 /harness、/model、/effort 同时使用。';
  }
  return '';
}

/** Build a complete, side-effect-free runtime command plan. */
export async function prepareFeishuRuntimeCommandPlan(runtime, summary, rawCommands, {
  request, resolveDefault, taskMode = false,
} = {}) {
  const commands = normalizeCommands(rawCommands);
  const validationError = validateCommandSet(commands);
  if (validationError) return { error: validationError, text: validationError, operations: [] };

  const getCatalog = async tool => requestJson(request, `/api/models?tool=${encodeURIComponent(tool)}`);
  const catalogs = new Map();
  const catalogFor = async tool => {
    if (!catalogs.has(tool)) catalogs.set(tool, await getCatalog(tool));
    return catalogs.get(tool);
  };
  const defaults = await resolveDefault();
  const session = summary?.forkCommand ? null : await findCommandSession(runtime, summary, request);
  let defaultCatalog = null;
  let defaultSelection = null;
  const ensureDefault = async () => {
    if (!defaultCatalog) {
      defaultCatalog = await catalogFor(defaults.tool);
      defaultSelection = completeSelection(defaults, defaultCatalog);
    }
    return defaultSelection;
  };
  let selection = sessionSelection(session, defaults) || { ...defaults };
  let catalog = null;
  const operations = [];
  const notes = [];

  const mutatesSessionRuntime = commands.some(command => command.name === 'follow'
    || (['harness', 'model', 'effort'].includes(command.name) && command.value));
  if (isQuickSession(session) && mutatesSessionRuntime) {
    const text = 'Quick Session 的 Harness、模型和 Effort 在创建时固定；请新建 Standard Session。';
    return { error: text, text, operations: [] };
  }

  for (const command of commands) {
    if (command.name === 'help') {
      notes.push(HELP);
      continue;
    }
    if (command.name === 'status') {
      if (isQuickSession(session)) {
        notes.push(`模式：Quick（创建后固定）\n${await describeFeishuMuteSetting(runtime, summary)}`);
        continue;
      }
      catalog = catalog || await catalogFor(selection.tool);
      selection = completeSelection(selection, catalog);
      notes.push(`${describe(selection, Boolean(session))}\n${await describeFeishuMuteSetting(runtime, summary)}`);
      continue;
    }
    if (command.name === 'default') {
      await ensureDefault();
      if (!command.field) {
        notes.push(describe(defaultSelection, false));
        continue;
      }
      if (command.field === 'harness') {
        const { tools = [] } = await requestJson(request, '/api/tools');
        if (!tools.some(tool => tool.id === command.value && tool.available)) {
          return { error: `Harness 不可用：${command.value}。`, text: `Harness 不可用：${command.value}。`, operations: [] };
        }
        const nextCatalog = await catalogFor(command.value);
        defaultCatalog = nextCatalog;
        defaultSelection = completeSelection({ tool: command.value }, nextCatalog);
      } else if (command.field === 'model') {
        if (!defaultCatalog.models?.some(model => model.id === command.value)) {
          return { error: `当前 Default Harness 下模型不可用：${command.value}。`, text: `当前 Default Harness 下模型不可用：${command.value}。\n${modelList(defaultCatalog)}`, operations: [] };
        }
        defaultSelection = completeSelection({ ...defaultSelection, model: command.value,
          ...(command.value !== defaultSelection.model ? { effort: '', thinking: false } : {}) }, defaultCatalog);
      } else {
        const defaultReasoning = reasoningFor(defaultCatalog, defaultSelection.model);
        if (defaultReasoning.kind !== 'enum' || !defaultReasoning.levels.includes(command.value)) {
          return { error: `当前 Default 模型不支持此思考强度：${command.value}。`, text: `当前 Default 模型不支持此思考强度：${command.value}。`, operations: [] };
        }
        defaultSelection.effort = command.value;
      }
      if (taskMode && !session) {
        selection = { ...defaultSelection };
        catalog = await catalogFor(selection.tool);
      }
      continue;
    }
    if (!CONFIG_COMMANDS.has(command.name)) continue;
    if (!session && !taskMode && (command.name === 'follow' || command.value)) {
      return { error: '请在已有任务话题或私聊会话中执行此命令；也可以把命令块和任务正文放在同一条消息中。',
        text: '请在已有任务话题或私聊会话中执行此命令；也可以把命令块和任务正文放在同一条消息中。', operations: [] };
    }
    if (command.name === 'follow') {
      selection = completeSelection(await ensureDefault(), await catalogFor((await ensureDefault()).tool));
      catalog = await catalogFor(selection.tool);
      continue;
    }
    if (command.name === 'harness') {
      const { tools = [] } = await requestJson(request, '/api/tools');
      if (!command.value) {
        notes.push(`当前 Harness：${selection.tool}\n${tools.filter(tool => tool.available).map(tool => `/harness ${tool.id}`).join('\n')}`);
        continue;
      }
      if (!tools.some(tool => tool.id === command.value && tool.available)) {
        return { error: `Harness 不可用：${command.value}。`, text: `Harness 不可用：${command.value}。`, operations: [] };
      }
      const nextCatalog = await catalogFor(command.value);
      selection = completeSelection(command.value === selection.tool ? selection : { tool: command.value }, nextCatalog);
      catalog = nextCatalog;
      continue;
    }
    if (command.name === 'model') {
      catalog = catalog || await catalogFor(selection.tool);
      selection = completeSelection(selection, catalog);
      if (!command.value) {
        notes.push(`当前 Model：${selection.model || 'Harness 默认'}\n${modelList(catalog)}`);
        continue;
      }
      if (!catalog.models?.some(model => model.id === command.value)) {
        return { error: `当前 Harness 下模型不可用：${command.value}。`, text: `当前 Harness 下模型不可用：${command.value}。\n${modelList(catalog)}`, operations: [] };
      }
      selection = completeSelection({ ...selection, model: command.value,
        ...(command.value !== selection.model ? { effort: '', thinking: false } : {}) }, catalog);
      continue;
    }
    if (command.name === 'effort') {
      catalog = catalog || await catalogFor(selection.tool);
      selection = completeSelection(selection, catalog);
      if (!command.value) {
        const reasoning = reasoningFor(catalog, selection.model);
        notes.push(reasoning.kind === 'enum'
          ? `当前 Effort：${selection.effort}\n${reasoning.levels.map(level => `/effort ${level}`).join('\n')}`
          : '当前模型不支持选择思考强度。');
        continue;
      }
      const reasoning = reasoningFor(catalog, selection.model);
      if (reasoning.kind !== 'enum' || !reasoning.levels.includes(command.value)) {
        return { error: `当前模型不支持此思考强度：${command.value}。`, text: `当前模型不支持此思考强度：${command.value}。`, operations: [] };
      }
      selection.effort = command.value;
    }
  }

  if (commands.some(command => command.name === 'default' && command.field)) {
    await ensureDefault();
    operations.push({ scope: 'default', selection: defaultSelection,
      defaultPayload: defaultSelectionPayload(defaultSelection, await catalogFor(defaultSelection.tool)) });
  }
  if (session && commands.some(command => command.name === 'follow'
    || (['harness', 'model', 'effort'].includes(command.name) && command.value))) {
    operations.push({ scope: 'session', sessionId: session.id, selection });
  }
  if (notes.length === 0 && operations.length > 0) {
    const defaultOperation = operations.find(operation => operation.scope === 'default');
    const sessionOperation = operations.find(operation => operation.scope === 'session');
    const followed = commands.some(command => command.name === 'follow');
    if (defaultOperation) notes.push(`已更新新 Session 的 Default。\n${describe(defaultSelection, false)}`);
    if (sessionOperation) notes.push(`${followed ? '已将当前 Session 重置为 Default 当前值。' : '已更新当前 Session 配置。'}\n${describe(selection, true)}`);
  }
  return { commands, operations, selection, sessionId: session?.id || '', text: notes.join('\n\n') || HELP };
}

export async function applyFeishuRuntimeCommandPlan(plan, { request } = {}) {
  for (const operation of plan.operations || []) {
    if (operation.scope === 'default') {
      const result = await requestJson(request, '/api/runtime-selection', { method: 'POST', body: operation.defaultPayload });
      if (!result.selection || result.selection.selectedTool !== operation.selection.tool) throw new Error('RemoteLab did not persist the requested Default runtime selection');
      continue;
    }
    const { session } = await requestJson(request, `/api/sessions/${encodeURIComponent(operation.sessionId)}`, {
      method: 'PATCH', body: {
        tool: operation.selection.tool, model: operation.selection.model || '', effort: operation.selection.effort || '', thinking: operation.selection.thinking === true,
      },
    });
    const persisted = session?.feishuRuntimeSelection || session;
    if (persisted?.tool !== operation.selection.tool || (persisted?.model || '') !== (operation.selection.model || '')
      || (persisted?.effort || '') !== (operation.selection.effort || '')) throw new Error('RemoteLab did not persist the requested Session runtime selection');
  }
  return plan.text;
}

export async function handleFeishuRuntimeCommands(runtime, summary, commands, options) {
  const { request, savePlan = async () => {}, prepared = null } = options;
  const plan = prepared || await prepareFeishuRuntimeCommandPlan(runtime, summary, commands, options);
  if (plan.error) return plan.text;
  if (!prepared) await savePlan(plan);
  return applyFeishuRuntimeCommandPlan(plan, { request });
}

export async function handleFeishuRuntimeCommand(runtime, summary, command, options) {
  return handleFeishuRuntimeCommands(runtime, summary, [{
    name: command.type, ...(command.type === 'default' && command.text ? (() => {
      const [field, value] = command.text.split(/\s+/);
      return { field, value };
    })() : { value: command.text }),
  }], options);
}

export { HELP };
