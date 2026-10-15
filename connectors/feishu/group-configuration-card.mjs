import { buildSessionNavigationHref } from '../../lib/session-navigation.mjs';

const plain = content => ({ tag: 'plain_text', content });
const md = content => ({ tag: 'markdown', content });
const labels = { active: '主动参与', listening: '旁听', paused: '暂停接收' };
const fold = (title, elements) => ({ tag: 'collapsible_panel', expanded: false,
  header: { title: plain(title) }, elements });

function routingControls(record, view) {
  if (!view.routingTrial?.personalOptIn) return [];
  const button = (label, action) => ({ tag: 'button', type: 'default', text: plain(label),
    behaviors: [{ type: 'callback', value: { namespace: 'group-configuration', key: record.key, action } }] });
  return [md('**个人分流与并行试用**\n' + view.routingTrial.scopeLabel
    + '。每人自行开启；按钮仅修改点击者本人，上述试点群共用个人开关。'
    + '\n明确要求并行会开独立子 Session 并返回链接；Agent 建议拆分先征询，未答继续原工作。跨话题交接须确认，主话题负责验收。'
    + '\n子 Session 当前在 Web 打开，不自动新建飞书话题；关闭只影响后续新输入。'),
  { tag: 'column_set', columns: [button('为我开启试用', 'routing-on'), button('为我关闭试用', 'routing-off'), button('查看我的状态', 'routing-status')]
    .map(element => ({ tag: 'column', width: 'weighted', weight: 1, elements: [element] })) }];
}

// Per-card preview selection keeps other groups on their current presentation.
function compactGroupCard(record, view) {
  const states = { active: '主动参与', listening: '旁听', paused: '暂停' };
  const mode = record.mode || 'active';
  const selection = view.selection || {};
  const workGroup = view.project?.group?.chatMode === 'topic';
  const elements = [md({ active: workGroup ? '本群逐条回应，具体工作在各自话题中继续。' : '持续接收群消息，按讨论需要参与。',
    listening: '持续接收群消息；@我可邀请回应。', paused: '暂停接收后续普通群消息。' }[mode])];
  if (view.participationControls !== false) elements.push({ tag: 'column_set', columns: Object.keys(states).map(state => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button',
      type: state === mode ? 'primary' : 'default', text: plain(states[state]),
      behaviors: [{ type: 'callback', value: { namespace: 'participation', key: record.key,
        mode: state, epoch: record.epoch || 0 } }],
    }],
  })) });
  const url = record.sessionId && view.sessionAvailable
    ? buildSessionNavigationHref(record.sessionId, { requireAbsolute: true }) : '';
  elements.push(md(`**主 Session**：${selection.model === 'auto' ? '自动选择' : selection.model || '待确认'}${selection.effort ? ` · ${selection.effort}` : ''}`
    + (url ? `\n[打开主会话](${url})` : '')));
  const project = view.project;
  if (project?.briefUrl) elements.push({ tag: 'hr' }, md(`[**${project.name || project.id}｜项目共同认知·群内对话默认注入**](${project.briefUrl})`
    + (project.briefUpdated ? `\n更新时间：${project.briefUpdated}` : '')));
  if (project?.skills?.length) elements.push(md('**常用技能**\n'
    + project.skills.slice(0, 3).map(skill => `• **${skill.name}**：${skill.description}`).join('\n')));
  elements.push(...routingControls(record, view));
  if (view.error) elements.push(md(view.error));
  if (record.stopPending) elements.push(md('正在停止当前任务。'));
  return { schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { template: mode === 'active' ? 'green' : mode === 'listening' ? 'blue' : 'grey',
      title: plain(`Agent · ${states[mode]}`) }, body: { elements } };
}

export function buildGroupConfigurationCard(record, view) {
  if (record.cardLayout === 'compact') return compactGroupCard(record, view);
  const identity = { namespace: 'group-configuration', key: record.key, revision: view.revision };
  const button = (label, action, extra = {}) => ({ tag: 'button', type: 'default', text: plain(label),
    behaviors: [{ type: 'callback', value: { ...identity, action, ...extra } }] });
  const row = elements => ({ tag: 'column_set', columns: elements.map(element => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [element],
  })) });
  const selection = view.selection || {};
  const url = record.sessionId && view.sessionAvailable ? buildSessionNavigationHref(record.sessionId, { requireAbsolute: true }) : '';
  const prompt = view.systemPrompt || '';
  const responseLabel = view.participationControls === false ? (view.responseMode === 'mention_only' ? '点名回应' : '话题内逐条回应') : labels[record.mode];
  const elements = [md(`**Agent 回应状态 · ${responseLabel}**\n${view.participationControls === false ? '沿用本群原有回应设置；群主会话与独立话题分别保存。' : {
    active: '持续接收消息，自主判断何时参与。',
    listening: '持续接收消息；@我可单次邀请。', paused: '后续普通消息不进入会话。',
  }[record.mode]}`), ...(view.participationControls === false ? [] : [row(Object.keys(labels).map(mode => ({ tag: 'button',
    type: mode === record.mode ? 'primary' : 'default', text: plain(labels[mode]),
    behaviors: [{ type: 'callback', value: { namespace: 'participation', key: record.key, mode, epoch: record.epoch || 0 } }],
  }))) ]),
  md(`**主 Session 模型**：${selection.model || '默认'}\n**思考强度**：${selection.effort || '不适用'}\n**执行工具**：${selection.tool || '默认'}`),
  ...(view.runningSelection ? [md(`当前正在执行：${view.runningSelection.model || '默认'} · ${view.runningSelection.effort || '不适用'}；修改用于后续输入。`)] : []),
  ...(url ? [md(`[查看主讨论记录](${url})（可选；配置操作均可在飞书完成）`)]
    : [md(view.sessionAvailable ? '主讨论已绑定；外部记录链接尚未配置。' : '首次收到群消息后显示主讨论记录链接。')]),
  button('刷新当前配置', 'refresh')];
  if (view.project) {
    const p = view.project;
    elements.push(md(p.error ? `**项目资料暂不可读**：${p.error}`
      : `**项目**：${p.name || p.id}${p.status === 'paused' ? '（项目已暂停）' : ''}\n`
        + (p.briefUrl ? `[项目说明 · 共识、经验与目录](${p.briefUrl})` : '项目说明尚未发布')
        + (p.briefUpdated ? `\n更新时间：${p.briefUpdated}` : '')));
    if (p.skills?.length) elements.push(md('**项目常用技能**\n' + p.skills.map(x => `• **${x.name}**：${x.description}`).join('\n')));
    if (p.groups?.length > 1) elements.push(md(p.groups.map(g => `[${g.chatName || '同项目群'}](https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(g.chatId)})`).join(' · ')));
    const topics = view.topics || [], page = view.boardPage || 0, pages = Math.max(1, Math.ceil(topics.length / 10));
    const safe = x => String(x).replace(/[\[\]<>`]/g, '').replace(/\s+/g, ' ').slice(0, 80);
    elements.push(md(`**本群话题看板** · ${topics.length} 个未归档话题 · 第 ${page + 1}/${pages} 页\n`
      + (view.boardConnected ? '随会话状态更新；“未在运行”不代表工作完成。' : '**实时连接暂不可用，以下为最近读取状态。**')
      + '\n' + (topics.slice(page * 10, page * 10 + 10).map(t => `• ${t.state} · [${safe(t.title)}](${t.url})`).join('\n') || '暂无已关联话题。')));
    if (pages > 1) elements.push(row([
      ...(page ? [button('上一页', 'board-page', { page: page - 1 })] : []),
      ...(page + 1 < pages ? [button('下一页', 'board-page', { page: page + 1 })] : []),
    ]));
  }
  elements.push(...routingControls(record, view));
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
      title: plain(`Agent · ${responseLabel}`) }, body: { elements } };
}
