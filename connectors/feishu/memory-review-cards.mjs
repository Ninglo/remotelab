import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createKeyedTaskQueue } from '../../chat/fs-utils.mjs';
import { readRecord, writeDurableJson } from '../../lib/durable-records.mjs';
import { loadAuthDocument, findIdentity } from '../../lib/auth-config.mjs';
import { inspectLearning, applyLearningUpdates, loadLearningPolicy } from '../../chat/memory-learning.mjs';
import { personalMemoryPreference } from '../../chat/personal-memory-settings.mjs';
import { appendEvent } from '../../chat/history.mjs';
import { memoryReviewKey } from '../../chat/memory-review-cards.mjs';
import { shouldReplyInFeishuThread, shouldReplyToFeishuMessage, buildFeishuApiUuid } from './index.mjs';
import { feishuResponseError } from './delivery-errors.mjs';

const plain = content => ({ tag: 'plain_text', content });
const md = content => ({ tag: 'markdown', content });
const queue = createKeyedTaskQueue();
const pathFor = (runtime, key) => join(runtime.config.storageDir, 'memory-review-cards', `${key}.json`);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildMemoryReviewCard(ref, entry, notice = '') {
  const value = { namespace: 'memory-review', key: ref.key, version: entry.version };
  const button = (label, action, submit = false) => ({ tag: 'button', text: plain(label), type: action === 'keep' ? 'primary' : 'default',
    ...(submit ? { name: 'save_memory', form_action_type: 'submit' } : {}),
    behaviors: [{ type: 'callback', value: { ...value, action } }] });
  const input = (name, label, default_value, max_length) => ({ tag: 'input', name, label: plain(label), default_value: default_value || '',
    input_type: 'multiline_text', max_length, placeholder: plain(label) });
  const closed = entry.status === 'withdrawn';
  return { schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { template: closed ? 'grey' : 'blue', title: plain('个人记忆') }, body: { elements: [
      md(notice || (closed ? '这条已不再使用。' : entry.status === 'confirmed' ? '已记住，可以继续调整。' : '我整理出一条候选记忆，请你看看是否准确。')),
      md(entry.content), ...(entry.conditions ? [md(`适用时机：${entry.conditions}`)] : []),
      ...(entry.exceptions ? [md(`例外：${entry.exceptions}`)] : []),
      md('原任务会继续。你可以现在处理，也可以稍后再看；这里的修改用于记忆，不会打断原任务。'),
      ...(!closed ? [
        { tag: 'column_set', columns: [button('保留', 'keep'), button('不记这条', 'discard')].map(b => ({ tag: 'column', width: 'weighted', weight: 1, elements: [b] })) },
        { tag: 'form', name: 'memory_edit', elements: [{ tag: 'collapsible_panel', expanded: false, header: { title: plain('修改这条记忆') }, elements: [
          input('content', '记忆内容', entry.content, 800), input('conditions', '适用时机', entry.conditions, 500),
          input('exceptions', '例外（可留空）', entry.exceptions, 500), button('保存修改', 'edit', true),
        ] }] },
      ] : []),
    ] } };
}

async function current(ref, deps, sessionId) {
  const authDocument = await (deps.loadAuthDocument || loadAuthDocument)({ persistMigration: false });
  const actor = { personId: ref.personId, identityId: ref.identityId, authDocument, ...(deps.memoryDir ? { memoryDir: deps.memoryDir } : {}) };
  const policy = await loadLearningPolicy(deps.memoryDir);
  const preference = personalMemoryPreference(actor);
  if (!policy.reviewCardPersonIds?.includes(ref.personId) || !preference.enabled || !preference.conversational) throw Object.assign(Error('个人记忆卡片已暂停。'), { code: 'MEMORY_REVIEW_PAUSED' });
  const snapshot = await inspectLearning(actor);
  const entry = snapshot.profile.entries.find(e => e.id === ref.entryId);
  if (!entry || memoryReviewKey(ref.personId, ref.entryId) !== ref.key) throw Error('找不到对应记忆。');
  if (sessionId && entry.evidence.some(e => e.sessionId !== sessionId)) throw Error('这条记忆已在其他对话更新，请在对应对话查看。');
  return { actor, entry };
}

export function sendMemoryReviewCard(runtime, delivery, deps = {}) {
  const ref = delivery.memoryReview;
  if (!/^[a-f0-9]{24}$/.test(ref?.key || '')) throw Error('Invalid memory card reference');
  return queue(pathFor(runtime, ref.key), async () => {
    const path = pathFor(runtime, ref.key);
    let record = await readRecord(path);
    let entry;
    try { ({ entry } = await current(ref, deps, delivery.sessionId)); }
    catch (error) { if (error.code === 'MEMORY_REVIEW_PAUSED') return { skipped: true }; throw error; }
    if (entry.status === 'withdrawn' && !record?.messageId) return { skipped: true };
    const app = runtime.appClient.im.v1.message;
    const content = JSON.stringify(buildMemoryReviewCard(ref, entry));
    if (record?.messageId) {
      const response = await app.patch({ path: { message_id: record.messageId }, data: { content } });
      if (response?.code !== 0) throw feishuResponseError(response, 'Memory card update failed');
    } else {
      if (record?.creating) throw Object.assign(Error('Memory card send outcome unknown; inspect before retrying'), { definiteFailure: true });
      record = { ref, sessionId: delivery.sessionId, target: delivery.target, creating: true };
      await writeDurableJson(path, record);
      const data = { msg_type: 'interactive', content, uuid: buildFeishuApiUuid(delivery.id, delivery.target) };
      const response = shouldReplyToFeishuMessage(delivery.target)
        ? await app.reply({ path: { message_id: delivery.target.messageId }, data: { ...data, reply_in_thread: shouldReplyInFeishuThread(delivery.target) } })
        : await app.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: delivery.target.chatId } });
      if (response?.code !== 0 || !response.data?.message_id) {
        if (Number.isInteger(response?.code) && response.code !== 0) await writeDurableJson(path, { ...record, creating: false });
        throw feishuResponseError(response, 'Memory card send failed');
      }
      record = { ...record, creating: false, messageId: response.data.message_id, message_id: response.data.message_id, thread_id: response.data.thread_id || '' };
      await writeDurableJson(path, record);
    }
    const verified = await app.get({ path: { message_id: record.messageId } });
    const item = verified.data?.items?.find(m => m.message_id === record.messageId);
    if (verified.code !== 0 || !item || item.deleted || item.msg_type !== 'interactive' || item.chat_id !== record.target.chatId) throw Error('Memory card readback failed');
    return record;
  });
}

export async function handleMemoryReviewCardAction(runtime, raw, { authorize, ...deps } = {}) {
  const event = raw?.event || raw;
  let value = event?.action?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (value?.namespace !== 'memory-review') return null;
  const toast = (type, content, card) => ({ toast: { type, content }, ...(card ? { card: { type: 'raw', data: card } } : {}) });
  if (!/^[a-f0-9]{24}$/.test(value.key || '')) return toast('error', '记忆卡片无效。');
  return queue(pathFor(runtime, value.key), async () => {
    let record, entry, actor;
    try {
      const path = pathFor(runtime, value.key);
      record = await readRecord(path);
      if (!record || record.creating || event.context?.open_message_id !== record.messageId || event.context?.open_chat_id !== record.target.chatId) throw Error('卡片来源不匹配。');
      ({ actor, entry } = await current(record.ref, deps, record.sessionId));
      const owner = findIdentity(actor.authDocument, actor.identityId)?.identity;
      const openId = event.operator?.open_id || event.operator?.operator_id?.open_id;
      const tenant = event.operator?.tenant_key || raw.header?.tenant_key || event.tenant_key;
      const summary = { ...record.target, tenantKey: tenant, sender: { openId, tenantKey: tenant, senderType: 'user' } };
      if (!owner || owner.kind !== 'feishu' || owner.realm !== runtime.config.sourceRouteId || owner.subjectId !== openId
        || tenant !== record.target.tenantKey || !await authorize?.(summary)) throw Error('请由这条记忆的本人操作。');
      if (!['keep', 'edit', 'discard'].includes(value.action)) throw Error('未知的记忆操作。');
      const form = event.action?.form_value || {};
      const content = value.action === 'edit' ? String(form.content || '').trim() : entry.content;
      const conditions = value.action === 'edit' ? String(form.conditions || '').trim() : entry.conditions;
      const exceptions = value.action === 'edit' ? String(form.exceptions || '').trim() : entry.exceptions;
      if (!content || content.length > 800 || conditions?.length > 500 || exceptions?.length > 500) throw Error('请填写记忆内容，并保持在输入框长度限制内。');
      const signature = hash([value.version, value.action, openId, value.action === 'edit' ? form : null]);
      if (record.applied === signature) return toast('success', '已处理', buildMemoryReviewCard(record.ref, entry));
      // Recover a write that succeeded before its callback receipt was committed.
      if (record.pending?.signature === signature && entry.evidence.some(e => e.sessionId === record.sessionId && e.seq === record.pending.seq)) {
        await writeDurableJson(path, { ...record, applied: signature, pending: null });
        return toast('success', '已处理', buildMemoryReviewCard(record.ref, entry));
      }
      if (entry.version !== value.version || entry.status === 'withdrawn') throw Error('记忆已经更新，请查看刷新后的内容再操作。');
      const verb = value.action === 'discard' ? '不记这条' : value.action === 'edit' ? '保存修改' : '保留';
      const statement = `${verb}：${content}\n适用时机：${conditions || ''}\n例外：${exceptions || ''}`;
      if (!record.pending || record.pending.signature !== signature) {
        const evidence = await (deps.appendEvent || appendEvent)(record.sessionId, { type: 'memory_review_action', content: statement,
          personId: actor.personId, identityId: actor.identityId, memoryId: entry.id, memoryVersion: entry.version,
          cardMessageId: record.messageId, providerEventId: raw.header?.event_id || '', action: value.action });
        record = { ...record, pending: { signature, seq: evidence.seq, statement } };
        await writeDurableJson(path, record);
      }
      const seq = record.pending.seq;
      const result = await applyLearningUpdates({ ...actor, sources: [{ sessionId: record.sessionId, runId: `memory_review_${value.key}`, seq, type: 'user', output: record.pending.statement }],
        updates: [{ key: entry.key, kind: 'preference', action: value.action === 'discard' ? 'withdraw' : 'revise', explicit: true,
          expectedVersion: value.version, content, conditions, exceptions, cues: entry.cues, reason: `本人在记忆卡片选择${verb}`,
          evidence: [{ seq, quote: record.pending.statement.slice(0, 500) }] }] });
      if (!result.promotedCount) throw Error(result.rejected?.[0]?.reason || '记忆未保存。');
      await writeDurableJson(path, { ...record, applied: signature, pending: null });
      ({ entry } = await current(record.ref, deps, record.sessionId));
      return toast('success', verb === '不记这条' ? '已不再使用这条记忆' : '已保存', buildMemoryReviewCard(record.ref, entry));
    } catch (error) {
      // Never reveal the memory in a rejected foreign-owner callback.
      return toast('error', error.message, actor && entry && error.message.startsWith('记忆已经更新') ? buildMemoryReviewCard(record.ref, entry) : undefined);
    }
  });
}
