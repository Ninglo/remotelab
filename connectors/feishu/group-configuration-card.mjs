import { buildSessionNavigationHref } from '../../lib/session-navigation.mjs';

const plain = content => ({ tag: 'plain_text', content });
const md = content => ({ tag: 'markdown', content });

// Existing and new group cards share the compact presentation.
// Legacy cardLayout flags no longer select a different UI.
export function buildGroupConfigurationCard(record, view) {
  const states = { active: '主动参与', listening: '旁听', paused: '暂停' };
  const mode = record.mode || 'active';
  const selection = view.selection || {};
  const responseLabel = view.participationControls === false
    ? (view.responseMode === 'mention_only' ? '点名回应' : '按需回应（控制关闭）') : states[mode];
  const elements = [md(view.nativeTopicGroup ? '本群每个话题独立承接工作。' : view.participationControls === false && view.responseMode === 'mention_only'
    ? '沿用本群的点名回应设置。' : { active: '持续接收群消息，按讨论需要参与。',
    listening: '持续接收群消息；@我可邀请回应。', paused: '普通群消息不进入 Session；@我可单次回应，之后仍保持暂停。' }[mode])];
  if (record.cardRenewalNotice) elements.unshift(md(record.cardRenewalNotice));
  if (view.participationControls !== false) elements.push({ tag: 'column_set', columns: Object.keys(states).map(state => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button',
      type: state === mode ? 'primary' : 'default', text: plain(states[state]),
      behaviors: [{ type: 'callback', value: { namespace: 'participation', key: record.key,
        mode: state, epoch: record.epoch || 0 } }],
    }],
  })) });
  const url = record.sessionId && view.sessionAvailable
    ? buildSessionNavigationHref(record.sessionId, { requireAbsolute: true }) : '';
  if (!view.nativeTopicGroup) elements.push(md(`**主 Session**：${selection.model === 'auto' ? '自动选择' : selection.model || '待确认'}${selection.effort ? ` · ${selection.effort}` : ''}`
    + (url ? `\n[打开主会话](${url})` : '')));
  const project = view.project;
  if (view.reading) elements.push(md(`**项目归属**：${view.reading.projectPath}\n**读取层级**：${view.reading.label}\n${view.reading.method}`));
  if (project?.briefUrl) elements.push({ tag: 'hr' }, md(`[**${project.name || project.id}｜项目共同认知·对话按需读取**](${project.briefUrl})`
    + (project.briefUpdated ? `\n更新时间：${project.briefUpdated}` : '')));
  if (project?.skills?.length) elements.push(md('**常用技能**\n'
    + project.skills.slice(0, 3).map(skill => `• **${skill.name}**：${skill.description}`).join('\n')));
  // Shared cards display only experiments actually enabled for this group.
  // Personal choices and enrollment controls belong to personal settings.
  if (view.knowledgePilot?.enabled) elements.push({ tag: 'hr' }, md('**组织 Wiki · 本群已开启**'),
    md('本群的新工作可按需查阅组织知识库；实际采用时标明来源。范围仅限本群，不延伸至成员的其他群或私聊。'));
  if (view.selfReview === true) elements.push({ tag: 'hr' }, md('**交付前自检 · 本群已开启**'),
    md('本 Bot 在本群接纳的新工作可核对成果、验收条件和交付入口。关闭本群不改变成员自己的个人设置。'),
    { tag: 'button', type: 'default', text: plain('关闭本群自检'),
      behaviors: [{ type: 'callback', value: { namespace: 'group-configuration', key: record.key,
        action: 'self-review-off', revision: view.revision } }] });
  if (view.error) elements.push(md(view.error));
  if (record.stopPending) elements.push(md('正在停止当前任务。'));
  return { schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { template: mode === 'active' ? 'green' : mode === 'listening' ? 'blue' : 'grey',
      title: plain(view.nativeTopicGroup ? 'Agent · 群设置' : `Agent · ${responseLabel}`) }, body: { elements } };
}
