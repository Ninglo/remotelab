import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRecordStore, serialQueue } from '../../lib/durable-records.mjs';
import { buildFeishuTopicId } from './index.mjs';
import { getFeishuConversationSettings, setFeishuConversationMuted } from './conversation-settings.mjs';
import { recordFeishuOutboundMessageSession } from './session-flow.mjs';

const MODES = new Set(['active', 'listening', 'paused']);
const LABELS = { active: '主动参与', listening: '旁听', paused: '暂停接收' };
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function participationEnabled(runtime, summary) {
  const group = runtime.config.groups?.[summary?.chatId];
  return group?.participationMode === 'ambient' && group.participationControls === true;
}

// Fast, unambiguous controls also work while reception is paused. Broader
// contextual language is interpreted by the existing Jev call, never by a
// second classifier. Quoted examples and human-to-human messages aren't commands.
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

export function buildParticipationCard(record) {
  const scope = record.source.topicId ? '这个话题' : '本群主讨论';
  const detail = { active: '持续接收消息，自主判断是否参与。',
    listening: '持续接收消息；只回应明确邀请。', paused: '后续普通消息不进入 Session；说“恢复接收消息”唤醒。' }[record.mode];
  const actions = [...MODES].map(mode => ({ tag: 'button', type: mode === record.mode ? 'primary' : 'default',
    text: { tag: 'plain_text', content: LABELS[mode] }, value: {
      namespace: 'participation', key: record.key, mode, epoch: record.epoch || 0,
    } }));
  return { config: { wide_screen_mode: true, update_multi: true }, header: {
    template: record.mode === 'active' ? 'green' : record.mode === 'listening' ? 'blue' : 'grey',
    title: { tag: 'plain_text', content: `Agent 状态 · ${LABELS[record.mode]}` },
  }, elements: [
    { tag: 'div', text: { tag: 'lark_md', content: `**${scope} · 直到明确切换**\n${detail}` } },
    ...(record.mode === 'listening' && record.topicHint
      ? [{ tag: 'div', text: { tag: 'plain_text', content: '换了话题，要我参与吗？@我即可。' } }] : []),
    ...(record.stopPending ? [{ tag: 'div', text: { tag: 'plain_text', content: '正在停止当前任务。' } }] : []),
    { tag: 'action', actions },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '文字也能切换：“先旁听”“暂停接收消息”“恢复参与”。' }] },
  ] };
}

export function createParticipationController(runtime, { resolveSession, cancelSession, interpretControl,
  authorize = async () => false } = {}) {
  const records = createRecordStore(join(runtime.config.storageDir, 'participation-state'));
  const queues = new Map();
  const sourceFor = summary => ({ sourceRouteId: runtime.config.sourceRouteId || 'default',
    tenantKey: summary.tenantKey || summary.accountId || summary.sender?.tenantKey || '',
    chatId: summary.chatId, topicId: buildFeishuTopicId(summary),
    messageId: summary.messageId || '' });
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
    if (existing) return existing;
    const muted = (await getFeishuConversationSettings(runtime, summary)).muted;
    return { key, source: sourceFor(summary), mode: muted ? 'paused' : 'active', epoch: 0,
      invitedMessages: [], processedControls: [] };
  }
  async function remember(summary, sessionId, recent = []) {
    const key = keyFor(summary);
    const prior = await state(summary);
    return records.mutate(key, current => ({ ...prior, ...current, sessionId,
      // Preserve a semantic anchor across follow-ups; don't compare a new topic
      // against the mode command itself.
      topicAnchor: (current?.mode === 'listening' ? current.topicAnchor : '') || recent.slice(-5).map(x => x.text).join('\n').slice(-2500)
        || String(summary.messageText || summary.textPreview || '').slice(0, 1200),
    }));
  }
  async function publish(record) {
    const card = buildParticipationCard(record);
    const digest = hash(JSON.stringify(card));
    const group = runtime.config.groups[record.source.chatId];
    let messageId = record.cardMessageId || (!record.source.topicId ? group.participationStatusMessageId : '');
    const createdAt = record.cardCreatedAt || Date.now();
    if (messageId && digest === record.cardDigest && !record.pinPending
        && Date.now() - createdAt < 13 * 86400_000) return record;
    if (messageId && Date.now() - createdAt < 13 * 86400_000) {
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
      record = await records.mutate(record.key, current => ({ ...current,
        cardMessageId: messageId, cardCreatedAt: Date.now(), pinPending: !record.source.topicId }));
      // A retried idempotent create may return the card from an earlier
      // uncertain send. Bring that exact message to the current durable state.
      const updated = await runtime.appClient.im.v1.message.patch({ path: { message_id: messageId },
        data: { content: JSON.stringify(card) } });
      if (updated?.code) throw new Error(updated.msg || 'Agent status card update failed');
    }
    if (record.pinPending) {
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
    return records.mutate(record.key, current => ({ ...current, cardMessageId: messageId,
      cardCreatedAt: current.cardCreatedAt || createdAt, cardDigest: digest, pinPending: false }));
  }
  async function change(summary, requested, { sessionId = '', controlId = summary.eventId || summary.messageId } = {}) {
    const key = keyFor(summary);
    return exclusive(key, async () => {
      let prior = await state(summary);
      if (prior.processedControls?.includes(controlId)) return publish(prior);
      const mode = requested === 'resume_read' ? (prior.beforePause || 'listening') : requested;
      if (!MODES.has(mode)) throw new Error('Invalid Agent participation mode');
      let record = await records.mutate(key, current => ({ ...prior, ...current, source: sourceFor(summary), mode,
        beforePause: mode === 'paused' ? (prior.mode === 'paused' ? prior.beforePause : prior.mode) : prior.beforePause,
        epoch: (prior.epoch || 0) + 1, topicHint: false, invitedMessages: [],
        stopPending: mode !== 'active', updatedAt: new Date().toISOString(),
        ...(prior.mode === 'paused' && mode !== 'paused' ? { contextAfterMs: Date.now(), topicAnchor: '' } : {}),
      }));
      // Intake is fenced as soon as mode is durable. Acknowledgement follows
      // cancellation, not merely the card change.
      await setFeishuConversationMuted(runtime, summary, false);
      if (mode !== 'active') {
        const target = sessionId || record.sessionId || await resolveSession?.(summary);
        if (target) {
          try { await cancelSession(target); }
          catch (error) { await publish(record); throw error; }
        }
      }
      record = await records.mutate(key, current => ({ ...current, stopPending: false,
        processedControls: [...(current.processedControls || []), controlId].filter(Boolean).slice(-100) }));
      return publish(record);
    });
  }
  async function assess(summary, verdict, { mentioned = false, taskCommand = false } = {}) {
    const key = keyFor(summary);
    return exclusive(key, async () => {
      let record = await state(summary);
      if (record.mode === 'paused') return false;
      if (record.mode === 'active') return true;
      const forOther = summary.mentions?.length && !mentioned;
      const invited = !forOther && (mentioned || taskCommand || verdict?.invited === true);
      record = await records.mutate(key, current => ({ ...record, ...current,
        ...(invited ? { invitedMessages: [...(current?.invitedMessages || []), summary.messageId].slice(-100), topicHint: false }
          : verdict?.topicChanged ? { topicHint: true,
            topicAnchor: String(summary.messageText || summary.textPreview || '').slice(0, 1200) } : {}),
      }));
      await publish(record);
      return invited;
    });
  }
  async function intake(summary) {
    if (!participationEnabled(runtime, summary) || ['app', 'bot'].includes(summary.sender?.senderType)) return null;
    const record = await state(summary);
    if (record.processedControls?.includes(summary.messageId)) {
      await publish(record);
      return { participationControl: true, duplicate: true };
    }
    const others = (summary.mentions || []).some(x => x.openId && x.openId !== runtime.botIdentity?.openId);
    const addressed = (summary.mentions || []).some(x => x.openId === runtime.botIdentity?.openId);
    const mode = !others || addressed ? parseParticipationText(summary.messageText || summary.textPreview) : null;
    if (mode) { await change(summary, mode); return { participationControl: true, mode }; }
    if (record.mode === 'paused') {
      const text = String(summary.messageText || summary.textPreview || '').slice(0, 500);
      // Only an explicit attempt to restore reception may be interpreted.
      // Ordinary paused-period content is never sent to a model or Session.
      if ((!others || addressed) && (addressed || /^(?:你|请|现在|茵蒂克丝|AI|Agent)/.test(text))
          && /恢复|继续|重新|回来/.test(text) && /参与|接收|读取|旁听|读消息|听/.test(text)
          && !/别|不要|不用|不需要|[“”"`]/.test(text)) {
        const interpreted = await interpretControl?.(text, record);
        if (['active', 'listening'].includes(interpreted)) {
          await change(summary, interpreted);
          return { participationControl: true, mode: interpreted };
        }
      }
      return { ignored: true, reason: 'participation_paused' };
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
    const summary = { ...record?.source, chatId, chatType: 'group', messageId,
      ...(record?.source.topicId ? { threadId: record.source.topicId } : {}),
      sender: { senderType: 'user', openId: actor }, eventId: raw.header?.event_id || event.event_id };
    if (!record || !actor || record.source.chatId !== chatId || record.cardMessageId !== messageId
        || !MODES.has(value.mode) || value.epoch !== record.epoch || !participationEnabled(runtime, summary)
        || !await authorize(summary)) return { toast: { type: 'error', content: '状态已变化或无权操作，请看最新卡片。' } };
    void change(summary, value.mode, { controlId: summary.eventId || `button:${actor}:${record.epoch}:${value.mode}` })
      .catch(error => console.warn(`[feishu-participation] ${error.message}`));
    return { toast: { type: 'info', content: '正在切换，生效后卡片会更新。' } };
  }
  async function restore() {
    for (const record of await records.active()) {
      if (!participationEnabled(runtime, record.source)) continue;
      if (record.stopPending) await change(record.source, record.mode,
        { sessionId: record.sessionId, controlId: `restore:${record.epoch}` });
      else await publish(record);
    }
  }
  return { state, remember, change, assess, intake, action, restore, publish,
    idle: async () => { await Promise.all([...queues.values()].map(queue => queue.idle())); await records.idle(); } };
}
