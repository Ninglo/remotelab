import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildNativeQuestionCard, sendNativeQuestionCard, handleNativeQuestionCardAction } from '../connectors/feishu/native-question-cards.mjs';
import { publishLiveAssistantReplies } from '../chat/native-final-publication.mjs';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';
import { processSourceDeliveryOnce } from '../scripts/feishu-connector.mjs';

const root = await mkdtemp(join(tmpdir(), 'question-surfaces-'));
const calls = [], identity = { sessionId: 'session', runId: 'run', questionId: 'question' };
const question = { id: 'question', state: 'pending', deadline: Date.now() + 300000,
  question: { question: '输出形式？', options: [{ label: '简短' }, { label: '详细' }] } };
const delivery = { id: 'delivery', sessionId: 'session', runId: 'run', nativeQuestion: question,
  target: { chatId: 'chat', chatType: 'group', messageId: 'inbound', replyInThread: true } };
const runtime = { config: { storageDir: root, sourceRouteId: 'bot' }, appClient: { im: { v1: { message: {
  reply: async input => { calls.push(['create', input]); return { code: 0, data: { message_id: 'original', thread_id: 'thread' } }; },
  patch: async input => { calls.push(['patch', input]); return { code: 0 }; },
  get: async () => ({ code: 0, data: { items: [{ message_id: 'original', chat_id: 'chat', msg_type: 'interactive' }] } }),
} } } } };
const rawAction = (value, fields = {}) => ({ header: { event_id: 'action-one' }, event: {
  context: { open_chat_id: 'chat', open_message_id: 'original' }, operator: { operator_id: { open_id: 'actor' } },
  action: { value: { namespace: 'native-question', ...identity, ...value }, form_value: fields },
} });
try {
  await sendNativeQuestionCard(runtime, delivery);
  assert.equal(calls[0][1].data.reply_in_thread, true);
  const first = JSON.parse(calls[0][1].data.content);
  assert.equal(first.body.elements.filter(e => e.tag === 'button').length, 2);
  const requests = [];
  const actionOptions = { authorize: async () => true, request: async (url, options) => {
    requests.push([url, options]); return { response: { ok: true } };
  } };
  assert.equal((await handleNativeQuestionCardAction(runtime, rawAction({ option: 2 }), actionOptions)).toast.type, 'success');
  assert.equal(requests[0][1].body.text, '2');
  assert.equal(requests[0][1].body.nativeQuestionId, 'question');
  assert.equal(requests[0][1].body.sourceContext.sender.openId, 'actor');
  assert.deepEqual(requests[0][1].body.sourceDelivery.target, delivery.target);
  await handleNativeQuestionCardAction(runtime, rawAction({ option: 2 }), actionOptions);
  assert.deepEqual(requests[0], requests[1], 'callback retry uses identical request identity and payload');
  await handleNativeQuestionCardAction(runtime, rawAction({}, { answer: '中文\n保留例子' }), actionOptions);
  assert.equal(requests.at(-1)[1].body.text, '中文\n保留例子');
  const denied = await handleNativeQuestionCardAction(runtime, rawAction({ option: 1 }), { ...actionOptions, authorize: async () => false });
  assert.equal(denied.toast.type, 'error');
  const tampered = rawAction({ option: 1 }); tampered.event.context.open_chat_id = 'another-chat';
  assert.equal((await handleNativeQuestionCardAction(runtime, tampered, actionOptions)).toast.type, 'error');
  assert.equal(requests.length, 3, 'denied or tampered callbacks submit nothing');
  const timeout = { ...delivery, id: 'timeout', nativeQuestion: { ...question, state: 'timeout', origin: 'timeout',
    answers: ['简短'], statusText: '未收到回复，已采用系统默认「简短」。' } };
  await sendNativeQuestionCard(runtime, timeout);
  assert.deepEqual(calls.map(call => call[0]), ['create', 'patch']);
  assert.equal(calls[1][1].path.message_id, 'original');
  assert.ok(!JSON.stringify(JSON.parse(calls[1][1].data.content)).includes('behaviors'), 'ended card cannot submit answers');
  await sendNativeQuestionCard({ ...runtime }, timeout);
  await sendNativeQuestionCard(runtime, delivery);
  assert.equal(calls.length, 2, 'restart/replay cannot resend or reopen the question');
  assert.equal((await handleNativeQuestionCardAction(runtime, rawAction({ option: 1 }), actionOptions)).toast.type, 'error');
  assert.equal(requests.length, 3, 'expired buttons do not launch unrelated work');
  assert.equal((await sendNativeQuestionCard(runtime, { ...timeout, runId: 'unknown' })).skipped, true);
  assert.equal((await sendNativeQuestionCard(runtime, { ...delivery, runId: 'old', nativeQuestion: { ...question, deadline: Date.now() - 1 } })).skipped, true);
  let uncertainCreates = 0;
  const uncertainRuntime = { ...runtime, config: { ...runtime.config, storageDir: join(root, 'uncertain') },
    appClient: { im: { v1: { message: { ...runtime.appClient.im.v1.message,
      reply: async () => { uncertainCreates++; throw new Error('lost transport acknowledgement'); },
    } } } } };
  await assert.rejects(sendNativeQuestionCard(uncertainRuntime, delivery), /lost transport/);
  await assert.rejects(sendNativeQuestionCard(uncertainRuntime, delivery), /outcome is unknown/);
  assert.equal(uncertainCreates, 1, 'an unknown create cannot send another card');
  let rejectedCreates = 0;
  const rejectedRuntime = { ...runtime, config: { ...runtime.config, storageDir: join(root, 'rejected') },
    appClient: { im: { v1: { message: { ...runtime.appClient.im.v1.message,
      reply: async () => ++rejectedCreates === 1 ? { code: 99991672, msg: 'missing scope' }
        : { code: 0, data: { message_id: 'original' } },
    } } } } };
  await assert.rejects(sendNativeQuestionCard(rejectedRuntime, delivery), /missing scope/);
  await sendNativeQuestionCard(rejectedRuntime, delivery);
  assert.equal(rejectedCreates, 2, 'a definite rejection permits a corrected, explicitly retried delivery');

  const multi = buildNativeQuestionCard(identity, { ...question, question: { ...question.question, multiSelect: true } });
  assert.equal(multi.body.elements.find(e => e.tag === 'form').elements[0].tag, 'multi_select_static');

  const pending = { seq: 2, type: 'message', role: 'assistant', runId: 'run', phase: 'commentary',
    content: '输出形式？\n1. 简短\n2. 详细', messageKind: 'user_question', providerMessageId: 'question:pending',
    nativeQuestion: question.question, questionId: 'question', questionState: 'pending', questionDeadline: question.deadline };
  const ended = { ...pending, seq: 4, providerMessageId: 'question:timeout', questionState: 'timeout', answerOrigin: 'timeout',
    questionAnswers: ['简短'], content: timeout.nativeQuestion.statusText };
  const history = [{ seq: 1, type: 'message', role: 'user', content: '处理一下' }, pending,
    { seq: 3, type: 'tool_use', toolName: 'work' }, ended];
  const visible = buildSessionDisplayEvents(history, { exposeWorkboard: true });
  const questions = visible.filter(e => e.messageKind === 'user_question');
  assert.equal(questions.length, 1); assert.equal(questions[0].seq, 2);
  assert.equal(questions[0].messageUpdateSeq, 4); assert.equal(questions[0].answerOrigin, 'timeout');
  assert.equal(questions[0].content, pending.content);
  let record = { key: 'key', runId: 'run', options: {}, deliveries: [] };
  const options = { store: { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } },
    plan: { connector: 'feishu', sourceRouteId: 'bot', target: delivery.target } };
  await publishLiveAssistantReplies(record, history, options);
  assert.deepEqual(record.deliveries.map(d => d.nativeQuestion.state), ['pending', 'timeout']);
  await publishLiveAssistantReplies(record, history, options);
  assert.equal(record.deliveries.length, 2, 'recovery queues each state only once');

  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ''; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute() {}
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const submissions = [];
  const context = { document: { createElement: tag => new Element(tag) }, currentSessionId: 'session', shareSnapshotMode: false,
    createRequestId: () => 'web-answer', appendMessageTimestamp() {}, refreshCurrentSession: async () => {},
    fetchJsonOrRedirect: async (url, opts) => { submissions.push([url, JSON.parse(opts.body)]); } };
  vm.createContext(context);
  vm.runInContext(await readFile(new URL('../static/chat/native-question-ui.js', import.meta.url), 'utf8'), context);
  let panel = context.renderNativeQuestionMessage(new Element('div'), pending);
  await panel.children.filter(c => c.tag === 'button')[1].listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submissions[0][1], { requestId: 'web-answer', nativeQuestionId: 'question', text: '2' });
  assert.ok(panel.children.filter(c => c.tag === 'button').every(c => c.disabled));
  panel = context.renderNativeQuestionMessage(new Element('div'), { ...pending, nativeQuestion: { ...pending.nativeQuestion, multiSelect: true } });
  panel.children.filter(c => c.tag === 'label').forEach(c => { c.children[0].checked = true; });
  panel.children.find(c => c.tag === 'button').listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions.at(-1)[1].text, '1,2');
  panel = context.renderNativeQuestionMessage(new Element('div'), pending);
  const form = panel.children.find(c => c.tag === 'form');
  form.children[0].value = '自己的答案'; form.listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(submissions.at(-1)[1].text, '自己的答案');
  panel = context.renderNativeQuestionMessage(new Element('div'), questions[0]);
  assert.ok(panel.children.filter(c => c.tag === 'button').every(c => c.disabled));
  assert.ok(panel.children.some(c => c.textContent.includes('系统默认')));
  context.shareSnapshotMode = true;
  panel = context.renderNativeQuestionMessage(new Element('div'), pending);
  assert.ok(panel.children.filter(c => c.tag === 'button').every(c => c.disabled));
  const workerRuntime = { ...runtime, config: { ...runtime.config, storageDir: join(root, 'worker') } };
  const workerCalls = calls.length;
  let workerDelivery = delivery;
  const workerOptions = { sendFeishuText: async () => { throw new Error('Question updates must not send a text reminder'); },
    requestRemoteLab: async path => ({ response: { ok: true }, json: path === '/api/source-deliveries/claim'
      ? { claim: { leaseId: `lease-${workerDelivery.id}`, delivery: workerDelivery } }
      : { delivery: { state: 'delivered' } } }) };
  await processSourceDeliveryOnce(workerRuntime, workerOptions);
  workerDelivery = timeout;
  await processSourceDeliveryOnce(workerRuntime, workerOptions);
  assert.deepEqual(calls.slice(workerCalls).map(c => c[0]), ['create', 'patch'],
    'the actual Connector worker routes questions to one interactive card and updates it in place');
  console.log('native question surfaces: original-card updates, no timeout resend, durable replay, actor/target checks, expired controls, Web single/multiple/custom answers passed');
} finally { await rm(root, { recursive: true, force: true }); }
