import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readRecord, serialQueue, writeDurableJson } from '../../lib/durable-records.mjs';
import { shouldReplyInFeishuThread, buildFeishuApiUuid } from './index.mjs';
import { feishuResponseError } from './delivery-errors.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';
const hash = value => createHash('sha256').update(value).digest('hex');
const receiptPath = (runtime, identity) => join(runtime.config.storageDir, 'native-question-cards',
  `${hash(JSON.stringify([runtime.config.sourceRouteId || 'default', identity.sessionId, identity.runId, identity.questionId]))}.json`);
const plain = content => ({ tag: 'plain_text', content });
const markdown = content => ({ tag: 'markdown', content });
const collapsed = (title, elements) => ({ tag: 'collapsible_panel', expanded: false,
  header: { title: plain(title) }, elements });
const buttonRows = buttons => {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push({ tag: 'column_set',
    columns: buttons.slice(i, i + 2).map(button => ({ tag: 'column', width: 'weighted', weight: 1,
      elements: [button] })) });
  return rows;
};

export function buildNativeQuestionCard(identity, question) {
  const q = question.question;
  const value = { namespace: 'native-question', ...identity };
  const button = (label, extra = {}) => ({ tag: 'button', text: plain(label), type: 'default', width: 'fill',
    behaviors: [{ type: 'callback', value: { ...value, ...extra } }] });
  const options = q.options || [];
  const elements = [];
  if (question.state === 'pending') {
    elements.push(markdown(q.question));
    const descriptions = options.filter(option => option.description)
      .map(option => `${option.label}：${option.description}`);
    if (descriptions.length) elements.push(markdown(descriptions.join('\n')));
    const submit = name => ({ ...button('提交'), name, form_action_type: 'submit' });
    if (q.multiSelect && options.length) elements.push({ tag: 'form', name: 'question_choices', elements: [
      { tag: 'multi_select_static', name: 'choices', placeholder: plain('选择一项或多项'),
        options: options.map((option, i) => ({ text: plain(option.label), value: String(i + 1) })) },
      submit('submit_choices'),
    ] });
    else elements.push(...buttonRows(options.map((option, i) => button(option.label, { option: i + 1 }))));
    const customAnswer = { tag: 'form', name: 'question_answer', elements: [
      { tag: 'input', name: 'answer', input_type: 'multiline_text', max_length: 1000,
        placeholder: plain('填写自己的答案') }, submit('submit_answer'),
    ] };
    elements.push(options.length ? collapsed('填写其他答案', [customAnswer]) : customAnswer);
    elements.push(markdown(options.length ? '5 分钟未答时默认选第 1 项。' : '5 分钟未答时按未答继续。'));
  } else {
    elements.push(markdown(question.statusText));
    elements.push(collapsed('查看原问题', [markdown(q.question),
      ...options.map((option, i) => markdown(`${i + 1}. ${option.label}${option.description ? `：${option.description}` : ''}`))]));
  }
  return { schema: '2.0', config: { update_multi: true, enable_forward: false }, body: { elements } };
}

// One original message, with a durable creation fence and receipt. A state
// update without an original card never creates a late attention message.
export async function sendNativeQuestionCard(runtime, delivery) {
  const identity = { sessionId: delivery.sessionId, runId: delivery.runId, questionId: delivery.nativeQuestion.id };
  const path = receiptPath(runtime, identity);
  const prior = await readRecord(path);
  const question = delivery.nativeQuestion;
  if (!prior?.messageId && (question.state !== 'pending' || Date.now() >= question.deadline)) return { skipped: true };
  if (prior?.state && prior.state !== 'pending' && question.state === 'pending') return prior;
  const content = JSON.stringify(buildNativeQuestionCard(identity, question));
  const contentHash = hash(content);
  if (prior?.contentHash === contentHash) return prior;
  const app = runtime.appClient.im.v1.message;
  let receipt = prior;
  if (prior?.messageId) {
    const response = await app.patch({ path: { message_id: prior.messageId }, data: { content } });
    if (response?.code !== 0) throw feishuResponseError(response, 'Failed to update native question card');
  } else {
    if (prior?.creating) throw Object.assign(new Error('Question card creation outcome is unknown; inspect before retrying'), { definiteFailure: true });
    const target = delivery.target;
    await writeDurableJson(path, { ...identity, target, creating: true, state: 'pending',
      deadline: question.deadline, question: question.question });
    const data = { msg_type: 'interactive', content, uuid: buildFeishuApiUuid(delivery.id, target) };
    const response = shouldReplyInFeishuThread(target)
      ? await app.reply({ path: { message_id: target.messageId }, data: { ...data, reply_in_thread: true } })
      : await app.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: target.chatId } });
    if (response?.code !== 0 || !response.data?.message_id) {
      // A structured rejection proves there is no card to duplicate. Preserve
      // an unknown transport outcome's fence; only definite rejection clears it.
      if (Number.isInteger(response?.code) && response.code !== 0) {
        await writeDurableJson(path, { ...identity, target, creating: false, state: 'pending',
          deadline: question.deadline, question: question.question, rejectionCode: response.code });
      }
      throw feishuResponseError(response, 'Failed to send native question card');
    }
    receipt = { ...identity, target, state: 'pending', messageId: response.data.message_id,
      message_id: response.data.message_id, thread_id: response.data.thread_id || '', creating: false,
      deadline: question.deadline, question: question.question };
    await writeDurableJson(path, receipt);
  }
  const verified = await app.get({ path: { message_id: receipt.messageId } });
  const item = verified.data?.items?.find(message => message.message_id === receipt.messageId);
  if (verified.code !== 0 || !item || item.deleted || item.msg_type !== 'interactive'
      || (item.chat_id && item.chat_id !== receipt.target.chatId)) throw new Error('Native question card readback failed');
  receipt = { ...receipt, state: question.state, deadline: question.deadline, question: question.question, contentHash };
  await writeDurableJson(path, receipt);
  return receipt;
}

export async function handleNativeQuestionCardAction(runtime, raw, { request, authorize }) {
  const event = raw?.event || raw;
  let value = event.action?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (value?.namespace !== 'native-question') return null;
  const reply = (content, type = 'error') => ({ toast: { type, content } });
  const chatId = trim(event.context?.open_chat_id || event.context?.chat_id);
  const messageId = trim(event.context?.open_message_id || event.context?.message_id);
  const actor = trim(event.operator?.operator_id?.open_id || event.operator?.open_id);
  if (!chatId || !messageId || !actor || !trim(value.sessionId) || !trim(value.runId) || !trim(value.questionId)) return reply('无法识别原问题，请查看原话题。');
  try {
    const card = await readRecord(receiptPath(runtime, value));
    if (!card || card.messageId !== messageId || card.target.chatId !== chatId) return reply('这张卡片不属于原问题。');
    const tenantKey = trim(event.tenant_key || raw?.header?.tenant_key);
    const summary = { ...card.target, messageId, tenantKey,
      sender: { senderType: 'user', openId: actor,
        userId: trim(event.operator?.operator_id?.user_id), unionId: trim(event.operator?.operator_id?.union_id) } };
    if ((card.target.tenantKey && card.target.tenantKey !== tenantKey) || !await authorize(summary)) return reply('无权回答这个问题。');
    if (card.state !== 'pending' || Date.now() >= card.deadline) return reply('问题已结束，未应用这次选择；需要修改时请直接说明。');
    let text = '';
    if (Number.isInteger(value.option) && value.option >= 1 && value.option <= card.question.options.length) text = String(value.option);
    else {
      const fields = event.action?.form_value || {};
      text = trim(fields.answer);
      if (!text && card.question.multiSelect && Array.isArray(fields.choices) && fields.choices.length
          && fields.choices.every(index => /^\d+$/.test(String(index)) && Number(index) >= 1 && Number(index) <= card.question.options.length)) text = fields.choices.join(',');
    }
    if (!text) return reply('请选择选项或填写自己的答案。');
    const eventId = trim(raw?.header?.event_id || event.event_id) || hash(JSON.stringify([messageId, actor, text]));
    const result = await request(`/api/sessions/${encodeURIComponent(value.sessionId)}/messages`, { method: 'POST', body: {
      requestId: `feishu-question:${eventId}`, nativeQuestionId: value.questionId, text,
      sourceContext: { connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId || 'default',
        chatId, chatType: card.target.chatType, messageId, tenantKey, sender: summary.sender,
        eventId, ...(card.thread_id ? { threadId: card.thread_id } : {}) },
      sourceDelivery: { connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId || 'default', target: card.target },
    } });
    return result.response?.ok ? reply('回答已提交。', 'success') : reply(result.json?.error || '回答未获确认，请查看原问题。');
  } catch (error) {
    console.warn(`[feishu-native-question] ${error.message}`);
    return reply('回答未获确认，请查看原问题后重试。');
  }
}

export function withNativeQuestionCardLock(runtime, operation) {
  runtime.nativeQuestionCardQueue ||= serialQueue();
  return runtime.nativeQuestionCardQueue(operation);
}
