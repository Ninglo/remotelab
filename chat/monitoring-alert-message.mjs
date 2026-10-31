import { prepareAlertEvidenceImage } from '../lib/alert-evidence-image.mjs';
import { alertTime, alertHistoryPanel, alertEvidenceImage, resolutionAttribution } from '../lib/alert-card-history.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { monitoringDisposition } from '../lib/monitoring-policy.mjs';
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
  if (item.continuity?.lastAccountWarning?.state === 'low') return {
    type: 'input', label: '查看账号与额度', url: config.overviewUrl,
    summary: `${item.continuity.lastAccountWarning.remainingPercent === 0 ? '账号额度已耗尽' : '账号即将耗尽'}，请准备重置或购入新账号。`,
  };
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
  const disposition = monitoringDisposition(item);
  if (!recovery && disposition) return { ...disposition, url: config.overviewUrl };
  return { ...ordinary, summary: recovery?.status === 'blocked'
    ? '处理受阻，尚未形成需要你执行的具体动作。' : '我这边继续核查，暂不需要你操作。' };
}

export function monitoringProblem(item) {
  const warning = item.continuity?.lastAccountWarning;
  if (warning?.state === 'low') return `${text(warning.account?.label || '最后一个账号')} 剩余 ${warning.remainingPercent}%；已到 ${warning.threshold}% 预警线，其他账号均无高于10%的可用余量。`;
  if (item.kind === 'diskGrowth') return text(item.detail, 200);
  return item.kind === 'disk' && Number.isFinite(item.availableBytes) && Number.isFinite(item.usedPercent)
    ? `可用 ${(item.availableBytes / 1024 ** 3).toFixed(2)} GiB，已用 ${item.usedPercent.toFixed(1)}%${Number.isFinite(item.inodeUsedPercent) && item.inodeUsedPercent >= 85 ? `，inode 已用 ${item.inodeUsedPercent.toFixed(1)}%` : ''}`
    : item.continuity ? `当前剩余 ${item.continuity.remainingPercent ?? '未知'}%，额度高于10%的已登录备用 ${item.continuity.backupCount} 个`
    : brief(item.detail || '原记录未提供具体数值，详见处理记录');
}
export function monitoringProgress(item, recovery) {
  if (item.kind === 'serviceCrash' && item.recovered) return '已连续稳定运行30分钟，根因修复待确认。';
  if (item.kind === 'diskGrowth') return item.recovered ? '最新有效观测不再满足增长预警条件，容量继续独立监测。' : '已保存实际增长窗口与基线，容量继续独立监测。';
  const inFlight = ['pending', 'waiting', 'admitting', 'running'].includes(recovery?.status);
  if (!inFlight && recovery?.summary) return brief(recovery.summary.replace(/^同一[^。]*告警接续。/, ''));
  if (recovery?.status === 'running') return '补救任务已启动；本轮执行结果尚未回报。';
  if (recovery?.status === 'waiting') return '原会话已有任务执行，正在等待结果。';
  if (item.kind === 'serviceCrash') return item.signals?.available ? '服务已恢复运行；崩溃原因仍需处理。' : '已保留异常退出证据，服务状态待核查。';
  if (item.continuity) return `已核对本实例账号；自动切换${item.continuity.autoSwitch ? '已开启' : '未开启'}，任务结果另行核验。`;
  return '已记录风险；尚无本轮已执行动作的回执。';
}
export function monitoringTitle(item) {
  if (item.continuity?.lastAccountWarning?.state === 'low') return `${item.continuity.lastAccountWarning.remainingPercent === 0 ? '账号额度已耗尽' : '账号即将耗尽'}${item.recovered ? ' · 已恢复' : ''}`;
  const issue = { disk: '磁盘空间不足', diskGrowth: '磁盘短期快速增长', service: '服务运行异常', serviceCrash: '服务发生崩溃', servicePressure: '堆内存接近上限', automation: '自动化执行异常',
    accountContinuity: '账号无法自动接续', api: 'API额度或调用异常' }[item.kind] || '运行异常';
  return `${item.subject || issue}${item.subject ? ` · ${issue}` : ''}${item.recovered ? (item.recoveryStopped ? ' · 已停止' : ' · 已解决') : ''}`;
}
export function renderMonitoringAlert(events, config, { color = false, links = true } = {}) {
  return events.map(item => {
    const recovery = repairFor(item, config), next = monitoringNextStep(item, config);
    const resolved = item.recovered === true;
    const status = resolved ? item.kind === 'serviceCrash' ? '服务已稳定恢复，根因修复待确认' : item.recoveryStopped ? '原任务已停止，不再预警；未认定故障已修复' : '当前问题已解决' : '预警处理中';
    const decision = color && next.type !== 'notice' ? `<font color="red">${next.summary}</font>` : next.summary;
    return `**${text(item.subject || monitoringTitle(item), 120)}**\n当前状态：${status}\n`
      + `上次预警：${alertTime(item.lastAlertAt || item.triggeredAt)}（北京时间）\n`
      + `预警原因：${text(item.kind === 'diskGrowth' && !resolved ? monitoringProblem(item) : item.triggerReason || monitoringProblem(item), 200)}\n`
      + (item.kind === 'diskGrowth' && !resolved ? `观测时间：${alertTime(item.observedAt)}（北京时间）\n` : '')
      + (item.kind === 'serviceCrash' ? `崩溃记录：累计${item.crashCount || 1}次；最近 ${alertTime(item.lastOccurredAt || item.occurredAt)}\n` : '')
      + (!resolved && item.persistentWarningAt ? `**持续告警：连续10分钟未见改善。**（${alertTime(item.persistentWarningAt)}）\n` : '')
      + (resolved ? `处理方式：${item.recoveryStopped ? '任务停止，保留历史记录' : resolutionAttribution(recovery)}\n`
        + `处理结果：${monitoringProgress(item, recovery)}${item.recoveryObservation ? `；复查：${text(item.recoveryObservation, 160)}` : ''}\n`
        + `确认时间：${alertTime(item.recoveredAt || item.observedAt)}\n`
        : `分析与处理：${monitoringProgress(item, recovery)}\n`)
      + `${next.type === 'notice' ? '需要你：' : ''}${decision}`
      + (links && next.url ? `\n[${next.label}](${next.url})` : '');
  }).join('\n\n---\n\n');
}
export function renderMonitoringAlertCard(events, config) {
  const allResolved = events.every(e => e.recovered);
  const title = events.length === 1 ? monitoringTitle(events[0])
    : `${allResolved ? '预警处理结果' : '运行预警'}：${events.map(e => e.subject || monitoringTitle(e)).join('、')}`;
  return { config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title.slice(0, 120) },
      template: allResolved ? 'green' : events.some(e => !e.recovered && e.severity === 'critical') ? 'red' : 'orange' },
    elements: events.flatMap(item => {
      const next = monitoringNextStep(item, config), recovery = repairFor(item, config);
      const original = link(recovery?.sessionId || item.sessionId, config.overviewUrl);
      const evidence = alertEvidenceImage(item), history = alertHistoryPanel(item.history || []);
      if (item.kind === 'diskGrowth' && evidence.length) {
        if (!history.length) history.push({ tag: 'collapsible_panel', expanded: false,
          header: { title: { tag: 'plain_text', content: '历史监测记录' } }, elements: [] });
        history[0].elements.push(...evidence);
      }
      return [ ...(item.kind === 'diskGrowth' ? [] : evidence),
        { tag: 'div', text: { tag: 'lark_md', content: renderMonitoringAlert([item], config, { color: true, links: false }) } },
        ...history,
        ...(original || next.url ? [{ tag: 'action', actions: [{ tag: 'button', type: next.type === 'notice' ? 'default' : 'primary',
          text: { tag: 'plain_text', content: original && next.type === 'notice' ? '查看原始处理对话' : next.label }, url: original || next.url }] }] : [])];
    }) };
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
  for (const item of events) await prepareAlertEvidenceImage(item, config);
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
  for (const item of events) await prepareAlertEvidenceImage(item, config);
  if (message.msg_type === 'interactive') await api(config, 'PATCH', path, { content: JSON.stringify(renderMonitoringAlertCard(events, config)) });
  else if (message.msg_type === 'post') await api(config, 'PUT', path, {
    msg_type: 'post', content: await buildFeishuPostContent(renderMonitoringAlert(events, config).replace(/<\/?sub>/g, '')),
  });
  else throw new Error('UNSUPPORTED_MESSAGE_TYPE');
  return messageId;
}
