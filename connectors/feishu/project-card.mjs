const text = content => ({ tag: 'div', text: { tag: 'plain_text', content: String(content) } });
const markdown = content => ({ tag: 'markdown', content });
const chatLink = id => `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(id)}`;
const stateName = state => ({ active: '已开启', paused: '已暂停', cancelled: '已取消',
  running: '执行中', completed: '已完成' })[state] || state || '未知';
const safeName = name => String(name).replace(/[\[\]<>\r\n]/g, ' ');
const scheduleName = schedule => schedule?.type === 'interval'
  ? `每 ${schedule.everySeconds} 秒检查` : `${schedule?.cron || '未登记'}（${schedule?.timezone || '时区未登记'}）`;
const dateName = value => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short',
    timeStyle: 'medium', hourCycle: 'h23' }).format(new Date(value)) + '（北京时间）' : '未安排';

export function buildProjectCard(record, view, audit = []) {
  const { source, memory, tasks, materials } = view;
  const button = (label, action, extra = {}) => ({ tag: 'button', type: 'default',
    text: { tag: 'plain_text', content: label }, behaviors: [{ type: 'callback', value: {
      namespace: 'project', cardKey: record.key, bindingVersion: source.bindingVersion,
      controlEpoch: record.controlEpoch || 0, action, ...extra,
    } }] });
  const row = buttons => ({ tag: 'column_set', columns: buttons.map(element => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [element],
  })) });
  const elements = [row([button('项目入口', 'home'), button('项目记忆', 'memory'),
    button('自动任务', 'tasks'), button('修改记录', 'audit')])];
  const tab = record.tab || 'home';
  const page = Math.max(0, Math.min(record.page || 0, (memory.pages?.length || 1) - 1));
  if (tab === 'memory') {
    elements.push(text(source.memory.label || source.memory.heading),
      ...(memory.error ? [text(memory.error)] : [text(`来源版本 ${memory.version} · 第 ${page + 1}/${memory.pages.length} 页`),
        markdown(memory.pages[page]), row([
          ...(page > 0 ? [button('上一页', 'memory', { page: page - 1 })] : []),
          ...(page + 1 < memory.pages.length ? [button('下一页', 'memory', { page: page + 1 })] : []),
          button('如何补充或纠正', 'edit-help'),
        ])]));
  } else if (tab === 'tasks') {
    elements.push(text('下面是已登记的关联自动任务；暂停影响后续触发，正在执行的工作继续。'));
    for (const task of tasks) {
      elements.push(text(`${task.alias} · ${task.title || task.id}\n作用范围：${task.scope}\n`
        + (task.error || `状态：${stateName(task.state)}\n运行安排：${scheduleName(task.schedule)}\n`
          + `下一次：${dateName(task.nextRunAt)}\n最近执行：${task.lastExecution?.state || '暂无已核实记录'}`)));
      if (!task.error) elements.push(row([
        button('查看执行规则', 'task', { alias: task.alias }),
        ...(task.actions.includes('pause') ? [button('暂停', 'pause', { alias: task.alias, taskVersion: task.version })] : []),
        ...(task.actions.includes('resume') ? [button('恢复', 'resume', { alias: task.alias, taskVersion: task.version })] : []),
      ]));
    }
  } else if (tab === 'task') {
    const task = tasks.find(entry => entry.alias === record.alias);
    if (!task || task.error) elements.push(text('该任务当前不可核实。'));
    else {
      const pages = task.promptPages;
      const index = Math.max(0, Math.min(record.page || 0, pages.length - 1));
      elements.push(text(`${task.title}\n作用范围：${task.scope}\n任务配置版本 ${task.version} · 第 ${index + 1}/${pages.length} 页`),
        text(pages[index]), row([
          ...(index > 0 ? [button('上一页', 'task', { alias: task.alias, page: index - 1 })] : []),
          ...(index + 1 < pages.length ? [button('下一页', 'task', { alias: task.alias, page: index + 1 })] : []),
          button('修改执行规则的方法', 'edit-help'),
        ]));
    }
  } else if (tab === 'audit') {
    elements.push(text('这里列出从项目入口发起的配置操作；完整项目审计仍以各原始来源为准。'),
      text(`项目来源登记版本：${source.bindingVersion}\n记忆内容版本：${memory.version || '不可读'}`),
      ...audit.slice(-12).reverse().map(item => text(`${dateName(item.at)} · ${item.actor}\n${item.label}\n${item.result}`)),
      ...(!audit.length ? [text('尚无入口配置操作。')] : []));
    for (const material of materials) elements.push(row([button(material.name, 'material', { alias: material.alias })]));
  } else if (tab === 'material') {
    const material = materials.find(item => item.alias === record.alias);
    if (!material || material.error) elements.push(text(material?.error || '原始材料未登记。'));
    else {
      const index = Math.max(0, Math.min(record.page || 0, material.pages.length - 1));
      elements.push(text(`${material.name}\n材料短名：${material.alias}\n原材料版本 ${material.version} · 第 ${index + 1}/${material.pages.length} 页`),
        text(material.pages[index]));
      if (material.pages.length > 1) elements.push(row([
        ...(index > 0 ? [button('上一页', 'material', { alias: material.alias, page: index - 1 })] : []),
        ...(index + 1 < material.pages.length ? [button('下一页', 'material', { alias: material.alias, page: index + 1 })] : []),
      ]));
    }
  } else if (tab === 'edit-help') {
    elements.push(text('记忆补充或纠正：在本话题发送 /project memory 修改说明。会交给当前对话核对、写回原记忆并给出结果；提交不代表已经写入。'),
      text('任务执行规则：在本话题直接说明要修改哪个任务、怎么改。暂停和恢复可在“自动任务”页直接操作。'),
      text('当前对话配置：/status 查看；/model、/effort、/tier、/mute、/unmute 修改。这些设置只作用于当前对话。'));
  } else {
    elements.push(text(source.description || '项目资料、记忆和已登记自动任务的共同入口。'),
      markdown(`[${safeName(source.link.discussionChatName || '讨论群')}](${chatLink(source.link.discussionChatId)}) · `
        + `[${safeName(source.link.workChatName || '干活群')}](${chatLink(source.link.workChatId)})`),
      ...source.resources.map(resource => markdown(`[${safeName(resource.name)}](${resource.url})`)),
      ...materials.flatMap(material => [text(`原材料：${material.alias}`), row([button(material.name, 'material', { alias: material.alias })])]),
      text(`关联自动任务：${tasks.map(task => `${task.alias} ${task.error ? '待核实' : stateName(task.state)}`).join('；') || '未登记'}`),
      text(`项目记忆：${source.memory.label || source.memory.heading}\n${memory.error || `当前版本 ${memory.version}`}`),
      text('查看记忆、核对执行规则、暂停或恢复任务都可以在此卡片完成。记忆纠正在原话题继续。\n输入 /project 可重新读取并更新这张卡片。'));
  }
  if (record.notice) elements.push(text(record.notice));
  elements.push(text(`状态读取于 ${dateName(view.readAt)}。内容变更后更新原卡；来源不可核实时会明确标出。`));
  return { schema: '2.0', config: { update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `${source.name} · 项目入口` } },
    body: { elements } };
}
