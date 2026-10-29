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
  const elements = [md(view.participationControls === false && view.responseMode === 'mention_only'
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
  elements.push(md(`**主 Session**：${selection.model === 'auto' ? '自动选择' : selection.model || '待确认'}${selection.effort ? ` · ${selection.effort}` : ''}`
    + (url ? `\n[打开主会话](${url})` : '')));
  const project = view.project;
  if (view.reading) elements.push(md(`**项目归属**：${view.reading.projectPath}\n**读取层级**：${view.reading.label}\n${view.reading.method}`));
  if (project?.briefUrl) elements.push({ tag: 'hr' }, md(`[**${project.name || project.id}｜项目共同认知·对话按需读取**](${project.briefUrl})`
    + (project.briefUpdated ? `\n更新时间：${project.briefUpdated}` : '')));
  if (project?.skills?.length) elements.push(md('**常用技能**\n'
    + project.skills.slice(0, 3).map(skill => `• **${skill.name}**：${skill.description}`).join('\n')));
  elements.push({ tag: 'hr' }, md(`**交付前自检 · 本群：${view.selfReview === true ? '开启' : '关闭'}**`),
    md('默认关闭。开启后，本 Bot 在本群主线及话题接纳的新工作会核对成果、验收条件和交付入口，可能增加耗时与用量。当前运行和中途补充保留原设置。\n个人开关在“我的设置”中独立保存；群或个人任一开启即生效，关闭本群不关闭个人选择。'),
    { tag: 'button', type: 'default', text: plain(view.selfReview === true ? '关闭本群自检' : '开启本群自检'),
      behaviors: [{ type: 'callback', value: { namespace: 'group-configuration', key: record.key,
        action: view.selfReview === true ? 'self-review-off' : 'self-review-on', revision: view.revision } }] });
  if (view.error) elements.push(md(view.error));
  if (record.stopPending) elements.push(md('正在停止当前任务。'));
  return { schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { template: mode === 'active' ? 'green' : mode === 'listening' ? 'blue' : 'grey',
      title: plain(`Agent · ${responseLabel}`) }, body: { elements } };
}
