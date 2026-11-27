import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createKeyedTaskQueue } from '../../chat/fs-utils.mjs';
import { readRecord, writeDurableJson } from '../../lib/durable-records.mjs';
import { shouldReplyInFeishuThread, shouldReplyToFeishuMessage, buildFeishuApiUuid } from './index.mjs';
import { feishuResponseError } from './delivery-errors.mjs';
import { isFeishuCardExpired, CARD_RENEWAL_NOTICE } from './card-renewal.mjs';

const queue = createKeyedTaskQueue();
const plain = content => ({ tag: 'plain_text', content });
const md = content => ({ tag: 'markdown', content });
const digest = text => createHash('sha256').update(text).digest('hex');
const topicUrl = target => {
  const id = target?.threadId || target?.rootId || target?.messageId;
  return id ? `https://applink.feishu.cn/client/thread/open?open_chat_id=${encodeURIComponent(target.chatId)}&open_thread_id=${encodeURIComponent(id)}` : '';
};
const statusText = record => {
  if (record.phase === 'stopped' || record.task?.state === 'cancelled') return '已停止';
  if (record.phase === 'pending') return '待确认 · 尚未启用';
  if (record.phase === 'confirming') return '已确认 · 正在建立任务话题';
  if (record.phase === 'stopping') return '正在停止';
  if (record.task?.state === 'paused') return record.task.renewal?.awaiting ? '已暂停 · 待交办人续期' : '已暂停';
  if (record.task?.kind === 'one_time' && record.task?.state === 'completed') return '已完成';
  if (record.task?.state === 'failed') return '执行失败';
  if (record.task?.health?.needsAttention) return '已启用 · 最近执行需要处理';
  return '已启用';
};
function timeLabel(d) {
  if (d.kind === 'one_time') return new Date(d.scheduledAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）';
  if (d.everySeconds) return `每 ${d.everySeconds % 3600 === 0 ? `${d.everySeconds / 3600} 小时` : d.everySeconds % 60 === 0 ? `${d.everySeconds / 60} 分钟` : `${d.everySeconds} 秒`}`;
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(d.cron);
  return daily ? `每天 ${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}（${d.timezone}）` : `${d.cron}（${d.timezone}）`;
}

export function buildAutomationCard(record, surface = 'source', renewed = false) {
  const d = record.activatedAt && record.task ? { ...record.definition, title: record.task.title,
    text: record.task.prompt, everySeconds: undefined, cron: undefined, ...record.task.schedule } : record.definition;
  const button = (content, action, type = 'default', extra = {}) => ({ tag: 'button', text: plain(content), type,
    behaviors: [{ type: 'callback', value: { namespace: 'automation-control', key: record.key, action, ...extra } }] });
  const stopped = record.phase === 'stopped' || record.task?.state === 'cancelled';
  const rows = elements => ({ tag: 'column_set', columns: elements.map(element => ({ tag: 'column', width: 'weighted', weight: 1, elements: [element] })) });
  const sourceUrl = topicUrl(record.sourcePlan.target), entryUrl = topicUrl(record.entryTarget);
  const elements = [md(`**${statusText(record)}**\n执行时间：${timeLabel(d)}\n输出与接收方：${d.output}\n预计成本：${d.cost}`),
    ...(record.task?.renewal ? [md('每启动 7 次后暂停；由交办人在飞书私信决定是否继续。')] : []),
    ...(renewed ? [md(CARD_RENEWAL_NOTICE)] : []),
    ...(entryUrl && surface === 'source' ? [md(`[进入任务话题，继续修改或跟进](${entryUrl})`)] : []),
    ...(surface === 'entry' && sourceUrl ? [md(`[查看原交办](${sourceUrl})`)] : []),
    button(record.expanded ? '收起详情' : '查看任务详情', 'details', 'default', { expanded: !record.expanded }),
    ...(record.expanded ? [md(`**执行内容**\n${d.text}\n\n${d.details || '执行、修改和故障处理由同一个固定会话承接。'}`)] : []),
    rows([...(record.phase === 'pending' ? [button('确认启用', 'confirm', 'primary')] : []),
      ...(!stopped ? [button(record.phase === 'pending' ? '取消' : '停止任务', 'stop', 'danger')] : []), button('刷新状态', 'refresh')]),
    md(stopped ? '后续触发已取消；如有当前执行，已请求结束。历史记录保留。'
      : '停止任务会取消后续触发，并请求结束当前自动化执行。旧卡片无响应时，可在任务话题说“停止此自动化”。'),
  ];
  return { schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { template: stopped ? 'grey' : record.phase === 'pending' ? 'orange' : 'blue', title: plain(d.title) }, body: { elements } };
}

async function call(request, path, body) {
  const result = await request(path, body === undefined ? {} : { method: 'POST', body });
  if (!result.response.ok || !result.json?.confirmation) throw Error(result.json?.error || '自动化状态暂不可读。');
  return result.json.confirmation;
}

export function buildScheduleRenewalCard(record) {
  const action = (content, name, type) => ({ tag: 'button', text: plain(content), type,
    behaviors: [{ type: 'callback', value: { namespace: 'automation-control', key: record.key, action: name, version: record.version } }] });
  const tokens = record.tokenCoverage ? `${record.tokens.toLocaleString('zh-CN')}（已记录 ${record.tokenCoverage}/${record.started} 次）` : '暂无实测';
  return { schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { template: 'orange', title: plain(`${record.title} · 待续期`) }, body: { elements: [
      md(`**已暂停，等待你决定**\n第 ${record.batch} 批启动 ${record.started} 次 · 成功 ${record.completed} · 失败 ${record.failed} · 取消 ${record.cancelled}`),
      { tag: 'div', text: plain(`用途：${record.purpose || '见原任务'}\n最近成功：${record.latest || '本批无成功记录'}\n最近异常：${record.failure || '本批无失败或取消记录'}\n本批 Token：${tokens}`) },
      ...(record.entryUrl ? [md(`[查看原任务及最近结果](${record.entryUrl})`)] : []),
      { tag: 'column_set', columns: [action('继续运行 7 次', 'renew', 'primary'), action('停止任务', 'renewal_stop', 'danger')]
        .map(element => ({ tag: 'column', width: 'weighted', weight: 1, elements: [element] })) },
      md('不操作则保持暂停；继续后不补跑暂停期间错过的任务。'),
    ] } };
}

async function sendScheduleRenewalCard(runtime, delivery, request) {
  const { key, version } = delivery.automationControl;
  const path = join(runtime.config.storageDir, 'automation-cards', `${key}-renewal-${version}.json`);
  return queue(path, async () => {
    const result = await request(`/api/automation-confirmations/${key}/renewal`);
    if (!result.response.ok) throw Error(result.json?.error || '续期状态暂不可读。');
    const record = result.json?.renewal;
    if (!record || record.version !== version) return { skipped: true };
    const target = delivery.target;
    if (record.sourceRouteId !== runtime.config.sourceRouteId || record.sourceRouteId !== delivery.sourceRouteId
        || record.openId !== target.privateOpenId || record.tenantKey !== target.tenantKey
        || target.chatType !== 'p2p' || target.chatId || target.messageId) throw Error('Renewal requires the verified owner’s private address');
    const app = runtime.appClient.im.v1.message;
    let saved = await readRecord(path);
    if (!saved?.messageId) {
      if (saved?.creating) throw Object.assign(Error('续期卡发送结果待核实，未重复发送。'), { definiteFailure: true });
      await writeDurableJson(path, { creating: true });
      const response = await app.create({ params: { receive_id_type: 'open_id' }, data: {
        receive_id: record.openId, msg_type: 'interactive', content: JSON.stringify(buildScheduleRenewalCard(record)),
        uuid: buildFeishuApiUuid(`automation-renewal:${key}:${version}`, target),
      } });
      if (response?.code !== 0 || !response.data?.message_id || !response.data?.chat_id) {
        if (Number.isInteger(response?.code) && response.code !== 0) await writeDurableJson(path, { creating: false });
        throw feishuResponseError(response, '续期卡私信发送失败。');
      }
      saved = { messageId: response.data.message_id, message_id: response.data.message_id, chatId: response.data.chat_id };
      await writeDurableJson(path, saved);
    }
    const verified = await app.get({ path: { message_id: saved.messageId } });
    const item = verified?.data?.items?.find(message => message.message_id === saved.messageId);
    if (verified?.code !== 0 || !item || item.deleted || item.msg_type !== 'interactive' || item.chat_id !== saved.chatId
        || (item.chat_type && item.chat_type !== 'p2p')) throw Error('续期卡私信回读失败。');
    await call(request, `/api/automation-confirmations/${key}/receipt`, { surface: 'renewal', version,
      messageId: saved.messageId, chatId: saved.chatId, tenantKey: record.tenantKey, openId: record.openId,
      sourceRouteId: record.sourceRouteId });
    return saved;
  });
}

export async function sendAutomationCard(runtime, delivery, { request }) {
  const ref = delivery.automationControl;
  if (ref?.surface === 'renewal') {
    if (!/^[a-f0-9]{24}$/.test(ref.key || '') || !/^[a-f0-9]{24}$/.test(ref.version || '')) throw Error('Invalid renewal card reference');
    return sendScheduleRenewalCard(runtime, delivery, request);
  }
  if (!/^[a-f0-9]{24}$/.test(ref?.key || '') || !['source', 'entry'].includes(ref.surface)) throw Error('Invalid automation card reference');
  const path = join(runtime.config.storageDir, 'automation-cards', `${ref.key}-${ref.surface}.json`);
  return queue(path, async () => {
    let record = await call(request, `/api/automation-confirmations/${ref.key}`);
    if (record.sourcePlan.sourceRouteId !== runtime.config.sourceRouteId || delivery.target.chatId !== record.sourcePlan.target.chatId) throw Error('Automation card route mismatch');
    let saved = await readRecord(path);
    const entry = ref.surface === 'entry';
    if (entry && !record.confirmedAt) throw Error('Automation is not confirmed');
    if (entry && ['stopping', 'stopped'].includes(record.phase) && !saved?.messageId) return { skipped: true };
    const app = runtime.appClient.im.v1.message;
    let content = JSON.stringify(buildAutomationCard(record, ref.surface, saved?.renewed));
    if (saved?.messageId && !saved.expired && saved.contentHash !== digest(content)) {
      try {
        const patched = await app.patch({ path: { message_id: saved.messageId }, data: { content } });
        if (patched?.code !== 0) throw feishuResponseError(patched, '自动化卡片更新失败。');
      } catch (error) {
        if (!isFeishuCardExpired(error)) throw error;
        saved = { ...saved, expired: true, renewed: true };
        await writeDurableJson(path, saved);
      }
    }
    if (!saved?.messageId || saved.expired) {
      if (saved?.creating) throw Object.assign(Error('卡片发送结果待核实，未重复发送。'), { definiteFailure: true });
      const target = entry ? (record.entryTarget || record.entryPlan.target) : record.sourcePlan.target;
      content = JSON.stringify(buildAutomationCard(record, ref.surface, saved?.renewed));
      const generation = (saved?.generation || 0) + 1;
      saved = { ...saved, creating: true, target, generation };
      await writeDurableJson(path, saved);
      const data = { msg_type: 'interactive', content, uuid: buildFeishuApiUuid(`automation:${ref.key}:${ref.surface}:${generation}`, target) };
      let response;
      try {
        response = shouldReplyToFeishuMessage(target)
          ? await app.reply({ path: { message_id: target.messageId }, data: { ...data, reply_in_thread: shouldReplyInFeishuThread(target) } })
          : await app.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: target.chatId } });
        if (response?.code !== 0 || !response.data?.message_id) throw feishuResponseError(response, '自动化卡片发送失败。');
      } catch (error) {
        if (Number.isInteger(response?.code) && response.code !== 0) await writeDurableJson(path, { ...saved, creating: false });
        throw error;
      }
      saved = { ...saved, creating: false, expired: false, messageId: response.data.message_id,
        message_id: response.data.message_id, thread_id: response.data.thread_id || (entry ? target.threadId || response.data.message_id : target.threadId || '') };
      await writeDurableJson(path, saved);
    }
    const verified = await app.get({ path: { message_id: saved.messageId } });
    const item = verified?.data?.items?.find(message => message.message_id === saved.messageId);
    if (verified?.code !== 0 || !item || item.deleted || item.msg_type !== 'interactive' || item.chat_id !== saved.target.chatId) throw Error('自动化卡片回读失败。');
    record = await call(request, `/api/automation-confirmations/${ref.key}/receipt`, { surface: ref.surface,
      messageId: saved.messageId, threadId: saved.thread_id, chatId: saved.target.chatId, sourceRouteId: runtime.config.sourceRouteId });
    // Receipt may activate a previously paused task. Render authoritative state.
    const finalContent = JSON.stringify(buildAutomationCard(record, ref.surface, saved.renewed));
    if (finalContent !== content) {
      const patched = await app.patch({ path: { message_id: saved.messageId }, data: { content: finalContent } });
      if (patched?.code !== 0) throw feishuResponseError(patched, '自动化已处理，卡片更新失败。');
    }
    saved.contentHash = digest(finalContent);
    await writeDurableJson(path, saved);
    return saved;
  });
}

export async function handleAutomationCardAction(runtime, raw, { request, authorize }) {
  const event = raw?.event || raw;
  let value = event.action?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (value?.namespace !== 'automation-control') return null;
  const reply = (content, type = 'error') => ({ toast: { type, content } });
  try {
    if (!/^[a-f0-9]{24}$/.test(value.key || '')) throw Error('卡片无效。');
    const openId = event.operator?.open_id || event.operator?.operator_id?.open_id || '';
    const tenantKey = event.operator?.tenant_key || event.tenant_key || raw.header?.tenant_key || '';
    const chatId = event.context?.open_chat_id || '', messageId = event.context?.open_message_id || '';
    if (!openId || !tenantKey || !await authorize?.({ chatId, messageId, tenantKey,
      sender: { openId, tenantKey, senderType: 'user' } })) throw Error('当前身份无权操作这条自动化。');
    const record = await call(request, `/api/automation-confirmations/${value.key}/action`, {
      action: value.action, version: value.version, expanded: value.expanded === true, openId, tenantKey, chatId, messageId,
      sourceRouteId: runtime.config.sourceRouteId, eventId: raw.header?.event_id || event.event_id || '',
    });
    // Durable outbox updates both cards; no network message update delays the
    // callback acknowledgement or rolls back a successful cancellation.
    if (value.action === 'renew' || value.action === 'renewal_stop') {
      const resumed = record.status === 'active';
      const content = resumed ? '已续期，按原频率继续，最多再启动 7 次。' : '任务已停止，历史记录保留。';
      return { ...reply(content, 'success'), card: { type: 'raw', data: {
        schema: '2.0', config: { update_multi: true, enable_forward: false },
        header: { template: resumed ? 'blue' : 'grey', title: plain(resumed ? '已续期' : '已停止') },
        body: { elements: [md(content)] },
      } } };
    }
    return reply(value.action === 'stop' ? '后续触发已取消，当前执行已请求停止。'
      : value.action === 'confirm' ? statusText(record) : '正在更新卡片。', 'success');
  } catch (error) { return reply(error.message); }
}
