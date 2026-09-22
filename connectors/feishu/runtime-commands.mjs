import { buildExternalTriggerId } from './index.mjs';
import { findFeishuThreadSessionBinding } from './session-flow.mjs';
import { buildFeishuSessionConversationTarget, isFeishuThreadConversation } from './reply-routing.mjs';
import { describeFeishuMuteSetting } from './conversation-settings.mjs';
import { isQuickSession } from '../../lib/quick-session-profile.mjs';
import {
  completeRuntimeProfile,
  reasoningForRuntimeProfile,
} from '../../lib/runtime-profile.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';
const CONFIG_COMMANDS = new Set(['harness', 'model', 'effort', 'tier']);
const HELP = [
  '任务命令可把正文写在同行：/inline [修饰参数] 正文、/thread [修饰参数] 正文、/quick 正文。',
  '/inline 和 /thread 的修饰参数：--harness <名称>、--model <模型 ID>、--effort <级别>。',
  '普通聊天群支持 inline/thread；话题群固定使用 Thread。Quick 是独立执行模式，不改变回复位置。',
  '短名：/m model、/q quick。',
  '/status — 查看当前范围的 Harness、模型和 Effort',
  '/harness [名称] — 查看或修改当前任务使用的 Harness',
  '/model [模型 ID] — 查看或修改当前任务使用的模型',
  '/effort [级别] — 查看或修改当前任务的 Effort',
  '/tier [sota|quality|balanced|economy] — 只修改当前 Session 的模型档位',
  '/mute — 静默当前话题或聊天；明确 @ 可单次唤醒',
  '/unmute — 恢复当前话题或聊天的正常响应',
  '/inline [修饰参数] 正文 — 在群聊或私聊主线继续并直接回复',
  '/thread [修饰参数] 正文 — 从主线新建 Thread Session 并在线程中回复',
  '/quick 正文 — 在当前新主线或新话题创建 Quick Session；回复位置遵循聊天拓扑',
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
  if (isFeishuThreadConversation(summary)) return null;
  const conversation = {
    connector: 'feishu',
    sourceRouteId: runtime.config?.sourceRouteId || 'default',
    target: buildFeishuSessionConversationTarget({ ...summary, conversationKind: 'main' }),
  };
  const resolved = await requestJson(request, '/api/session-conversations/resolve', {
    method: 'POST', body: { conversation },
  });
  if (resolved.sessionId) {
    return (await requestJson(request, `/api/sessions/${encodeURIComponent(resolved.sessionId)}`)).session;
  }
  const { sessions = [] } = await requestJson(request, '/api/sessions');
  return sessions.find(session => !session.archived && session.externalTriggerId === buildExternalTriggerId(summary)) || null;
}

function reasoningFor(catalog, model) {
  return reasoningForRuntimeProfile(catalog, model);
}

function completeSelection(selection, catalog) {
  return { ...completeRuntimeProfile(selection, catalog), thinking: selection.thinking === true };
}

function describe(selection) {
  return [
    '作用范围：当前 Session',
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
    runtimeTier: trim(session.runtimeTier),
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
    const key = command.name;
    if (seen.has(key)) return `命令重复：/${command.name}。同一字段一条消息只能设置一次。`;
    seen.add(key);
  }
  if (hasQuery && hasMutation) return '/help 或 /status 不能和配置变更放在同一个命令块中。';
  if (commands.some(command => command.name === 'inline') && commands.some(command => command.name === 'thread')) {
    return '/inline 和 /thread 不能同时使用。';
  }
  if (commands.some(command => command.name === 'quick')
    && commands.some(command => ['inline', 'thread', 'harness', 'model', 'effort', 'tier'].includes(command.name))) {
    return '/quick 需要单独使用，不能和任务或运行时配置命令组合。';
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
  const session = summary?.startThread ? null : await findCommandSession(runtime, summary, request);
  let selection = sessionSelection(session, defaults) || { ...defaults };
  let catalog = null;
  const operations = [];
  const notes = [];

  const mutatesSessionRuntime = commands.some(command => (
    ['harness', 'model', 'effort', 'tier'].includes(command.name) && command.value
  ));
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
      notes.push(`${describe(selection)}\n${await describeFeishuMuteSetting(runtime, summary)}`);
      continue;
    }
    if (!CONFIG_COMMANDS.has(command.name)) continue;
    if (!session && !taskMode && command.value) {
      return { error: '请在已有任务话题或私聊会话中执行此命令；也可以把命令块和任务正文放在同一条消息中。',
        text: '请在已有任务话题或私聊会话中执行此命令；也可以把命令块和任务正文放在同一条消息中。', operations: [] };
    }
    if (command.name === 'tier') {
      const { presets = [] } = await requestJson(request, '/api/runtime-presets');
      if (!command.value) {
        const currentTier = selection.runtimeTier
          || presets.find((preset) => preset.model === selection.model && (preset.effort || '') === (selection.effort || ''))?.id
          || 'custom';
        notes.push(`当前档位：${currentTier}\n${presets.map((preset) => `/tier ${preset.id}`).join('\n')}`);
        continue;
      }
      const preset = presets.find((entry) => entry.id === command.value.toLowerCase());
      if (!preset) {
        return { error: `未知档位：${command.value}。`, text: `未知档位：${command.value}。\n${presets.map((entry) => `/tier ${entry.id}`).join('\n')}`, operations: [] };
      }
      selection = {
        tool: 'codex',
        model: preset.model,
        effort: preset.effort || '',
        thinking: false,
        runtimeTier: preset.id,
      };
      catalog = await catalogFor('codex');
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

  if (session && commands.some(command => (
    ['harness', 'model', 'effort', 'tier'].includes(command.name) && command.value
  ))) {
    const tierCommand = commands.find(command => command.name === 'tier' && command.value);
    operations.push({
      scope: 'session',
      sessionId: session.id,
      selection,
      ...(tierCommand ? { runtimeTier: selection.runtimeTier } : {}),
    });
  }
  if (notes.length === 0 && operations.length > 0) {
    const sessionOperation = operations.find(operation => operation.scope === 'session');
    if (sessionOperation) notes.push(`已更新当前 Session 配置。\n${describe(selection)}`);
  }
  return { commands, operations, selection, sessionId: session?.id || '', text: notes.join('\n\n') || HELP };
}

export async function applyFeishuRuntimeCommandPlan(plan, { request } = {}) {
  for (const operation of plan.operations || []) {
    const { session } = await requestJson(request, `/api/sessions/${encodeURIComponent(operation.sessionId)}`, {
      method: 'PATCH',
      body: operation.runtimeTier
        ? { runtimeTier: operation.runtimeTier }
        : {
          tool: operation.selection.tool, model: operation.selection.model || '', effort: operation.selection.effort || '', thinking: operation.selection.thinking === true,
        },
    });
    const persisted = session?.feishuRuntimeSelection || session;
    if (operation.runtimeTier && session?.runtimeTier !== operation.runtimeTier) throw new Error('RemoteLab did not persist the requested Session tier');
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
    name: command.type,
    value: command.text,
  }], options);
}

export { HELP };
