import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRecordStore, serialQueue } from '../../lib/durable-records.mjs';
import { buildFeishuTopicId, isFeishuTopicGroup } from './index.mjs';
import { getFeishuConversationSettings, setFeishuConversationMuted } from './conversation-settings.mjs';
import { recordFeishuOutboundMessageSession } from './session-flow.mjs';
import { effectiveFeishuGroup } from './group-settings.mjs';
import { buildGroupConfigurationCard } from './group-configuration-card.mjs';
import { mentionsFeishuBot } from './response-policy.mjs';

const MODES = new Set(['active', 'listening', 'paused']);
const LABELS = { active: '主动参与', listening: '旁听', paused: '暂停接收' };
const hasModeOverride = record => record?.modeOverride === true
  || (record?.modeOverride === undefined && Boolean(record?.updatedAt || ['listening', 'paused'].includes(record?.mode)));
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

export const participationAllowsMessage = (state, summary) => state.mode === 'active'
  || state.invitedMessages?.includes(summary.messageId) === true;

export function participationEnabled(runtime, summary) {
  if (!summary?.chatId || isFeishuTopicGroup(summary) || ['p2p', 'private'].includes(summary.chatType)) return false;
  const group = effectiveFeishuGroup(runtime.config, summary.chatId);
  return group?.participationMode === 'ambient' && group.participationControls === true;
}

// Explicit controls also work while reception is paused. No small model
// interprets or changes participation state.
export function parseParticipationText(text) {
  const s = String(text || '').replace(/^\s*(?:@_[A-Za-z0-9_]+\s*)+/, '').trim();
  if (s === '/mute') return 'listening';
  if (s === '/unmute') return 'active';
  if (s.length > 140 || /[“”"`]|(?:他说|她说|例如|比如|如果|规则|机制|应该)/.test(s)) return null;
  const plain = s.replace(/^(?:(?:AI|Agent|agent|机器人|茵蒂克丝|你|请|麻烦|现在|接下来|先|暂时)[，,\s]*)+/, '')
    .replace(/[。！!，,\s]+$/, '');
  if (/^(?:恢复|重新开启|开启|切换到)(?:主动)?参与(?:模式)?(?:吧|一下)?$/.test(plain)
      || /^(?:可以|继续)(?:主动)?参与(?:了|吧)?$/.test(plain)) return 'active';
  if (/^(?:恢复|继续)(?:读取|接收)(?:群)?消息(?:吧|了)?$/.test(plain)) return 'resume_read';
  if (/^(?:旁听(?:模式)?|只旁听|只听不说|切换到旁听(?:模式)?|别参与(?:了)?|不要参与(?:了)?|别插话(?:了)?|别说话(?:了)?|安静|闭嘴)(?:吧|一下)?(?:[，,](?:我们|大家).*)?$/.test(plain)) return 'listening';
  if (/^(?:暂停(?:接收|读取)(?:群消息|消息)?|停止(?:接收|读取)(?:群消息|消息)?|别读(?:后面的|接下来的|群里)?消息(?:了)?|不要再读(?:群)?消息)(?:吧|一下)?$/.test(plain)) return 'paused';
  return null;
}

export function buildParticipationCard(record, configuration = null) {
  if (configuration && !record.source.topicId) return buildGroupConfigurationCard(record, configuration);
  const scope = record.source.topicId ? '这个话题' : '本群主讨论';
  const detail = { active: '持续接收消息，自主判断是否参与。',
    listening: '持续接收消息；@我或使用任务命令可单次邀请。', paused: '普通消息不进入 Session；@我可单次邀请，之后仍保持暂停。' }[record.mode];
  const actions = [...MODES].map(mode => ({ tag: 'button', type: mode === record.mode ? 'primary' : 'default',
    text: { tag: 'plain_text', content: LABELS[mode] }, value: {
      namespace: 'participation', key: record.key, mode, epoch: record.epoch || 0,
    } }));
  return { config: { wide_screen_mode: true, update_multi: true }, header: {
    template: record.mode === 'active' ? 'green' : record.mode === 'listening' ? 'blue' : 'grey',
    title: { tag: 'plain_text', content: `Agent 状态 · ${LABELS[record.mode]}` },
  }, elements: [
    ...(record.cardRenewalNotice ? [{ tag: 'div', text: { tag: 'plain_text', content: record.cardRenewalNotice } }] : []),
    { tag: 'div', text: { tag: 'lark_md', content: `**${scope} · 直到明确切换**\n${detail}` } },
    ...(record.mode === 'listening' && record.topicHint
      ? [{ tag: 'div', text: { tag: 'plain_text', content: '换了话题，要我参与吗？@我即可。' } }] : []),
    ...(record.stopPending ? [{ tag: 'div', text: { tag: 'plain_text', content: '正在停止当前任务。' } }] : []),
    { tag: 'action', actions },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '文字也能切换：“先旁听”“暂停接收消息”“恢复参与”。' }] },
  ] };
}

export function createParticipationController(runtime, { resolveSession, cancelSession, cleanup, getConfiguration,
  resolveSource = async source => source, authorize = async () => false } = {}) {
  const records = createRecordStore(join(runtime.config.storageDir, 'participation-state'));
  const queues = new Map();
  const publishQueues = new Map();
  const sourceFor = summary => ({ sourceRouteId: runtime.config.sourceRouteId || 'default',
    tenantKey: summary.tenantKey || summary.accountId || summary.sender?.tenantKey || '',
    chatId: summary.chatId, topicId: buildFeishuTopicId(summary),
    messageId: summary.messageId || '',
    chatType: summary.chatType, chatMode: summary.chatMode, groupMessageType: summary.groupMessageType });
  const keyFor = summary => {
    const { sourceRouteId, tenantKey, chatId, topicId } = sourceFor(summary);
    return hash(JSON.stringify({ sourceRouteId, tenantKey, chatId, topicId }));
  };
  const exclusive = (key, fn) => {
    if (!queues.has(key)) queues.set(key, serialQueue());
    return queues.get(key)(fn);
  };
  async function state(summary) {
    const key = keyFor(summary);
    const existing = await records.get(key);
    const source = sourceFor(summary);
    const muted = (await getFeishuConversationSettings(runtime, summary)).muted;
    const group = effectiveFeishuGroup(runtime.config, summary.chatId);
    const initial = muted ? 'paused' : group.initialParticipationMode || 'active';
    const override = hasModeOverride(existing);
    const parent = source.topicId && !override ? await state({ ...summary, topicId: '', threadId: '', rootId: '',
      parentId: '', conversationKind: 'main', chatMode: 'group', groupMessageType: 'group' }) : null;
    const mode = muted ? 'paused' : override ? existing.mode : parent?.mode || initial;
    const epoch = override ? existing.epoch : parent?.epoch || existing?.epoch || 0;
    return { invitedMessages: [], processedControls: [], ...existing, key, source, mode, epoch,
      modeOverride: override,
      ...(parent ? { beforePause: parent.beforePause, contextAfterMs: Math.max(parent.contextAfterMs || 0, existing?.contextAfterMs || 0),
        ...(existing?.epoch !== epoch ? { invitedMessages: [] } : {}) } : {}) };
  }

  async function remember(summary, sessionId, recent = []) {
    const key = keyFor(summary);
    const prior = await state(summary);
    const record = await records.mutate(key, current => ({ ...current, ...prior, sessionId,
      // Preserve a semantic anchor across follow-ups; don't compare a new topic
      // against the mode command itself.
      topicAnchor: (current?.mode === 'listening' ? current.topicAnchor : '') || recent.slice(-5).map(x => x.text).join('\n').slice(-2500)
        || String(summary.messageText || summary.textPreview || '').slice(0, 1200),
    }));
    if (getConfiguration && !record.source.topicId) {
      try { return await publish(record); }
      catch (error) { console.warn(`[feishu-group-configuration] card refresh failed: ${error.message}`); }
    }
    return record;
  }
  async function publish(record, options = {}) {
    if (!publishQueues.has(record.key)) publishQueues.set(record.key, serialQueue());
    return publishQueues.get(record.key)(() => publishCurrent(record, options));
  }
  async function publishCurrent(record, { existingOnly = false } = {}) {
    const source = await resolveSource({ ...record.source, threadId: record.source.topicId });
    if (isFeishuTopicGroup(source)) return record;
    record = { ...record, ...await state(source) };
    // Withdrawing a status card does not change participation or intake. Keep
    // the durable opt-out when restoring or changing modes so it cannot resend.
    if (record.cardSuppressed === true
        || effectiveFeishuGroup(runtime.config, record.source.chatId).participationStatusCard === false) return record;
    const configuration = !record.source.topicId ? await getConfiguration?.(record) : null;
    const group = effectiveFeishuGroup(runtime.config, record.source.chatId);
    let messageId = record.cardMessageId || (!record.source.topicId ? group.participationStatusMessageId : '');
    if (existingOnly && !messageId) return record;
    const createdAt = record.cardCreatedAt || Date.now();
    if (messageId && !existingOnly && Date.now() - createdAt >= 13 * 86400_000) {
      record = { ...record, cardRenewalNotice: '旧卡片已满13天，更换新卡片' };
    }
    const card = buildParticipationCard(record, configuration);
    const digest = hash(JSON.stringify(card));
    if (messageId && digest === record.cardDigest && !record.pinPending
        && Date.now() - createdAt < 13 * 86400_000) return record;
    if (messageId && (existingOnly || Date.now() - createdAt < 13 * 86400_000)) {
      const result = await runtime.appClient.im.v1.message.patch({ path: { message_id: messageId },
        data: { content: JSON.stringify(card) } });
      if (result?.code) throw new Error(result.msg || 'Agent status card update failed');
    } else {
      const uuid = `part_${record.key}_${Math.floor(Date.now() / 86400_000)}`;
      const result = record.source.topicId
        ? await runtime.appClient.im.v1.message.reply({ path: { message_id: record.source.messageId },
          data: { msg_type: 'interactive', content: JSON.stringify(card), uuid, reply_in_thread: true } })
        : await runtime.appClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' },
          data: { receive_id: record.source.chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid } });
      if (result?.code || !result?.data?.message_id) throw new Error(result?.msg || 'Agent status card creation failed');
      messageId = result.data.message_id;
      // Commit the successful send before pinning; retry cannot duplicate it.
      record = await records.mutate(record.key, current => ({ ...record, ...current,
        cardMessageId: messageId, cardCreatedAt: Date.now(), cardRenewalNotice: record.cardRenewalNotice || '',
        pinPending: !record.source.topicId }));
      // A retried idempotent create may return the card from an earlier
      // uncertain send. Bring that exact message to the current durable state.
      const updated = await runtime.appClient.im.v1.message.patch({ path: { message_id: messageId },
        data: { content: JSON.stringify(card) } });
      if (updated?.code) throw new Error(updated.msg || 'Agent status card update failed');
    }
    if (record.pinPending && !existingOnly) {
      const result = await runtime.appClient.im.v1.chatTopNotice.putTopNotice({ path: { chat_id: record.source.chatId },
        data: { chat_top_notice: [{ action_type: '1', message_id: messageId }] } });
      if (result?.code) throw new Error(result.msg || 'Agent status card pin failed');
    }
    if (runtime.storagePaths?.messageIndexPath && record.sessionId) {
      await recordFeishuOutboundMessageSession(runtime, { ...record.source, chatType: 'group',
        conversationKind: record.source.topicId ? 'thread' : 'main',
        ...(record.source.topicId ? { threadId: record.source.topicId, rootId: record.source.topicId } : {}),
      }, record.sessionId, messageId);
    }
    return records.mutate(record.key, current => ({ ...record, ...current, cardMessageId: messageId,
      cardCreatedAt: current?.cardCreatedAt || createdAt, cardDigest: digest, pinPending: existingOnly ? record.pinPending : false }));
  }
  async function change(summary, requested, { sessionId = '', controlId = summary.eventId || summary.messageId, existingOnly = false } = {}) {
    const key = keyFor(summary);
    return exclusive(key, async () => {
      let prior = await state(summary);
      if (prior.processedControls?.includes(controlId)) return publish(prior, { existingOnly });
      const mode = requested === 'resume_read' ? (prior.beforePause || 'listening') : requested;
      if (!MODES.has(mode)) throw new Error('Invalid Agent participation mode');
      let record = await records.mutate(key, current => ({ ...prior, ...current, source: sourceFor(summary), mode, modeOverride: true,
        beforePause: mode === 'paused' ? (prior.mode === 'paused' ? prior.beforePause : prior.mode) : prior.beforePause,
        // Reasserting active reception is a no-op for ongoing work. Advancing
        // its epoch would silently suppress otherwise valid replies.
        epoch: prior.mode === 'active' && mode === 'active' ? (prior.epoch || 0) : (prior.epoch || 0) + 1,
        topicHint: false, invitedMessages: [],
        stopPending: mode !== 'active', updatedAt: new Date().toISOString(),
        ...((prior.mode === 'paused' && mode !== 'paused') || (prior.mode !== 'active' && mode === 'active')
          ? { contextAfterMs: Date.now(), topicAnchor: '' } : {}),
      }));
      // Intake is fenced as soon as mode is durable. Acknowledgement follows
      // cancellation, not merely the card change.
      await setFeishuConversationMuted(runtime, summary, false);
      if (mode !== 'active') {
        const target = sessionId || record.sessionId || await resolveSession?.(summary);
        if (target) {
          try { await cancelSession(target, record); }
          catch (error) { await publish(record, { existingOnly }); throw error; }
        }
        await cleanup?.(record);
        if (!record.source.topicId) {
          for (const child of await records.active()) {
            if (!child.source?.topicId || hasModeOverride(child)
                || child.source.chatId !== record.source.chatId
                || child.source.tenantKey !== record.source.tenantKey
                || child.source.sourceRouteId !== record.source.sourceRouteId) continue;
            if (child.sessionId) await cancelSession(child.sessionId, child);
            await cleanup?.(child);
          }
        }
      }
      record = await records.mutate(key, current => ({ ...current, stopPending: false,
        processedControls: [...(current.processedControls || []), controlId].filter(Boolean).slice(-100) }));
      return publish(record, { existingOnly });
    });
  }
  async function assess(summary, { mentioned = false, taskCommand = false } = {}) {
    const key = keyFor(summary);
    return exclusive(key, async () => {
      let record = await state(summary);
      if (record.mode === 'active') return true;
      const forOther = summary.mentions?.length && !mentioned;
      const invited = !forOther && (mentioned || (record.mode === 'listening' && taskCommand));
      record = await records.mutate(key, current => ({ ...current, ...record,
        ...(invited ? { invitedMessages: [...new Set([...(current?.invitedMessages || []), summary.messageId])].slice(-100), topicHint: false }
          : {}),
      }));
      await publish(record);
      return invited;
    });
  }
  async function intake(summary, snapshot = null) {
    if (!participationEnabled(runtime, summary) || ['app', 'bot'].includes(summary.sender?.senderType)) return null;
    const record = await state(summary);
    if (record.processedControls?.includes(summary.messageId)) {
      await publish(record);
      return { participationControl: true, duplicate: true };
    }
    const others = (summary.mentions || []).some(x => x.openId && x.openId !== runtime.botIdentity?.openId);
    const addressed = mentionsFeishuBot(runtime, summary);
    const mode = !others || addressed ? parseParticipationText(summary.messageText || summary.textPreview) : null;
    if (mode) { await change(summary, mode); return { participationControl: true, mode }; }
    const at = Number(summary.createTime);
    const messageTime = at > 0 ? (at < 10_000_000_000 ? at * 1000 : at) : snapshot?.receivedAt;
    if ((snapshot && snapshot.epoch !== record.epoch && snapshot.mode !== 'active')
        || (record.contextAfterMs && messageTime && messageTime < record.contextAfterMs)) {
      return { ignored: true, reason: 'participation_before_resume' };
    }
    if (record.mode === 'paused') {
      if (!addressed) return { ignored: true, reason: 'participation_paused' };
      await assess(summary, { mentioned: true });
    }
    return null;
  }
  async function action(raw) {
    const event = raw.event || raw;
    let value = event.action?.value;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    if (value?.namespace !== 'participation') return null;
    const record = /^[a-f0-9]{24}$/.test(value.key || '') ? await records.get(value.key) : null;
    const chatId = event.context?.open_chat_id || event.context?.chat_id;
    const messageId = event.context?.open_message_id || event.context?.message_id;
    const actor = event.operator?.operator_id?.open_id || event.operator?.open_id;
    const summary = await resolveSource({ ...record?.source, chatId, chatType: 'group', messageId,
      ...(record?.source.topicId ? { threadId: record.source.topicId } : {}),
      sender: { senderType: 'user', openId: actor }, eventId: raw.header?.event_id || event.event_id });
    if (!record || !actor || record.source.chatId !== chatId || record.cardMessageId !== messageId
        || !MODES.has(value.mode) || value.epoch !== (await state(summary)).epoch || !participationEnabled(runtime, summary)
        || !await authorize(summary)) return { toast: { type: 'error', content: '状态已变化或无权操作，请看最新卡片。' } };
    void change(summary, value.mode, { controlId: summary.eventId || `button:${actor}:${record.epoch}:${value.mode}` })
      .catch(error => console.warn(`[feishu-participation] ${error.message}`));
    return { toast: { type: 'info', content: '正在切换，生效后卡片会更新。' } };
  }
  async function restore() {
    for (const record of await records.active()) {
      const source = await resolveSource(record.source);
      if (!participationEnabled(runtime, source)) continue;
      if (record.stopPending) await change(source, record.mode,
        { sessionId: record.sessionId, controlId: `restore:${record.epoch}`, existingOnly: true });
      else {
        if (record.mode !== 'active') await cleanup?.(record);
        try { await publish({ ...record, source }, { existingOnly: true }); }
        catch (error) { console.warn(`[feishu-participation] card restore failed: ${error.message}`); }
      }
    }
  }
  return { state, remember, change, assess, intake, action, restore, publish, record: key => records.get(key),
    idle: async () => { await Promise.all([...queues.values(), ...publishQueues.values()].map(queue => queue.idle())); await records.idle(); } };
}
