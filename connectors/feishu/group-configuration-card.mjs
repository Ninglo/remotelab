import { buildSessionNavigationHref } from '../../lib/session-navigation.mjs';

const plain = content => ({ tag: 'plain_text', content });
const md = content => ({ tag: 'markdown', content });
const labels = { active: '主动参与', listening: '旁听', paused: '暂停接收' };
const fold = (title, elements) => ({ tag: 'collapsible_panel', expanded: false,
  header: { title: plain(title) }, elements });

export function buildGroupConfigurationCard(record, view) {
  const identity = { namespace: 'group-configuration', key: record.key, revision: view.revision };
  const button = (label, action, extra = {}) => ({ tag: 'button', type: 'default', text: plain(label),
    behaviors: [{ type: 'callback', value: { ...identity, action, ...extra } }] });
  const row = elements => ({ tag: 'column_set', columns: elements.map(element => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [element],
  })) });
  const selection = view.selection || {};
  const url = record.sessionId && view.sessionAvailable ? buildSessionNavigationHref(record.sessionId, { requireAbsolute: true }) : '';
  const prompt = view.systemPrompt || '';
  const elements = [md(`**本群主讨论 · ${labels[record.mode]}**\n${{
    active: '持续接收消息，自主判断何时参与。',
    listening: '持续接收消息；@我可单次邀请。', paused: '后续普通消息不进入会话。',
  }[record.mode]}`), row(Object.keys(labels).map(mode => ({ tag: 'button',
    type: mode === record.mode ? 'primary' : 'default', text: plain(labels[mode]),
    behaviors: [{ type: 'callback', value: { namespace: 'participation', key: record.key, mode, epoch: record.epoch || 0 } }],
  }))),
  md(`**主讨论模型**：${selection.model || '默认'}\n**思考强度**：${selection.effort || '不适用'}\n**执行工具**：${selection.tool || '默认'}`),
  ...(view.runningSelection ? [md(`当前正在执行：${view.runningSelection.model || '默认'} · ${view.runningSelection.effort || '不适用'}；修改用于后续输入。`)] : []),
  ...(url ? [md(`[查看主讨论记录](${url})（可选；配置操作均可在飞书完成）`)] : [md('首次收到群消息后显示主讨论记录链接。')]),
  button('刷新当前配置', 'refresh')];
  if (view.catalog?.models?.length && view.sessionAvailable) elements.push({ tag: 'form', name: 'group_model', elements: [
    fold('修改主讨论模型', [{ tag: 'select_static', name: 'model', width: 'fill',
      placeholder: plain('选择模型'), ...(view.catalog.models.slice(0, 100).some(model => model.id === selection.model)
        ? { initial_option: selection.model } : {}),
      options: view.catalog.models.slice(0, 100).map(model => ({ text: plain(model.id), value: model.id })) },
    { ...button('保存模型', 'model'), name: 'save_model', form_action_type: 'submit', type: 'primary' }]),
  ] });
  if (view.reasoning?.kind === 'enum' && view.sessionAvailable) elements.push({ tag: 'form', name: 'group_effort', elements: [
    fold('修改思考强度', [{ tag: 'select_static', name: 'effort', width: 'fill',
      placeholder: plain('选择思考强度'), initial_option: selection.effort,
      options: view.reasoning.levels.map(level => ({ text: plain(level), value: level })) },
    { ...button('保存思考强度', 'effort'), name: 'save_effort', form_action_type: 'submit', type: 'primary' }]),
  ] });
  elements.push(fold('查看本群 prompt', [md(prompt || '未设置额外群级 prompt。'),
    md('群级 prompt 作用于本群后续输入和新话题；参与、回复位置等内置规则仍由系统管理。群公告作为项目背景供新话题读取。') ]));
  if (view.effectiveSystemPrompt) elements.push(fold('查看主讨论当前生效的会话指令', [
    { tag: 'div', text: plain(view.effectiveSystemPrompt) },
    md('此处展示主讨论实际保存的指令。群级 prompt 保存后，从后续输入开始应用；当前已接受的任务保留原指令。'),
  ]));
  const chunks = Math.min(16, Math.max(1, Math.ceil(prompt.length / 1000) + 1));
  if (prompt.length <= 16000) elements.push({ tag: 'form', name: 'group_prompt', elements: [fold('编辑本群 prompt', [
    ...Array.from({ length: chunks }, (_, index) => ({ tag: 'input', name: `prompt_${index}`, width: 'fill',
      input_type: 'multiline_text', max_length: 1000, default_value: prompt.slice(index * 1000, (index + 1) * 1000),
      placeholder: plain(chunks > 1 ? `群级 prompt 第 ${index + 1} 段（每段最多 1000 字）` : '填写本群的目标、背景和协作要求'),
    })), { ...button('保存群级 prompt', 'prompt', { chunks }), name: 'save_prompt', form_action_type: 'submit', type: 'primary' },
  ])] });
  else elements.push(md('现有群级 prompt 超过卡片编辑上限；完整内容见上方展开区。请在群里说明需要修改的部分。'));
  if (view.updatedBy) elements.push(md(`群级 prompt 最近由 ${view.updatedBy} 修改，版本 ${view.promptVersion}。`));
  if (view.error) elements.push(md(`**操作提示**：${view.error}`));
  if (record.stopPending) elements.push(md('正在停止当前任务。'));
  elements.push(md('也可说“先旁听”“暂停接收消息”“恢复参与”。模型修改只作用于主讨论；独立话题保留各自配置。'));
  return { schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { template: record.mode === 'active' ? 'green' : record.mode === 'listening' ? 'blue' : 'grey',
      title: plain(`Bot 配置 · ${labels[record.mode]}`) }, body: { elements } };
}
