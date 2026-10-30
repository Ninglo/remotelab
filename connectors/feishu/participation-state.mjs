import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRecordStore, serialQueue } from '../../lib/durable-records.mjs';
import { buildFeishuTopicId, isFeishuTopicGroup } from './index.mjs';
import { getFeishuConversationSettings, setFeishuConversationMuted } from './conversation-settings.mjs';
import { recordFeishuOutboundMessageSession } from './session-flow.mjs';
import { effectiveFeishuGroup } from './group-settings.mjs';
import { buildGroupConfigurationCard } from './group-configuration-card.mjs';
import { mentionsFeishuBot } from './response-policy.mjs';
import { classifyFeishuDeliveryError, feishuResponseError } from './delivery-errors.mjs';
import { CARD_UPDATE_WINDOW_MS, CARD_RENEWAL_NOTICE, isFeishuCardExpired, readCardCreatedAt } from './card-renewal.mjs';

const MODES = new Set(['active', 'paused']);
const LABELS = { active: '接收消息', paused: '暂停接收' };
// Read old opt-outs as mute; never resume them or collect observations.
const currentMode = mode => mode === 'listening' ? 'paused' : mode;
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
  if (s === '/mute') return 'paused';
  if (s === '/unmute') return 'active';
  if (s.length > 140 || /[“”"`]|(?:他说|她说|例如|比如|如果|规则|机制|应该)/.test(s)) return null;
  const plain = s.replace(/^(?:(?:AI|Agent|agent|机器人|茵蒂克丝|你|请|麻烦|现在|接下来|先|暂时)[，,\s]*)+/, '')
    .replace(/[。！!，,\s]+$/, '');
  if (/^(?:恢复|重新开启|开启|切换到)(?:主动)?参与(?:模式)?(?:吧|一下)?$/.test(plain)
      || /^(?:可以|继续)(?:主动)?参与(?:了|吧)?$/.test(plain)) return 'active';
  if (/^(?:恢复|继续)(?:读取|接收)(?:群)?消息(?:吧|了)?$/.test(plain)) return 'resume_read';
  if (/^(?:暂停(?:接收|读取)(?:群消息|消息)?|停止(?:接收|读取)(?:群消息|消息)?|别读(?:后面的|接下来的|群里)?消息(?:了)?|不要再读(?:群)?消息)(?:吧|一下)?$/.test(plain)) return 'paused';
  return null;
}

export function buildParticipationCard(record, configuration = null) {
  if (configuration && !record.source.topicId) return buildGroupConfigurationCard(record, configuration);
  const scope = record.source.topicId ? '这个话题' : '本群主讨论';
  const detail = { active: record.source.topicId ? '话题消息继续交给 Agent；仅暂停当前话题后停止接收。'
    : '持续接收群主线消息，按讨论需要参与。',
    paused: '普通消息不进入 Session；@我可单次邀请，之后仍保持暂停。' }[record.mode];
  const actions = [...MODES].map(mode => ({ tag: 'button', type: mode === record.mode ? 'primary' : 'default',
    text: { tag: 'plain_text', content: LABELS[mode] }, value: {
      namespace: 'participation', key: record.key, mode, epoch: record.epoch || 0,
    } }));
  return { config: { wide_screen_mode: true, update_multi: true }, header: {
    template: record.mode === 'active' ? 'green' : 'grey',
    title: { tag: 'plain_text', content: `Agent 状态 · ${LABELS[record.mode]}` },
  }, elements: [
    ...(record.cardRenewalNotice ? [{ tag: 'div', text: { tag: 'plain_text', content: record.cardRenewalNotice } }] : []),
    { tag: 'div', text: { tag: 'lark_md', content: `**${scope} · 直到明确切换**\n${detail}` } },
    ...(record.stopPending ? [{ tag: 'div', text: { tag: 'plain_text', content: '正在停止当前任务。' } }] : []),
    { tag: 'action', actions },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '/mute 暂停当前范围，/unmute 恢复接收。群主线与各话题独立。' }] },
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
    let existing = await records.get(key);
    if (existing?.mode === 'listening') {
      existing = await records.mutate(key, current => current?.mode === 'listening'
        ? { ...current, mode: 'paused', retiredParticipationMode: 'listening' } : current);
    }
    const source = sourceFor(summary);
    const muted = (await getFeishuConversationSettings(runtime, summary)).muted;
    const group = effectiveFeishuGroup(runtime.config, summary.chatId);
    const initial = source.topicId ? 'active' : currentMode(group.initialParticipationMode) || 'active';
    const override = hasModeOverride(existing);
    const mode = muted ? 'paused' : override ? currentMode(existing.mode) : initial;
    const epoch = existing?.epoch || 0;
    const deliveryEpochFloor = existing?.deliveryEpochFloor ?? epoch;
    return { invitedMessages: [], processedControls: [], ...existing, key, source, mode, epoch, deliveryEpochFloor,
      modeOverride: override };
  }

  async function remember(summary, sessionId, recent = [], { refreshCard = true } = {}) {
    const key = keyFor(summary);
    const prior = await state(summary);
    const record = await records.mutate(key, current => ({ ...current, ...prior, sessionId }));
    if (refreshCard && getConfiguration && !record.source.topicId) {
      const existing = Boolean(record.cardMessageId
        || effectiveFeishuGroup(runtime.config, record.source.chatId).participationStatusMessageId);
      try { return await publish(record, { existingOnly: existing, background: existing }); }
      catch (error) { console.warn(`[feishu-group-configuration] card refresh failed: ${error.message}`); }
    }
    return record;
  }
  async function publish(record, options = {}) {
    if (!publishQueues.has(record.key)) publishQueues.set(record.key, serialQueue());
    return publishQueues.get(record.key)(() => publishCurrent(record, options));
  }
  async function publishCurrent(record, { existingOnly = false, background = false } = {}) {
    const source = await resolveSource({ ...record.source, threadId: record.source.topicId });
    // Keep an already managed group card accurate after a group becomes a
    // native topic group, without creating new cards or reviving topic controls.
    if (isFeishuTopicGroup(source)) {
      if (!getConfiguration || record.source.topicId || !record.cardMessageId) return record;
      // Legacy group records may remember an ordinary input message. It must
      // not become a native topic address when metadata is refreshed.
      source.messageId = ''; source.rootId = ''; source.parentId = ''; source.threadId = ''; source.topicId = '';
    }
    record = { ...record, ...await state(source) };
    // Withdrawing a status card does not change participation or intake. Keep
    // the durable opt-out when restoring or changing modes so it cannot resend.
    if (record.cardSuppressed === true
        || effectiveFeishuGroup(runtime.config, record.source.chatId).participationStatusCard === false) return record;
    // Topic replies are bounded interactions, not persistent dashboards.
    if (background && record.source.topicId) return record;
    const configuration = !record.source.topicId ? await getConfiguration?.(record) : null;
    const group = effectiveFeishuGroup(runtime.config, record.source.chatId);
    let messageId = record.cardMessageId || (!record.source.topicId ? group.participationStatusMessageId : '');
    if (existingOnly && !messageId) return record;
    // Existing legacy records committed pinPending=false only after a successful
    // top-notice write. New records retain the exact acknowledged pin binding.
    const managedPin = !record.source.topicId && Boolean(messageId) && (
      record.pinnedMessageId === messageId || record.pinPending
      || (!Object.hasOwn(record, 'pinnedMessageId') && record.pinPending === false)
      || (!Object.hasOwn(record, 'pinnedMessageId') && !record.cardMessageId && group.participationStatusMessageId === messageId));
    if (background && !managedPin) return record;
    if (record.cardRenewalPending) throw new Error('换卡发送结果待核实，未重复发送。');
    const semanticConfiguration = configuration?.project ? { ...configuration,
      project: { ...configuration.project, briefUpdated: '' } } : configuration;
    const semanticCard = buildParticipationCard({ ...record, cardRenewalNotice: '' }, semanticConfiguration);
    const contentDigest = hash(JSON.stringify(semanticCard));
    const existingCard = buildParticipationCard(record, configuration);
    const sameContent = record.cardContentDigest
      ? record.cardContentDigest === contentDigest
      : record.cardDigest === hash(JSON.stringify(existingCard));
    // The compact card links to the brief rather than displaying its body.
    // Track body changes separately; changing only its date stays a no-op.
    const briefContentHash = configuration?.project?.briefContentHash || '';
    const sameBrief = !briefContentHash || record.cardBriefContentHash === briefContentHash;
    // Content comparison precedes every age read and renewal decision.
    if (messageId && sameContent && sameBrief && !record.pinPending) return record;
    let createdAt = record.cardCreatedAt || 0;
    const rejected = record.cardUpdateFailure?.messageId === messageId && record.cardUpdateFailure?.code === 230031;
    if (messageId && !createdAt && !rejected) {
      createdAt = await readCardCreatedAt(runtime, messageId);
      record = await records.mutate(record.key, current => ({ ...record, ...current,
        cardMessageId: messageId, cardCreatedAt: createdAt }));
    }
    const renewing = Boolean(messageId) && (rejected || Date.now() - createdAt >= CARD_UPDATE_WINDOW_MS);
    // An expired conversation card stays historical. Current interaction state
    // remains authoritative and can still be read through the normal dialogue.
    if (renewing && record.source.topicId) return record;
    if (renewing && background && !managedPin) return record;
    if (renewing) {
      record = { ...record, cardRenewalNotice: CARD_RENEWAL_NOTICE };
    }
    const card = buildParticipationCard(record, configuration);
    const digest = hash(JSON.stringify(card));
    if (messageId && !renewing) {
      try {
        const result = await runtime.appClient.im.v1.message.patch({ path: { message_id: messageId },
          data: { content: JSON.stringify(card) } });
        if (result?.code) throw feishuResponseError(result, 'Agent status card update failed');
      } catch (error) {
        if (!isFeishuCardExpired(error)) throw error;
        await records.mutate(record.key, current => ({ ...record, ...current, cardUpdateFailure: {
          messageId, code: 230031, at: new Date().toISOString(), logId: error.logId || '',
        } }));
        return publishCurrent(record, { existingOnly, background });
      }
    } else {
      const previousMessageId = messageId;
      const uuid = renewing ? `part_renew_${hash(`${record.key}:${messageId}`)}`
        : `part_${record.key}_${Math.floor(Date.now() / 86400_000)}`;
      if (renewing) await records.mutate(record.key, current => ({ ...record, ...current,
        cardRenewalPending: { uuid, previousMessageId, startedAt: new Date().toISOString() } }));
      let result;
      try {
        result = record.source.topicId
          ? await runtime.appClient.im.v1.message.reply({ path: { message_id: record.source.messageId },
            data: { msg_type: 'interactive', content: JSON.stringify(card), uuid, reply_in_thread: true } })
          : await runtime.appClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' },
            data: { receive_id: record.source.chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid } });
        if (result?.code) throw feishuResponseError(result, 'Agent status card creation failed');
        if (!result?.data?.message_id) throw new Error('Agent status card creation receipt missing');
      } catch (error) {
        if (renewing && classifyFeishuDeliveryError(error).definiteFailure) {
          await records.mutate(record.key, current => ({ ...current, cardRenewalPending: null,
            cardRenewalFailure: { at: new Date().toISOString(), error: classifyFeishuDeliveryError(error).error } }));
        }
        throw error;
      }
      messageId = result.data.message_id;
      // Commit the successful send before pinning; retry cannot duplicate it.
      record = await records.mutate(record.key, current => ({ ...record, ...current,
        cardMessageId: messageId, cardCreatedAt: Number(result.data.create_time) || Date.now(),
        cardRenewalPending: null, cardRenewalNotice: record.cardRenewalNotice || '',
        ...(renewing ? { cardHistory: [...(current?.cardHistory || []), {
          messageId: previousMessageId, createdAt, replacedAt: new Date().toISOString(),
          updateFailure: current?.cardUpdateFailure || null,
        }] } : {}),
        pinPending: !record.source.topicId }));
      // A retried idempotent create may return the card from an earlier
      // uncertain send. Bring that exact message to the current durable state.
      const updated = await runtime.appClient.im.v1.message.patch({ path: { message_id: messageId },
        data: { content: JSON.stringify(card) } });
      if (updated?.code) throw new Error(updated.msg || 'Agent status card update failed');
    }
    const canPin = !record.source.topicId && (!existingOnly || managedPin);
    if (record.pinPending && canPin) {
      const result = await runtime.appClient.im.v1.chatTopNotice.putTopNotice({ path: { chat_id: record.source.chatId },
        data: { chat_top_notice: [{ action_type: '1', message_id: messageId }] } });
      if (result?.code) throw new Error(result.msg || 'Agent status card pin failed');
      record = await records.mutate(record.key, current => ({ ...current, pinnedMessageId: messageId, pinPending: false }));
    }
    if (runtime.storagePaths?.messageIndexPath && record.sessionId) {
      await recordFeishuOutboundMessageSession(runtime, { ...record.source, chatType: 'group',
        conversationKind: record.source.topicId ? 'thread' : 'main',
        ...(record.source.topicId ? { threadId: record.source.topicId, rootId: record.source.topicId } : {}),
      }, record.sessionId, messageId);
    }
    return records.mutate(record.key, current => ({ ...record, ...current, cardMessageId: messageId,
      cardCreatedAt: current?.cardCreatedAt || createdAt, cardDigest: digest, cardContentDigest: contentDigest,
      cardBriefContentHash: briefContentHash,
      pinPending: canPin ? false : record.pinPending }));
  }
  async function change(summary, requested, { sessionId = '', controlId = summary.eventId || summary.messageId,
    existingOnly = false, background = false, expectedEpoch, waitForCard = true } = {}) {
    const key = keyFor(summary);
    const changed = await exclusive(key, async () => {
      let prior = await state(summary);
      // Recovery can be waiting on metadata while a human changes this group.
      // Check inside the same queue as live controls, before replaying a stop.
      if (expectedEpoch !== undefined && ((prior.epoch || 0) !== expectedEpoch || !prior.stopPending)) return prior;
      if (prior.processedControls?.includes(controlId)) return prior;
      const mode = requested === 'resume_read' ? 'active' : requested;
      if (!MODES.has(mode)) throw new Error('Invalid Agent participation mode');
      let record = await records.mutate(key, current => ({ ...prior, ...current, source: sourceFor(summary), mode, modeOverride: true,
        // Reasserting active reception is a no-op for ongoing work. Advancing
        // its epoch would silently suppress otherwise valid replies.
        epoch: prior.mode === 'active' && mode === 'active' ? (prior.epoch || 0) : (prior.epoch || 0) + 1,
        // Resume changes intake/control revision, but does not revoke accepted
        // invitations. A stop advances the delivery boundary permanently, even
        // if reception resumes before the old reply reaches the outbox.
        deliveryEpochFloor: mode === 'active' ? prior.deliveryEpochFloor : (prior.epoch || 0) + 1,
        invitedMessages: [],
        stopPending: mode !== 'active', updatedAt: new Date().toISOString(),
        ...((prior.mode === 'paused' && mode !== 'paused') || (prior.mode !== 'active' && mode === 'active')
          ? { contextAfterMs: Date.now() } : {}),
      }));
      // Intake is fenced as soon as mode is durable. Acknowledgement follows
      // cancellation, not merely the card change.
      await setFeishuConversationMuted(runtime, summary, false);
      if (mode !== 'active') {
        const target = sessionId || record.sessionId || await resolveSession?.(summary);
        if (target) {
          try { await cancelSession(target, record); }
          catch (error) {
            void publish(record, { existingOnly, background }).catch(error =>
              console.warn(`[feishu-participation] pending stop card: ${error.message}`));
            throw error;
          }
        }
        await cleanup?.(record);
      }
      record = await records.mutate(key, current => ({ ...current, stopPending: false,
        processedControls: [...(current.processedControls || []), controlId].filter(Boolean).slice(-100) }));
      return record;
    });
    // Keep provider/card requests outside the control queue so slow views
    // cannot delay admission or a newer human control.
    const refresh = publish(changed, { existingOnly, background });
    if (waitForCard) return refresh;
    void refresh.catch(error => console.warn(`[feishu-participation] mode card: ${error.message}`));
    return changed;
  }
  async function assess(summary, { mentioned = false } = {}) {
    const key = keyFor(summary);
    return exclusive(key, async () => {
      let record = await state(summary);
      if (record.mode === 'active') return true;
      const forOther = summary.mentions?.length && !mentioned;
      const invited = !forOther && mentioned;
      record = await records.mutate(key, current => ({ ...current, ...record,
        ...(invited ? { invitedMessages: [...new Set([...(current?.invitedMessages || []), summary.messageId])].slice(-100) }
          : {}),
      }));
      return invited;
    });
  }
  async function intake(summary, snapshot = null) {
    if (!participationEnabled(runtime, summary) || ['app', 'bot'].includes(summary.sender?.senderType)) return null;
    const record = await state(summary);
    if (record.processedControls?.includes(summary.messageId)) {
      void publish(record).catch(error => console.warn(`[feishu-participation] mode card: ${error.message}`));
      return { participationControl: true, duplicate: true };
    }
    const others = (summary.mentions || []).some(x => x.openId && x.openId !== runtime.botIdentity?.openId);
    const addressed = mentionsFeishuBot(runtime, summary);
    const mode = !others || addressed ? parseParticipationText(summary.messageText || summary.textPreview) : null;
    if (mode) { await change(summary, mode, { waitForCard: false }); return { participationControl: true, mode }; }
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
  async function restore({ shouldContinue = () => true } = {}) {
    for (const record of await records.active()) {
      if (!shouldContinue()) return;
      try {
        const source = await resolveSource(record.source);
        if (!shouldContinue()) return;
        if (isFeishuTopicGroup(source)) {
          await publish({ ...record, source }, { existingOnly: true, background: true });
          continue;
        }
        if (!participationEnabled(runtime, source)) continue;
        if (record.stopPending) await change(source, currentMode(record.mode),
          { sessionId: record.sessionId, controlId: `restore:${record.epoch}`, existingOnly: true,
            background: true, expectedEpoch: record.epoch || 0, waitForCard: false });
        else {
          if (record.mode !== 'active') await exclusive(record.key, async () => {
            const current = await state(source);
            if (shouldContinue() && current.mode !== 'active' && (current.epoch || 0) === (record.epoch || 0)) {
              await cleanup?.(current);
            }
          });
          await publish({ ...record, source }, { existingOnly: true, background: true });
        }
      } catch (error) {
        // Mode and unfinished cleanup remain durable. A failed conversation
        // must not prevent the connector from receiving all other messages.
        console.warn(`[feishu-participation] restore failed (${record.key}): ${error.message}`);
      }
    }
  }
  return { state, remember, change, assess, intake, action, restore, publish, record: key => records.get(key),
    idle: async () => { await Promise.all([...queues.values(), ...publishQueues.values()].map(queue => queue.idle())); await records.idle(); } };
}
