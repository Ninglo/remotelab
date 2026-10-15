import { buildSessionNavigationHref } from '../../lib/session-navigation.mjs';

const plain = content => ({ tag: 'plain_text', content });
const md = content => ({ tag: 'markdown', content });

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

// Existing and new group cards share the compact presentation.
// Legacy cardLayout flags no longer select a different UI.
export function buildGroupConfigurationCard(record, view) {
  const states = { active: '主动参与', listening: '旁听', paused: '暂停' };
  const mode = record.mode || 'active';
  const selection = view.selection || {};
  const workGroup = view.project?.group?.chatMode === 'topic'
    || (view.participationControls === false && view.responseMode === 'all');
  const responseLabel = view.participationControls === false
    ? (view.responseMode === 'mention_only' ? '点名回应' : '话题内逐条回应') : states[mode];
  const elements = [md(view.participationControls === false && view.responseMode === 'mention_only'
    ? '沿用本群的点名回应设置。' : { active: workGroup ? '本群逐条回应，具体工作在各自话题中继续。' : '持续接收群消息，按讨论需要参与。',
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
      title: plain(`Agent · ${responseLabel}`) }, body: { elements } };
}
