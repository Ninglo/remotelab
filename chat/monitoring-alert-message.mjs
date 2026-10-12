import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recoveryHumanAction } from '../lib/monitoring-actions.mjs';
import { buildFeishuPostContent } from '../connectors/feishu/index.mjs';

const text = (value, limit = 1200) => String(value || '').replace(/[\r\n]+/g, ' ').slice(0, limit)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The card is a short status, not the approval document. Keep complete
// evidence and decision details in the existing recovery Session.
const brief = (value, limit = 80) => {
  const normalized = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  const first = normalized.split(/(?<=[。！？])/u)[0];
  if (first.length <= limit) return text(first);
  const head = first.slice(0, limit);
  const boundary = Math.max(head.lastIndexOf('；'), head.lastIndexOf('，'), head.lastIndexOf('; '));
  return text((boundary >= limit / 2 ? head.slice(0, boundary) : head).trimEnd()) + '…';
};
const repairFor = (item, config) => config.recoveryIncidents?.slice().reverse()
  .find(record => record.kind === item.kind && record.id === item.id) || item.recovery;
const link = (sessionId, base) => {
  try { return sessionId && base ? new URL(`/?session=${encodeURIComponent(sessionId)}&tab=sessions`, base).href : ''; }
  catch { return ''; }
};

export function monitoringNextStep(item, config) {
  const recovery = repairFor(item, config);
  const sessionUrl = link(recovery?.sessionId, config.overviewUrl);
  const ordinary = { type: 'notice', label: '查看处理进展', url: sessionUrl || config.overviewUrl };
  if (item.recovered) return { ...ordinary, summary: '已恢复，无需操作。' };
  if (['running', 'waiting', 'admitting', 'pending', 'verifying'].includes(recovery?.status)) {
    const progress = recovery.status === 'running' ? '我在处理'
      : recovery.status === 'verifying' ? '我在核验结果' : '已安排处理，等待执行结果';
    return { ...ordinary, summary: `${progress}，无需你操作。` };
  }
  const human = recoveryHumanAction(recovery?.humanAction);
  if (human?.type === 'input') return { type: 'input', label: '进入会话补充信息', url: sessionUrl,
    summary: `需要你补充：${brief(human.summary, 80)}` };
  if (recovery?.plan?.requiresConfirmation) return { type: 'approval', label: '查看方案并回复批准', url: sessionUrl,
    summary: `需要你批准：${brief(human?.summary || recovery.plan.summary, 55)}；确认前不执行。` };
  if (item.kind === 'accountContinuity' && item.action?.requiresConfirmation) return {
    type: 'input', label: '查看账号与设置', url: config.overviewUrl,
    summary: item.continuity?.status === 'switch_disabled' ? '需要你决定是否开启自动切号，请在账号设置中选择。'
      : '需要你选择：登录另一个已获授权账号，或等待额度重置。',
  };
  return { ...ordinary, summary: recovery?.status === 'blocked'
    ? '处理受阻，尚未形成需要你执行的具体动作。' : '我这边继续核查，暂不需要你操作。' };
}

export function renderMonitoringAlert(events, config, { color = false, links = true } = {}) {
  const emphasize = value => color ? `<font color="red">${value}</font>` : `**${value}**`;
  const sections = events.map(item => {
    const recovery = repairFor(item, config);
    const account = item.continuity;
    const problem = item.kind === 'disk' && Number.isFinite(item.availableBytes) && Number.isFinite(item.usedPercent)
      ? `可用 ${(item.availableBytes / 1024 ** 3).toFixed(2)} GiB，已用 ${item.usedPercent.toFixed(1)}%${Number.isFinite(item.inodeUsedPercent) && item.inodeUsedPercent >= 85 ? `，inode 已用 ${item.inodeUsedPercent.toFixed(1)}%` : ''}`
      : account ? `当前剩余 ${account.remainingPercent ?? '未知'}%，额度高于10%的已登录备用 ${account.backupCount} 个`
      : brief(item.detail || '详见处理记录');
    const resolved = item.recovered === true;
    const inFlight = ['pending', 'waiting', 'admitting', 'running'].includes(recovery?.status);
    const hasResult = !inFlight && recovery?.summary;
    const progress = resolved ? '最新独立观测已确认恢复。'
      : hasResult ? brief(recovery.summary)
      : account ? `已核对本实例账号；自动切换${account.autoSwitch ? '已开启' : '未开启'}。${account.lastSwitch ? '最近切换记录见监管总览。' : '尚无已核验的切换记录。'}`
      : recovery?.status === 'running' ? '补救任务已启动；本轮执行结果尚未回报。'
      : recovery?.status === 'waiting' ? '原会话已有任务执行，正在等待结果。'
      : recovery?.status === 'blocked' ? '本轮补救未通过验收，详细原因见处理记录。'
      : '已记录风险；尚无本轮已执行动作的回执。';
    const next = monitoringNextStep(item, config);
    const decision = next.type === 'notice' ? next.summary : emphasize(next.summary);
    return `**${text(item.subject, 120)}${resolved ? ' · 已恢复' : ''}**\n`
      + `当前风险：${resolved ? '已解除' : item.severity === 'critical' ? emphasize(problem) : problem}\n`
      + `处理：${progress}\n下一步：${decision}`
      + (links && next.url ? `\n[${next.label}](${next.url})` : '')
      + (!color && item.observedAt ? `\n更新：${text(item.observedAt, 40)}` : '');
  });
  return sections.join('\n\n---\n\n') + (links && config.overviewUrl ? `\n\n[监管总览](${config.overviewUrl})` : '');
}

export function renderMonitoringAlertCard(events, config) {
  return { config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '监管：风险与处理进展' },
      template: events.some(e => !e.recovered && e.severity === 'critical') ? 'red' : 'blue' },
    elements: [...events.flatMap(item => {
      const next = monitoringNextStep(item, config);
      return [{ tag: 'div', text: { tag: 'lark_md', content: renderMonitoringAlert([item], config, { color: true, links: false }) } },
        ...(next.url ? [{ tag: 'action', actions: [{ tag: 'button', type: next.type === 'notice' ? 'default' : 'primary',
          text: { tag: 'plain_text', content: next.label }, url: next.url }] }] : [])];
    }), { tag: 'note', elements: [{ tag: 'plain_text', content: `最近观测：${events.map(e => e.observedAt).filter(Boolean).sort().at(-1) || '见监管总览'}` }] }] };

}

export async function monitoringIm(config, method, path, body, params, execute = promisify(execFile)) {
  if (!/^oc_[\w]+$/.test(config.chatId || '') || !/^[\w.-]+$/.test(config.profile || '')) throw new Error('INVALID_RECIPIENT');
  const args = ['--profile', config.profile, 'api', method, path, '--as', 'bot',
    ...(body ? ['--data', JSON.stringify(body)] : []), ...(params ? ['--params', JSON.stringify(params)] : [])];
  const { stdout } = await execute('lark-cli', args, { timeout: 25_000, maxBuffer: 300_000,
    env: { ...process.env, ...(config.configDir ? { LARKSUITE_CLI_CONFIG_DIR: config.configDir } : {}),
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
  const value = JSON.parse(stdout);
  if (value.ok === false || value.code && value.code !== 0) throw Object.assign(new Error('Feishu operation failed'), { code: value.code || value.error?.code || 'FEISHU_FAILED' });
  return value.data || value;
}

export async function sendMonitoringAlert(events, config, batchId, api = monitoringIm) {
  const result = await api(config, 'POST', '/open-apis/im/v1/messages', {
    receive_id: config.chatId, msg_type: 'interactive', content: JSON.stringify(renderMonitoringAlertCard(events, config)), uuid: batchId,
  }, { receive_id_type: 'chat_id' });
  if (!result.message_id?.startsWith('om_')) throw new Error('MISSING_RECEIPT');
  return result.message_id;
}

export async function updateMonitoringAlert(events, config, messageId, api = monitoringIm) {
  if (!/^om_[\w]+$/.test(messageId || '')) throw new Error('INVALID_MESSAGE');
  const path = `/open-apis/im/v1/messages/${messageId}`;
  const result = await api(config, 'GET', path);
  const message = result.items?.find(item => item.message_id === messageId);
  if (!message || message.deleted) throw Object.assign(new Error('Original message unavailable'), { code: 'MESSAGE_RECALLED_OR_MISSING' });
  if (message.chat_id !== config.chatId) throw new Error('RECIPIENT_CHANGED');
  if (config.feishuAppId && message.sender?.id !== config.feishuAppId) throw new Error('SENDER_CHANGED');
  if (message.msg_type === 'interactive') await api(config, 'PATCH', path, { content: JSON.stringify(renderMonitoringAlertCard(events, config)) });
  else if (message.msg_type === 'post') await api(config, 'PUT', path, {
    msg_type: 'post', content: await buildFeishuPostContent(renderMonitoringAlert(events, config).replace(/<\/?sub>/g, '')),
  });
  else throw new Error('UNSUPPORTED_MESSAGE_TYPE');
  return messageId;
}
